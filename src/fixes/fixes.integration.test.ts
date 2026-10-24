/**
 * The point of the feature: on the stuck retry storm, actually simulate every candidate fix (each
 * against its own no-fault control) and check which ones bring the system back.
 *
 * First with one retrying layer (the API retries the DB), where the retry fixes work as their
 * descriptions say; then each preset as it ships, with every layer retrying (users' apps 5,
 * Gateway 3, API 1), where changing one call's retries is no longer enough.
 */
import { analyzed, retryStormRun } from '../analysis/testRuns';
import { buildRunConfig } from '../data/buildConfig';
import { cacheRestart, gatewaySlow, retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { ScenarioPreset } from '../data/types';
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

/** Every candidate fix for the preset's default run, simulated and ranked (seed 42). */
function rankPreset(scenario: ScenarioPreset) {
  const { config, analysis } = analyzed(buildRunConfig(webChain, scenario));
  const original = measureOutcome(config);
  const candidates = candidateFixes(config, analysis.signals, labels);
  const ranked = rankFixes(original, candidates.map((candidate) => ({ candidate, outcome: measureOutcome(candidate.config) })));
  console.log(`${scenario.id} original: ${original.verdict}, ${original.failedRequests} failed\n${describeRanking(ranked)}`);
  return { config, original, candidates, ranked, byId: Object.fromEntries(ranked.map((r) => [r.candidate.id, r])) };
}

describe('fixes for the stuck retry storm (200 rps, 3 API → DB retries, no other retries)', { timeout: 120_000 }, () => {
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

describe('fixes for the default retry storm (200 rps, every layer retrying: 5 / 3 / 1)', { timeout: 120_000 }, () => {
  const { config, original, candidates, ranked, byId } = rankPreset(retryStorm);
  const helpedIds = () => ranked.filter((r) => r.helped).map((r) => r.candidate.id);

  it('the original is stuck', () => {
    expect(original.verdict).toBe('stuck');
  });

  // Measured: no change to one call's retries brings it back, because the other layers keep
  // multiplying. Keeping retries at one layer only does, as do a longer timeout and a bounded queue.
  it('retrying at one layer, a longer timeout and bounding the DB queue help at this seed; one-call retry fixes do not', () => {
    expect(new Set(helpedIds())).toEqual(new Set(['longer-timeout', 'retry-one-layer', 'bound-queue']));
    for (const id of ['retry-budget', 'cap-retries', 'jitter-backoff']) {
      expect(byId[id].outcome.verdict).toBe('stuck');
      expect(byId[id].outcome.failedRequests).toBeLessThanOrEqual(original.failedRequests); // never worse, at least
    }
    expect(byId['retry-one-layer'].outcome).toMatchObject({ verdict: 'recovered', recoveryMs: 13_000 });
  });

  // Dropping expired requests no longer helps: users' apps and the Gateway keep asking again, so
  // the DB's queue refills with requests whose (API) caller is still waiting.
  it('ranks the fixes that helped first, then the rest by failed requests', () => {
    expect(ranked.map((r) => r.candidate.id)).toEqual([
      'longer-timeout', // 9 s, 0 failed
      'retry-one-layer', // 13 s
      'bound-queue', // 16 s
      'cap-retries', // stuck from here on
      'retry-budget',
      'coalesce-misses',
      'drop-expired',
      'jitter-backoff',
      'add-instances',
    ]);
  });

  it('every fix saw identical traffic', () => {
    const arrivals = runSimulation(config).client.requests.arrivalMs;
    for (const c of candidates) expect(runSimulation(c.config).client.requests.arrivalMs).toEqual(arrivals);
  });

  // Seeds 42–46, and the slowdown twice as long (10 s). At 200 req/s an API that retries once is
  // right at its own tipping point (as with "cap retries" in the single-layer storm above), so
  // retrying at one layer helps on only 1 seed of 5.
  it('only bounding the queue holds up across seeds and with a longer slowdown', () => {
    const originals = seedVariants(config).map(measureOutcome);
    expect(originals.every((o) => o.verdict === 'stuck')).toBe(true);
    const helpedIdsNow = helpedIds();
    const seeds = Object.fromEntries(helpedIdsNow.map((id) => [id, seedAgreement(originals, seedVariants(byId[id].candidate.config).map(measureOutcome))]));
    expect(Object.fromEntries(helpedIdsNow.map((id) => [id, seeds[id].helped]))).toEqual({ 'longer-timeout': 4, 'retry-one-layer': 1, 'bound-queue': 5 });

    const longerOriginal = measureOutcome(withLongerOutage(config)!);
    expect(longerOriginal.verdict).toBe('stuck');
    const longer = Object.fromEntries(helpedIdsNow.map((id) => [id, fixHelped(longerOriginal, measureOutcome(withLongerOutage(byId[id].candidate.config)!))]));
    expect(longer).toEqual({ 'longer-timeout': false, 'retry-one-layer': false, 'bound-queue': true });

    const robustness: Record<string, Robustness> = Object.fromEntries(helpedIdsNow.map((id) => [id, { seeds: seeds[id], longer: longer[id] }]));
    const withChecks = rankFixes(original, ranked.map(({ candidate, outcome }) => ({ candidate, outcome })), robustness);
    expect(withChecks.slice(0, 3).map((r) => r.candidate.id)).toEqual(['bound-queue', 'longer-timeout', 'retry-one-layer']);
  });
});

describe('fixes for the default cache restart (200 rps, cache down 5 s and back empty)', { timeout: 120_000 }, () => {
  const { original, ranked, byId } = rankPreset(cacheRestart);

  // The overload comes from the emptied cache, not from repeats: sharing cache refills fixes it at
  // once, and no retry fix helps (retrying at one layer fails even more requests).
  it('sharing cache refills, a longer timeout and bounding the DB queue help; no retry fix does', () => {
    expect(original.verdict).toBe('stuck');
    expect(ranked.filter((r) => r.helped).map((r) => r.candidate.id)).toEqual(['coalesce-misses', 'longer-timeout', 'bound-queue']);
    expect(byId['coalesce-misses'].outcome).toMatchObject({ verdict: 'recovered', failedRequests: 0 });
    for (const id of ['retry-budget', 'cap-retries', 'jitter-backoff', 'retry-one-layer']) expect(byId[id].outcome.verdict).toBe('stuck');
    expect(byId['retry-one-layer'].outcome.failedRequests).toBeGreaterThan(original.failedRequests);
  });
});

describe('fixes for the default gateway slowdown (200 rps, Gateway 50× slower for 20 s)', { timeout: 120_000 }, () => {
  const { original, ranked, byId } = rankPreset(gatewaySlow);

  // The Gateway's pile lands on the DB when it recovers: shedding load at the DB helps, and so does
  // keeping retries at one layer; a longer API → DB timeout does not (the pile comes from in front).
  it('bounding the DB queue and retrying at one layer help', () => {
    expect(original.verdict).toBe('stuck');
    expect(ranked.filter((r) => r.helped).map((r) => r.candidate.id)).toEqual(['bound-queue', 'retry-one-layer']);
    expect(byId['longer-timeout'].outcome.verdict).toBe('stuck');
  });
});
