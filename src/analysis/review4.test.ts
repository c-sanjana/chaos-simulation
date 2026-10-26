/**
 * Accuracy fixes from code review 4 (REVIEW4.md), each checked on the example system.
 */
import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import { ownHitRate } from './helpers';
import { simulateUntilSettled } from './settle';
import { buildStory } from './story';
import { analyzed } from './testRuns';

const labels = Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label]));
const dbDown = (rps: number, lengthMs: number) => ({ ...buildRunConfig(webChain, retryStorm, { rps }), faults: [{ tier: 'db', kind: 'dead' as const, startMs: 30_000, endMs: 30_000 + lengthMs }] });

describe('review 4 accuracy', () => {
  it('the timeline never quotes a dead part\'s refused requests as load it took on', () => {
    // The database serves (almost) nothing while it is down: arrivals it refuses at once are no work.
    const { analysis } = analyzed(dbDown(100, 2_000));
    const overload = analysis.timeline.find((e) => e.text.startsWith('Retries push'));
    expect(overload === undefined || overload.tMs >= 32_000).toBe(true);
  });

  it('a cache\'s hit rate is judged on users\' own lookups: retries looking up the keys that missed do not "empty" it', () => {
    const config = dbDown(120, 5_000);
    const { run, analysis } = analyzed(config);
    const cache = run.tiers.cache;
    // Retries did look the cache up during the outage, and some of those were hits.
    expect(cache.arrivalsFromRepeats.slice(30, 35).reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
    // On users' own lookups the cache kept answering as before.
    expect(ownHitRate(cache, 30, 35)).toBeGreaterThan(ownHitRate(cache, 10, 30) / 2);
    const story = buildStory(run, config, analysis, labels);
    expect(story.some((s) => /Cache entries ran out/.test(s.text) && s.tMs < 35_000)).toBe(false);
    expect(analysis.timeline.some((e) => /hit rate falls/.test(e.text) && e.tMs < 35_000)).toBe(false);
  });

  it('when the client waits forever, requests merely in flight at the end are not failures', () => {
    // A 1% slowdown for 1 s: nothing to see. Before, the control's in-flight requests at the end
    // counted as failures, so the run read "overloaded" (too much traffic even without the failure).
    const base = buildRunConfig(webChain, retryStorm);
    for (const seed of [1, 2, 3]) {
      const config = { ...base, seed, client: { ...base.client, call: { ...base.client.call, timeoutMs: null } }, faults: [{ tier: 'db', kind: 'slow' as const, factor: 1.01, startMs: 30_000, endMs: 31_000 }] };
      expect(analyzed(config).analysis.recovery.verdict).not.toBe('overloaded');
    }
  });

  it('one copy of a part going down reads "1 of 4 App server copies" in the headlines', () => {
    const config = { ...buildRunConfig(webChain, retryStorm), faults: [{ tier: 'api', instance: 0, kind: 'dead' as const, startMs: 30_000, endMs: 35_000 }] };
    const { run, analysis } = analyzed(config);
    const headlines = buildStory(run, config, analysis, labels).map((s) => s.headline);
    expect(headlines).toContain('1 of 4 App server copies down');
    expect(headlines).toContain('1 of 4 App server copies back up');
  });

  it('a failure ending just before the judged range gets a longer run instead of a "stuck" with nothing failed', () => {
    // 60 s run at 60 req/s: an 8.5 s failure ends at 38.5 s, 0.4 s before the judged range ended.
    const config = buildRunConfig(webChain, { ...retryStorm, durationMs: 60_000 }, { rps: 60, outageMs: 8_500 });
    const { config: ran, recovery } = simulateUntilSettled(config);
    expect(ran.durationMs).toBeGreaterThan(60_000);
    expect(recovery.verdict === 'stuck' && recovery.failedRequests === 0).toBe(false);
  });

  it('settling never lengthens a run past the caller\'s run-size limit', () => {
    const config = buildRunConfig(webChain, { ...retryStorm, durationMs: 60_000 }, { rps: 60, outageMs: 8_500 });
    expect(simulateUntilSettled(config, undefined, () => false).config.durationMs).toBe(60_000);
  });
});
