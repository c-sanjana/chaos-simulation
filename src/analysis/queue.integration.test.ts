import { chainGraph } from '../builder/testGraphs';
import { buildRunConfig } from '../data/buildConfig';
import type { ScenarioPreset } from '../data/types';
import { runSimulation } from '../engine/run';
import { candidateFixes } from '../fixes/candidates';
import { customSystem } from '../ui/system';
import { analyzeRun } from './analyze';
import { controlConfig } from './recovery';
import { buildStory } from './story';
import { findScenario } from '../builder/scenarios';

/** Client → Load balancer → Queue → Server → Database, as drawn on the canvas, with defaults. */
const system = customSystem(chainGraph(['client', 'loadBalancer', 'queue', 'server', 'database']));
if (system.kind !== 'custom') throw new Error('expected a built system');
const labels = Object.fromEntries(Object.entries(system.topology.layout).map(([id, l]) => [id, l.label]));
const scenario = (id: string) => findScenario(system.scenarios, id)!;
const analyse = (s: ScenarioPreset, rps: number) => {
  const config = buildRunConfig(system.topology, s, { rps });
  const run = runSimulation(config);
  const analysis = analyzeRun(run, runSimulation(controlConfig(config)), config, labels);
  return { config, run, analysis, story: buildStory(run, config, analysis, labels), fixes: candidateFixes(config, analysis.signals, labels) };
};

describe('a built topology with a message queue', { timeout: 120_000 }, () => {
  it('a database slowdown: messages pile up while users see nothing, then the backlog drains', () => {
    const { analysis, story, fixes } = analyse(scenario('custom-db-slow'), 100);
    expect(analysis.recovery).toMatchObject({ verdict: 'recovered', failedRequests: 0 });
    const backlog = analysis.signals.queueBacklog!;
    expect(backlog.tier).toBe('n2');
    expect(backlog.value.peak).toBeGreaterThan(300); // measured 435
    expect(backlog.value.consumersBusy).toBe(1);
    expect(backlog.value.atEnd).toBe(0);
    expect(analysis.timeline.map((e) => e.text)).toContainEqual(expect.stringMatching(/^Messages pile up in queue 2: up to \d+ waiting, some delivered \d+ s late$/));
    const step = story.find((s) => s.kind === 'backlog')!;
    expect(step).toMatchObject({ tMs: 30_000, tone: 'bad', headline: 'Queue 2 backing up', figure: expect.stringMatching(/^\d+ waiting$/) });
    expect(step.text).toMatch(/^Messages piled up in the queue 2: up to \d+ waiting\. The people sending them didn't notice: it answers as soon as it stores a message\.$/);
    expect(fixes.map((f) => f.id)).toContain('more-consumers');
    const more = fixes.find((f) => f.id === 'more-consumers')!;
    expect(more.title).toBe('Twice as many consumers: queue 2, 16 → 32 consumers');
    expect(more.why).toBe(`up to ${Math.round(backlog.value.peak)} messages waited in queue 2, with every consumer busy`);
    expect(more.config.tiers.find((t) => t.id === 'n2')!.queue!.consumers).toBe(32);
  });

  it('work behind the queue slowed: still catching up at the end counts as not recovered, though no user failed', () => {
    const { analysis, story } = analyse(scenario('custom-queue-backlog'), 140);
    expect(analysis.recovery).toMatchObject({ verdict: 'stuck', failedRequests: 0 });
    expect(analysis.timeline.at(-1)!.text).toMatch(/^Still stuck: [\d,]+ messages still waiting in queue 2$/);
    expect(story.at(-1)).toMatchObject({ kind: 'stuck', headline: 'Never caught up', text: expect.stringMatching(/^It never caught up: [\d,]+ messages were still waiting in the queue 2 at the end of the run\.$/) });
    // At lower traffic the same slowdown drains in time.
    expect(analyse(scenario('custom-queue-backlog'), 100).analysis.recovery.verdict).toBe('recovered');
  });

  it('more traffic than the work behind the queue can do: overloaded, though every sender is answered', () => {
    const { analysis, story } = analyse(scenario('custom-queue-backlog'), 220);
    expect(analysis.recovery).toMatchObject({ verdict: 'overloaded', failedRequests: 0 });
    expect(story.find((s) => s.headline === 'Too much traffic anyway')!.text).toBe('Even without the failure, this much traffic is more than the system can handle: work piles up in the queue 2 faster than it gets done.');
  });

  it('callers in front of the queue never saw a slowdown behind it, so the story does not say they asked again', () => {
    const { story } = analyse(scenario('custom-db-slow'), 100);
    const giveup = story.find((s) => s.kind === 'giveup')!;
    expect(giveup.text).not.toMatch(/users' apps|load balancer/);
    expect((giveup.cascade ?? []).map((c) => c.who)).not.toContain("users' apps");
    expect(giveup.headline).not.toMatch(/everyone/);
  });

  it('a slowdown in front of the queue: users do ask again, and the pile left is of messages', () => {
    const { story, analysis } = analyse(scenario('custom-front-slow'), 100);
    expect(story.find((s) => s.kind === 'giveup')!.text).toMatch(/^Users' apps give up/);
    const back = story.find((s) => s.kind === 'back')!;
    if (analysis.recovery.verdict === 'stuck') expect(back.text).toMatch(/the pile of messages in the queue 2 was still there\.$/);
  });

  it('a dropped message is told once, in the singular', () => {
    const { analysis, story } = analyse(scenario('custom-db-slow'), 140);
    expect(analysis.signals.queueBacklog!.value.deadLettered).toBe(1); // measured
    expect(analysis.timeline.map((e) => e.text)).toContain('queue 2 drops 1 message that still failed after retries (dead-lettered)');
    expect(story.find((s) => s.kind === 'backlog')!.text).toMatch(/ One message kept failing and was dropped\.$/);
  });
});
