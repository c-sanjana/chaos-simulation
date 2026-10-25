import { chainGraph } from '../builder/testGraphs';
import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import { FIX_CATALOG } from '../fixes/catalog';
import { applyFix } from '../fixes/candidates';
import { fixHelped, measureOutcome } from '../fixes/rank';
import { customSystem } from '../ui/system';
import { analyzeRun } from './analyze';
import { MAX_SETTLE_MS, moreTimeNeeded, simulateUntilSettled } from './settle';
import { buildStory } from './story';
import { findScenario } from '../builder/scenarios';

/** Client → App server → Queue → Database, as drawn on the canvas with defaults. */
const system = customSystem(chainGraph(['client', 'server', 'queue', 'database']));
if (system.kind !== 'custom') throw new Error('expected a built system');
const scenario = (id: string) => findScenario(system.scenarios, id)!;
const labels = Object.fromEntries(Object.entries(system.topology.layout).map(([id, l]) => [id, l.label]));

describe('simulateUntilSettled', { timeout: 120_000 }, () => {
  it('leaves the presets alone: their stuck runs are stuck for good, not draining', () => {
    const s = simulateUntilSettled(buildRunConfig(webChain, retryStorm));
    expect(s.config.durationMs).toBe(120_000);
    expect(s.recovery).toMatchObject({ verdict: 'stuck' });
    expect(s.recovery.catchingUpMs).toBeUndefined();
  });

  it('runs on while a queue backlog drains, and judges it recovered once it does', () => {
    const config = buildRunConfig(system.topology, scenario('custom-front-slow'), { rps: 100 });
    const s = simulateUntilSettled(config);
    expect(s.config.durationMs).toBeGreaterThan(120_000); // at 120 s it was still draining: "stuck" before
    expect(s.config.durationMs).toBeLessThanOrEqual(MAX_SETTLE_MS);
    expect(s.recovery.verdict).toBe('recovered');
    expect(s.run.durationMs).toBe(s.config.durationMs);
    // Exact: the first 120 s of the longer run are the 120 s run.
    const short = simulateUntilSettled({ ...config, durationMs: 120_000, faults: config.faults }).run;
    expect(s.run.client.sent.slice(0, 100)).toEqual(short.client.sent.slice(0, 100));
  });

  it('a drain too slow for the longest run is still stuck, with an estimate of how much longer it needs', () => {
    const config = buildRunConfig(system.topology, scenario('custom-front-slow'), { rps: 140 });
    const s = simulateUntilSettled(config);
    expect(s.config.durationMs).toBe(MAX_SETTLE_MS);
    expect(s.recovery.verdict).toBe('stuck');
    // Measured: fully drained at ~430 s, so roughly 190 s after the 240 s run ends.
    expect(s.recovery.catchingUpMs!).toBeGreaterThan(100_000);
    expect(s.recovery.catchingUpMs!).toBeLessThan(300_000);
    const analysis = analyzeRun(s.run, s.control, s.config, labels, s.recovery);
    expect(buildStory(s.run, s.config, analysis, labels).at(-1)).toMatchObject({ headline: 'Still catching up', text: expect.stringMatching(/^It was still catching up when the run ended: working through the backlog steadily, about \d+ s more to go\.$/) });
    expect(analysis.timeline.at(-1)!.text).toMatch(/^Still catching up when the run ended/);
  });

  it('a failure ending too close to the end of the run gets time to show whether it recovers', () => {
    const late = { ...buildRunConfig(webChain, retryStorm, { rps: 60 }), faults: [{ tier: 'db', kind: 'slow' as const, factor: 8, startMs: 90_000, endMs: 100_000 }] };
    const s = simulateUntilSettled(late);
    expect(s.config.durationMs).toBeGreaterThan(120_000);
    expect(s.recovery.judgedUntilMs).toBeGreaterThan(100_000 + 20_000);
    expect(s.recovery.verdict).not.toBe('stuck'); // was "the failure was still going on when the run ended"
    // A failure meant to last to the end of the run is not extended.
    const toEnd = { ...late, faults: [{ ...late.faults[0], endMs: 120_000 }] };
    expect(simulateUntilSettled(toEnd).config.durationMs).toBe(120_000);
  });

  it('a fix is not credited for an effect it did not have (review 2: it only moved the judging window)', () => {
    const config = buildRunConfig(system.topology, scenario('custom-queue-backlog'), { rps: 120 });
    const original = simulateUntilSettled(config);
    const oneLayer = applyFix(FIX_CATALOG.find((d) => d.kind === 'retryOneLayer')!, config, analyzeRun(original.run, original.control, original.config).signals);
    if (oneLayer === null) return; // nothing to try: nothing to credit either
    expect(fixHelped(measureOutcome(config), measureOutcome(oneLayer))).toBe(false);
  });

  it('only a stuck verdict can need more time', () => {
    const s = simulateUntilSettled(buildRunConfig(system.topology, scenario('custom-db-slow'), { rps: 100 }));
    expect(s.recovery.verdict).toBe('recovered');
    expect(moreTimeNeeded(s.run, s.control, s.config, s.recovery)).toBeNull();
  });
});
