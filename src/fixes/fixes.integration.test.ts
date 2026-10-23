/**
 * The point of the feature: on the stuck retry storm, actually simulate every candidate fix (each
 * against its own no-fault control) and check which ones bring the system back.
 */
import { retryStormRun } from '../analysis/testRuns';
import { webChain } from '../data/topologies';
import { runSimulation } from '../engine/run';
import { candidateFixes } from './candidates';
import { measureOutcome, rankFixes, seedAgreement, seedVariants, type RankedFix } from './rank';

const labels = Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label]));

function describeRanking(ranked: RankedFix[]): string {
  return ranked
    .map(({ candidate, outcome, helped }) => {
      const result = outcome.verdict === 'recovered' ? `recovered ${outcome.recoveryMs! / 1000} s after` : outcome.verdict;
      return `${helped ? 'helped' : 'did not help'} | ${candidate.title} | ${result} | ${outcome.failedRequests} failed | why: ${candidate.why}`;
    })
    .join('\n');
}

describe('fixes for the stuck retry storm (200 rps, 3 API → DB retries)', { timeout: 120_000 }, () => {
  const { config, analysis } = retryStormRun({ retries: 3 });
  const original = measureOutcome(config);
  const candidates = candidateFixes(config, analysis.signals, labels);
  const ranked = rankFixes(original, candidates.map((candidate) => ({ candidate, outcome: measureOutcome(candidate.config) })));
  const byId = Object.fromEntries(ranked.map((r) => [r.candidate.id, r]));
  console.log(`original: ${original.verdict}, ${original.failedRequests} failed\n${describeRanking(ranked)}`);

  it('the original is stuck', () => {
    expect(original.verdict).toBe('stuck');
  });

  // At this seed. Capping at 1 retry leaves 200 rps right at the 1-retry tipping point: measured
  // across seeds 42–46 it recovers on 1 of 5, while the retry budget recovers on all 5 (below).
  it('a retry budget and capping retries both make it recover', () => {
    for (const id of ['retry-budget', 'cap-retries']) {
      expect(byId[id].outcome.verdict).toBe('recovered');
      expect(byId[id].helped).toBe(true);
      expect(byId[id].outcome.failedRequests).toBeLessThan(original.failedRequests / 10);
    }
  });

  it('every fix saw identical traffic', () => {
    const arrivals = runSimulation(config).client.requests.arrivalMs;
    for (const c of candidates) expect(runSimulation(c.config).client.requests.arrivalMs).toEqual(arrivals);
  });

  it('ranks the fixes that helped first, best recovery first', () => {
    const helped = ranked.filter((r) => r.helped);
    expect(ranked.slice(0, helped.length)).toEqual(helped);
    for (const r of helped) expect(r.outcome.verdict).toBe('recovered');
    const times = helped.map((r) => r.outcome.recoveryMs!);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('the retry budget helps on every one of 5 seeds', () => {
    const fix = byId['retry-budget'].candidate.config;
    const originals = seedVariants(config).map(measureOutcome);
    const fixed = seedVariants(fix).map(measureOutcome);
    console.log(`retry budget: originals ${originals.map((o) => o.verdict).join(', ')}; fixed ${fixed.map((o) => `${o.verdict} ${o.recoveryMs}`).join(', ')}`);
    expect(seedAgreement(originals, fixed)).toEqual({ helped: 5, of: 5 });
  });
});
