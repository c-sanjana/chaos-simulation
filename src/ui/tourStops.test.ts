import { analyzeRun } from '../analysis/analyze';
import { controlConfig } from '../analysis/recovery';
import { buildStory } from '../analysis/story';
import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import { runSimulation } from '../engine/run';
import { FIX_CATALOG } from '../fixes/catalog';
import { applyFix } from '../fixes/candidates';
import { measureOutcome, seedVariants, withLongerOutage } from '../fixes/rank';
import { tourStops } from './tourStops';
import { labelsOf } from './viewModels';

/** The tour tells the default retry storm with fixed words; these check the words against the run. */
describe('the demo tour matches the default retry storm', { timeout: 120_000 }, () => {
  const config = buildRunConfig(webChain, retryStorm);
  const labels = labelsOf(webChain);
  const run = runSimulation(config);
  const analysis = analyzeRun(run, runSimulation(controlConfig(config)), config, labels);
  const story = buildStory(run, config, analysis, labels);
  const at = (title: string) => tourStops.find((s) => s.title === title)!.atMs!;
  const step = (kind: string) => story.find((s) => s.kind === kind)!;

  it('the setup: 200 requests a second; at 30 s the database slows down 8× for 5 seconds; the app server waits 1 s', () => {
    expect(config.client.rps).toBe(200);
    expect(config.faults).toEqual([{ tier: 'db', kind: 'slow', factor: 8, startMs: 30_000, endMs: 35_000 }]);
    expect(config.tiers.find((t) => t.id === 'api')!.downstream).toMatchObject({ target: 'db', timeoutMs: 1000 });
    expect(config.client.call.retries).toBeGreaterThan(0); // users' apps ask again too
    expect(config.tiers.find((t) => t.id === 'lb')!.downstream!.retries).toBeGreaterThan(0);
  });

  it('each moment shows what its stop says', () => {
    expect(at('Normal traffic')).toBeLessThan(step('fault').tMs);
    expect(step('giveup').tMs).toBeLessThanOrEqual(at('The database slows down')); // gave up and retried
    expect(step('overload').tMs).toBeLessThanOrEqual(at('Repeats pile up')); // past what the database can handle
    expect(step('back').tMs).toBe(35_000);
    expect(step('back').tMs).toBeLessThanOrEqual(at('The failure is over…'));
    expect(step('back').figure).toBe('pile remains');
    expect(analysis.recovery.verdict).toBe('stuck');
    expect(step('stuck').tMs).toBeLessThanOrEqual(at('…but it never recovers'));
    expect(at('…but it never recovers')).toBeLessThanOrEqual(run.durationMs);
  });

  it('at "The database slows down", the app server, the load balancer and users’ apps have all started asking again', () => {
    const s = Math.floor(at('The database slows down') / run.bucketMs);
    // Repeats arriving at a tier come from its caller: the app server's at the DB, the load balancer's at
    // the app server, users' apps' at the load balancer.
    expect(run.tiers.db.arrivalsRetry[s]).toBeGreaterThan(0);
    expect(run.tiers.api.arrivalsRetry[s]).toBeGreaterThan(0);
    expect(run.tiers.lb.arrivalsRetry[s]).toBeGreaterThan(0);
    // Users' first repeats arrive at 33 s, after the app server's and the load balancer's.
    expect(run.tiers.lb.arrivalsRetry.findIndex((n) => n > 0)).toBe(33);
    expect(run.tiers.lb.arrivalsRetry.findIndex((n) => n > 0)).toBeGreaterThan(run.tiers.api.arrivalsRetry.findIndex((n) => n > 0));
  });

  it('names what is on screen instead of colours, waits for results, and points at the ? button', () => {
    for (const s of tourStops) {
      expect(s.body).not.toMatch(/\b(orange|red|blue|green|grey|gray|purple|yellow)\b/i);
      expect(s.body).not.toMatch(/Press \?/);
    }
    expect(tourStops.at(-1)!.body).toMatch(/Use the \? button/);
    expect(tourStops.at(-1)!.body).toMatch(/Glossary explains terms/); // the top bar's button, by its name
    // Every stop on steps 2 and 3 that describes results waits for them.
    for (const s of tourStops.filter((x) => x.screen > 0 && x.target !== 'help')) expect(s.waitForResults).toBe(true);
    expect(tourStops.find((s) => s.target === 'map')!.body).toMatch(/A bar marks the tipping point, where runs start getting stuck/);
    // The fix it names is the tab's own name.
    expect(tourStops.find((s) => s.target === 'fix-tabs')!.body).toContain(`Here, ${FIX_CATALOG.find((d) => d.kind === 'boundQueue')!.short} holds up.`);
  });

  it("most of the database's work is for requests nobody is waiting for", () => {
    expect(analysis.signals.wastedShare).toMatchObject({ tier: 'db' });
    expect(analysis.signals.wastedShare!.value).toBeGreaterThan(0.5);
  });

  it('Bound queue holds up: it recovers on 5 random runs and with a slowdown twice as long', () => {
    const fixed = applyFix(FIX_CATALOG.find((d) => d.kind === 'boundQueue')!, config, analysis.signals)!;
    expect(measureOutcome(fixed).verdict).toBe('recovered');
    for (const seeded of seedVariants(fixed)) expect(measureOutcome(seeded).verdict).toBe('recovered');
    expect(measureOutcome(withLongerOutage(fixed)!).verdict).toBe('recovered');
  });
});
