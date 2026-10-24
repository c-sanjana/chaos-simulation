import { assessRecovery, controlConfig } from '../analysis/recovery';
import type { RunConfig } from '../engine/config';
import { runSimulation } from '../engine/run';
import { singleTier } from '../engine/testConfigs';
import type { FixCandidate } from './candidates';
import { fixHelped, isReliable, LONGER_OUTAGE_MARGIN_MS, measureOutcome, rankFixes, seedAgreement, seedVariants, withLongerOutage, type FixOutcome } from './rank';

const out = (verdict: FixOutcome['verdict'], recoveryMs: number | null, failedRequests: number): FixOutcome => ({ verdict, recoveryMs, failedRequests });
const stuck = out('stuck', null, 12_000);
const candidate = (id: string): FixCandidate => ({ id, title: id, name: id, short: id, what: '', how: '', why: '', pros: [], cons: [], config: singleTier(1, { kind: 'fixed', ms: 1 }, 1000) });

describe('fixHelped', () => {
  it('from stuck or overloaded, helping means getting back to normal', () => {
    expect(fixHelped(stuck, out('recovered', 30_000, 5000))).toBe(true);
    expect(fixHelped(stuck, out('unaffected', null, 0))).toBe(true);
    expect(fixHelped(stuck, out('stuck', null, 10))).toBe(false); // fewer failures, but still stuck
    expect(fixHelped(out('overloaded', null, 900), out('recovered', 1000, 5))).toBe(true);
    expect(fixHelped(out('overloaded', null, 900), out('stuck', null, 5))).toBe(false);
  });

  it('from recovered, helping means recovering strictly faster or failing strictly fewer requests', () => {
    const recovered = out('recovered', 5000, 300);
    expect(fixHelped(recovered, out('recovered', 4000, 300))).toBe(true);
    expect(fixHelped(recovered, out('recovered', 5000, 299))).toBe(true);
    expect(fixHelped(recovered, out('recovered', 5000, 300))).toBe(false);
    expect(fixHelped(recovered, out('recovered', 6000, 400))).toBe(false);
    expect(fixHelped(recovered, out('unaffected', null, 300))).toBe(true); // never left normal: 0 s
    expect(fixHelped(recovered, out('stuck', null, 0))).toBe(false);
    expect(fixHelped(recovered, out('overloaded', null, 0))).toBe(false);
  });

  it('from unaffected, only fewer failed requests helps', () => {
    expect(fixHelped(out('unaffected', null, 3), out('unaffected', null, 2))).toBe(true);
    expect(fixHelped(out('unaffected', null, 3), out('recovered', 1000, 0))).toBe(true);
    expect(fixHelped(out('unaffected', null, 3), out('unaffected', null, 3))).toBe(false);
  });
});

describe('rankFixes', () => {
  it('ranks helped first, then verdict, recovery time, failed requests, and catalog order', () => {
    const results = [
      { candidate: candidate('add-instances'), outcome: out('stuck', null, 13_000) },
      { candidate: candidate('longer-timeout'), outcome: out('overloaded', null, 100) },
      { candidate: candidate('drop-expired'), outcome: out('recovered', 3000, 500) },
      { candidate: candidate('cap-retries'), outcome: out('recovered', 13_000, 800) },
      { candidate: candidate('bound-queue'), outcome: out('recovered', 3000, 200) },
      { candidate: candidate('jitter-backoff'), outcome: out('stuck', null, 13_000) },
      { candidate: candidate('coalesce-misses'), outcome: out('unaffected', null, 900) },
      { candidate: candidate('retry-budget'), outcome: out('recovered', 3000, 200) },
    ];
    const ranked = rankFixes(stuck, results);
    expect(ranked.map((r) => r.candidate.id)).toEqual([
      'coalesce-misses', // unaffected beats recovered, whatever the failures
      'retry-budget', // 3 s, 200 failed; tie with bound-queue broken by catalog order
      'bound-queue',
      'drop-expired', // 3 s, 500 failed
      'cap-retries', // 13 s
      'jitter-backoff', // stuck; tie with add-instances broken by catalog order
      'add-instances',
      'longer-timeout', // overloaded
    ]);
    expect(ranked.map((r) => r.helped)).toEqual([true, true, true, true, true, false, false, false]);
    expect(ranked[1].outcome).toBe(results[7].outcome);
  });

  it('a helped fix outranks an unhelpful one with a better verdict', () => {
    const original = out('recovered', 2000, 100);
    const ranked = rankFixes(original, [
      { candidate: candidate('retry-budget'), outcome: out('recovered', 2000, 100) }, // no change: not helped
      { candidate: candidate('cap-retries'), outcome: out('recovered', 9000, 50) }, // slower, but fewer failures
    ]);
    expect(ranked.map((r) => [r.candidate.id, r.helped])).toEqual([['cap-retries', true], ['retry-budget', false]]);
  });

  it('treats recovery times within 1 s of each other as a tie, won by fewer failed requests', () => {
    const ranked = rankFixes(stuck, [
      { candidate: candidate('retry-budget'), outcome: out('recovered', 2000, 300) },
      { candidate: candidate('bound-queue'), outcome: out('recovered', 3000, 100) }, // within 1 s of 2 s
      { candidate: candidate('drop-expired'), outcome: out('recovered', 3100, 10) }, // more than 1 s after 2 s
    ]);
    expect(ranked.map((r) => r.candidate.id)).toEqual(['bound-queue', 'retry-budget', 'drop-expired']);
  });

  it('cuts ties from the fastest time, so a chain of close times is not all one tie', () => {
    // 1 s and 1.9 s tie; 2.8 s is within 1 s of 1.9 s but not of 1 s, so it starts a new tie.
    const ranked = rankFixes(stuck, [
      { candidate: candidate('retry-budget'), outcome: out('recovered', 1000, 300) },
      { candidate: candidate('cap-retries'), outcome: out('recovered', 1900, 100) },
      { candidate: candidate('jitter-backoff'), outcome: out('recovered', 2800, 50) },
    ]);
    expect(ranked.map((r) => r.candidate.id)).toEqual(['cap-retries', 'retry-budget', 'jitter-backoff']);
  });

  it('ties only among fixes ranked alike otherwise: a slower helped fix is not tied with a faster unhelpful one', () => {
    const original = out('recovered', 3000, 100);
    const ranked = rankFixes(original, [
      { candidate: candidate('retry-budget'), outcome: out('recovered', 3900, 50) }, // helped: fewer failures
      { candidate: candidate('cap-retries'), outcome: out('recovered', 4300, 20) }, // helped: even fewer
      { candidate: candidate('jitter-backoff'), outcome: out('recovered', 3200, 100) }, // not helped
    ]);
    // 3.9 s and 4.3 s tie (the unhelpful 3.2 s does not start their tie), so fewer failures wins.
    expect(ranked.map((r) => r.candidate.id)).toEqual(['cap-retries', 'retry-budget', 'jitter-backoff']);
  });

  it('puts reliable helped fixes before unreliable ones; not-yet-known counts as reliable; the rest keep their order', () => {
    const results = [
      { candidate: candidate('retry-budget'), outcome: out('recovered', 1000, 10) }, // fastest, but helped on 2 of 5 seeds
      { candidate: candidate('bound-queue'), outcome: out('recovered', 5000, 10) }, // reliable
      { candidate: candidate('drop-expired'), outcome: out('recovered', 9000, 10) }, // not checked yet
      { candidate: candidate('longer-timeout'), outcome: out('recovered', 2000, 10) }, // stops helping with a longer slowdown
      { candidate: candidate('jitter-backoff'), outcome: stuck },
      { candidate: candidate('add-instances'), outcome: stuck },
    ];
    const ranked = rankFixes(stuck, results, {
      'retry-budget': { seeds: { helped: 2, of: 5 } },
      'bound-queue': { seeds: { helped: 5, of: 5 }, longer: true },
      'longer-timeout': { seeds: { helped: 5, of: 5 }, longer: false },
      'add-instances': { seeds: { helped: 0, of: 5 } }, // did not help anyway: order unchanged
    });
    expect(ranked.map((r) => r.candidate.id)).toEqual(['bound-queue', 'drop-expired', 'retry-budget', 'longer-timeout', 'jitter-backoff', 'add-instances']);
    expect(rankFixes(stuck, results).map((r) => r.candidate.id)).toEqual(['retry-budget', 'longer-timeout', 'bound-queue', 'drop-expired', 'jitter-backoff', 'add-instances']);
  });

  it('keeps input order for ids outside the catalog', () => {
    const ranked = rankFixes(stuck, [
      { candidate: candidate('custom-b'), outcome: stuck },
      { candidate: candidate('custom-a'), outcome: stuck },
      { candidate: candidate('retry-budget'), outcome: stuck },
    ]);
    expect(ranked.map((r) => r.candidate.id)).toEqual(['retry-budget', 'custom-b', 'custom-a']);
    expect(rankFixes(stuck, [])).toEqual([]);
  });
});

describe('seedVariants and seedAgreement', () => {
  const config: RunConfig = { ...singleTier(5, { kind: 'fixed', ms: 1 }, 1000), seed: 42 };

  it('makes consecutive seeds of the same config, without touching it', () => {
    const variants = seedVariants(config);
    expect(variants.map((v) => v.seed)).toEqual([42, 43, 44, 45, 46]);
    for (const v of variants) expect({ ...v, seed: 42 }).toEqual(config);
    expect(config.seed).toBe(42);
    expect(seedVariants(config, 2).map((v) => v.seed)).toEqual([42, 43]);
    expect(seedVariants(config)).toEqual(seedVariants(config));
  });

  it('counts the seeds on which the fix helped against the original at the same seed', () => {
    const originals = [stuck, stuck, out('recovered', 4000, 100), out('recovered', 4000, 100), stuck];
    const fixed = [out('recovered', 1000, 10), stuck, out('recovered', 2000, 100), out('recovered', 5000, 100), out('unaffected', null, 0)];
    expect(seedAgreement(originals, fixed)).toEqual({ helped: 3, of: 5 });
    expect(seedAgreement([], [])).toEqual({ helped: 0, of: 0 });
  });

  it('needs one fixed outcome per original', () => {
    expect(() => seedAgreement([stuck], [])).toThrow(/one fixed outcome per seed/);
  });
});

describe('isReliable', () => {
  it('needs at least 80% of seeds and no failed longer-slowdown check; unknown until the seeds are in', () => {
    expect(isReliable(undefined)).toBeNull();
    expect(isReliable({})).toBeNull();
    expect(isReliable({ longer: true })).toBeNull();
    expect(isReliable({ seeds: { helped: 0, of: 0 } })).toBeNull();
    expect(isReliable({ seeds: { helped: 4, of: 5 } })).toBe(true);
    expect(isReliable({ seeds: { helped: 5, of: 5 }, longer: true })).toBe(true);
    expect(isReliable({ seeds: { helped: 8, of: 10 } })).toBe(true);
    expect(isReliable({ seeds: { helped: 3, of: 5 } })).toBe(false);
    expect(isReliable({ seeds: { helped: 7, of: 10 } })).toBe(false);
    expect(isReliable({ seeds: { helped: 5, of: 5 }, longer: false })).toBe(false);
    expect(isReliable({ longer: false })).toBe(false); // already failed, seeds or not
  });
});

describe('withLongerOutage', () => {
  const config: RunConfig = {
    ...singleTier(5, { kind: 'fixed', ms: 1 }, 120_000),
    faults: [
      { tier: 'svc', kind: 'slow', factor: 8, startMs: 30_000, endMs: 35_000 },
      { tier: 'svc', kind: 'dead', startMs: 50_000, endMs: 51_000 },
    ],
  };

  it('makes every failure last longer from the same start, without touching the original', () => {
    const snapshot = structuredClone(config);
    const longer = withLongerOutage(config)!;
    expect(longer.faults).toEqual([
      { tier: 'svc', kind: 'slow', factor: 8, startMs: 30_000, endMs: 40_000 },
      { tier: 'svc', kind: 'dead', startMs: 50_000, endMs: 52_000 },
    ]);
    expect({ ...longer, faults: config.faults }).toEqual(config);
    expect(withLongerOutage(config, 3)!.faults!.map((f) => f.endMs)).toEqual([45_000, 53_000]);
    expect(config).toEqual(snapshot);
  });

  it('gives up when a longer failure would end too close to the end of the run, or there is none', () => {
    expect(LONGER_OUTAGE_MARGIN_MS).toBe(20_000);
    const lastFault = (endMs: number): RunConfig => ({ ...config, faults: [{ tier: 'svc', kind: 'slow', factor: 2, startMs: 60_000, endMs }] });
    expect(withLongerOutage(lastFault(80_000))!.faults![0].endMs).toBe(100_000); // ends exactly 20 s before the end: fine
    expect(withLongerOutage(lastFault(80_001))).toBeNull();
    expect(withLongerOutage({ ...config, faults: [] })).toBeNull();
    expect(withLongerOutage({ ...config, faults: undefined })).toBeNull();
  });
});

describe('measureOutcome', () => {
  const withFault: RunConfig = {
    ...singleTier(20, { kind: 'fixed', ms: 5 }, 30_000, { workersPerInstance: 4 }, { timeoutMs: 1000 }),
    faults: [{ tier: 'svc', kind: 'dead', startMs: 10_000, endMs: 12_000 }],
  };

  it('judges the run against its own no-fault control', () => {
    const control = runSimulation(controlConfig(withFault));
    const expected = assessRecovery(runSimulation(withFault), control, withFault);
    expect(measureOutcome(withFault)).toEqual({ verdict: expected.verdict, recoveryMs: expected.recoveryMs, failedRequests: expected.failedRequests });
    expect(measureOutcome(withFault).verdict).toBe('recovered');
  });

  it('uses the fixed config’s control, so a fix that fails requests in normal operation is overloaded', () => {
    // A queue limit of 0 with one worker rejects requests even when nothing has failed.
    const shedding: RunConfig = { ...withFault, tiers: [{ ...withFault.tiers[0], workersPerInstance: 1, coresPerInstance: 1, queueLimit: 0 }] };
    expect(measureOutcome(shedding).verdict).toBe('overloaded');
  });
});
