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

  // The DB has 64 connections on 4 cores, so most expired requests are found waiting for a core,
  // not in the queue. Dropping them there (the deadline is re-checked when compute starts, PLAN.md
  // Q5) is what lets this fix work.
  it('dropping expired requests makes it recover', () => {
    const fix = byId['drop-expired'];
    expect(fix.outcome.verdict).toBe('recovered');
    expect(fix.helped).toBe(true);
    expect(fix.outcome.failedRequests).toBeLessThan(original.failedRequests / 10);
    expect(runSimulation(fix.candidate.config).tiers.db.totals.dropped).toBeGreaterThan(0);
  });

  it('exactly these fixes help at this seed', () => {
    const helped = ranked.filter((r) => r.helped).map((r) => r.candidate.id);
    expect(new Set(helped)).toEqual(new Set(['bound-queue', 'longer-timeout', 'retry-budget', 'drop-expired', 'cap-retries']));
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

  // Seeds 42–46. Capping retries is the only fix that depends on the seed (see above).
  it('helps on the expected number of 5 seeds, for every fix', () => {
    const expected: Record<string, number> = {
      'bound-queue': 5,
      'longer-timeout': 5,
      'retry-budget': 5,
      'drop-expired': 5,
      'cap-retries': 1,
      'jitter-backoff': 0,
      'coalesce-misses': 0,
      'add-instances': 0,
    };
    const originals = seedVariants(config).map(measureOutcome);
    expect(originals.every((o) => o.verdict === 'stuck')).toBe(true);
    const agreement = Object.fromEntries(
      ranked.map(({ candidate }) => [candidate.id, seedAgreement(originals, seedVariants(candidate.config).map(measureOutcome)).helped]),
    );
    console.log(`helped on (of 5 seeds): ${JSON.stringify(agreement)}`);
    expect(agreement).toEqual(expected);
  });
});
