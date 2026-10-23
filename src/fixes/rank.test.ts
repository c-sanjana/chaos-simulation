import { assessRecovery, controlConfig } from '../analysis/recovery';
import type { RunConfig } from '../engine/config';
import { runSimulation } from '../engine/run';
import { singleTier } from '../engine/testConfigs';
import type { FixCandidate } from './candidates';
import { fixHelped, measureOutcome, rankFixes, seedAgreement, seedVariants, type FixOutcome } from './rank';

const out = (verdict: FixOutcome['verdict'], recoveryMs: number | null, failedRequests: number): FixOutcome => ({ verdict, recoveryMs, failedRequests });
const stuck = out('stuck', null, 12_000);
const candidate = (id: string): FixCandidate => ({ id, title: id, why: '', caveat: '', config: singleTier(1, { kind: 'fixed', ms: 1 }, 1000) });

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
