/**
 * The point of the feature: on the stuck retry storm, actually simulate every candidate fix (each
 * against its own no-fault control) and check which ones bring the system back.
 */
import { retryStormRun } from '../analysis/testRuns';
import { webChain } from '../data/topologies';
import { runSimulation } from '../engine/run';
import { candidateFixes } from './candidates';
import { fixHelped, isReliable, measureOutcome, rankFixes, seedAgreement, seedVariants, withLongerOutage, type RankedFix, type Robustness, type SeedAgreement } from './rank';

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

  // Seeds 42–46, measured once and shared by the tests below.
  let originals: ReturnType<typeof measureOutcome>[] | undefined;
  const seedOriginals = () => (originals ??= seedVariants(config).map(measureOutcome));
  const seeds = new Map<string, SeedAgreement>();
  const seedsFor = (id: string): SeedAgreement => {
    if (!seeds.has(id)) seeds.set(id, seedAgreement(seedOriginals(), seedVariants(byId[id].candidate.config).map(measureOutcome)));
    return seeds.get(id)!;
  };

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

  // Recovery times within 1 s of each other are a tie, broken by fewer failed requests: bound-queue
  // (2 s, 242 failed), longer-timeout (3 s, 147) and retry-budget (3 s, 306) tie.
  it('ranks the fixes that helped first; recovery times within 1 s tie, and fewer failures win the tie', () => {
    const helped = ranked.filter((r) => r.helped);
    expect(ranked.slice(0, helped.length)).toEqual(helped);
    for (const r of helped) expect(r.outcome.verdict).toBe('recovered');
    expect(ranked.map((r) => r.candidate.id)).toEqual(['longer-timeout', 'bound-queue', 'retry-budget', 'drop-expired', 'cap-retries', 'jitter-backoff', 'coalesce-misses', 'add-instances']);
    expect(Math.max(...helped.slice(0, 3).map((r) => r.outcome.recoveryMs!)) - Math.min(...helped.slice(0, 3).map((r) => r.outcome.recoveryMs!))).toBeLessThanOrEqual(1000);
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
    expect(seedOriginals().every((o) => o.verdict === 'stuck')).toBe(true);
    const agreement = Object.fromEntries(ranked.map(({ candidate }) => [candidate.id, seedsFor(candidate.id).helped]));
    console.log(`helped on (of 5 seeds): ${JSON.stringify(agreement)}`);
    expect(agreement).toEqual(expected);
  });

  // The review's finding: a 3 s timeout outlasts a 5 s slowdown's effect, but not a 10 s one.
  it('with the slowdown twice as long (10 s), the longer timeout and capping retries stop helping', () => {
    const longerOriginal = measureOutcome(withLongerOutage(config)!);
    expect(longerOriginal.verdict).toBe('stuck');
    const longer = Object.fromEntries(
      ranked.filter((r) => r.helped).map(({ candidate }) => [candidate.id, fixHelped(longerOriginal, measureOutcome(withLongerOutage(candidate.config)!))]),
    );
    console.log(`still helps with a 10 s slowdown: ${JSON.stringify(longer)}`);
    // Capping retries is borderline even at 5 s (it helps on 1 of 5 seeds, above).
    expect(longer).toEqual({ 'longer-timeout': false, 'bound-queue': true, 'retry-budget': true, 'drop-expired': true, 'cap-retries': false });

    // Ranked with both checks: reliable fixes that helped first, then the unreliable ones.
    const robustness: Record<string, Robustness> = Object.fromEntries(Object.keys(longer).map((id) => [id, { seeds: seedsFor(id), longer: longer[id] }]));
    const withChecks = rankFixes(original, candidates.map((candidate) => ({ candidate, outcome: byId[candidate.id].outcome })), robustness);
    console.log(`ranked with robustness: ${withChecks.map((r) => `${r.candidate.id} (${isReliable(robustness[r.candidate.id])})`).join(', ')}`);
    expect(withChecks.map((r) => r.candidate.id)).toEqual(['bound-queue', 'retry-budget', 'drop-expired', 'longer-timeout', 'cap-retries', 'jitter-backoff', 'coalesce-misses', 'add-instances']);
  });
});
