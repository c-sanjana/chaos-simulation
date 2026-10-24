/** Fixes on branched systems: any call can be addressed and changed, and the texts stay true. */
import type { Signals } from '../analysis/signals';
import { analyzed } from '../analysis/testRuns';
import { fanIn, graphLabels, splitPools, webWithSearch } from '../analysis/testGraphs';
import type { RunConfig } from '../engine/config';
import { validateConfig } from '../engine/validate';
import { allCalls, applyFix, candidateFixes, refOf, withCall } from './candidates';
import { FIX_CATALOG, type FixKind } from './catalog';
import { configChanges } from './changes';
import { explainFix } from './explain';
import { fixHelped } from './rank';

const def = (kind: FixKind) => FIX_CATALOG.find((d) => d.kind === kind)!;
const noSignals: Signals = { retryShare: null, wastedShare: null, queueWaitOverTimeout: null, idleSaturation: null, cacheHitDrop: null, queueBacklog: null };

describe('addressing calls', () => {
  const config = webWithSearch('parallel');

  it('lists every call, further calls included, and addresses each one', () => {
    expect(allCalls(config).map((r) => `${r.owner}.${r.field}[${r.index}]→${r.policy.target}`)).toEqual([
      'client.call[0]→gateway',
      'gateway.downstream[0]→api',
      'api.cacheAside[0]→cache',
      'api.downstream[0]→db',
      'api.more[0]→search',
    ]);
    expect(refOf({ from: 'api', kind: 'downstream', index: 2, policy: config.client.call })).toMatchObject({ field: 'more', index: 1 });
  });

  it('changes exactly the call it is given, without mutating the config', () => {
    const before = JSON.stringify(config);
    const [toDb, toSearch] = allCalls(config).slice(3);
    const fixed = withCall(config, toSearch, { retries: 0 });
    const api = (c: RunConfig) => c.tiers.find((t) => t.id === 'api')!;
    expect(api(fixed).moreDownstream![0].retries).toBe(0);
    expect(api(fixed).downstream).toBe(api(config).downstream);
    expect(api(withCall(config, toDb, { retries: 0 })).moreDownstream).toBe(api(config).moreDownstream);
    expect(JSON.stringify(config)).toBe(before);
    expect(() => validateConfig(fixed)).not.toThrow();
    // A further call's change is labelled with its own arrow.
    expect(configChanges(config, fixed)).toEqual([{ call: { from: 'api', to: 'search' }, text: 'no retries (was 1)' }]);
  });
});

describe('fix candidates with branches', { timeout: 120_000 }, () => {
  it('retry at one layer only also stops the kept layer’s other calls, and says so', () => {
    const config = webWithSearch('parallel');
    const { run, analysis } = analyzed(config);
    const candidates = candidateFixes(config, analysis.signals, graphLabels, run);
    const one = candidates.find((c) => c.id === 'retry-one-layer')!;
    expect(one.what).toBe("Only the App server's calls to DB ask the DB again (once); users' apps, the Gateway and the App server's calls to Search service no longer retry.");
    expect(one.how).toBe('The app server asks the database again and nothing else does: its other calls and every other layer pass errors straight back, so repeats no longer multiply from layer to layer.');
    expect(allCalls(one.config).filter((r) => r.policy.retries > 0).map((r) => `${r.owner}→${r.policy.target}`)).toEqual(['api→db']);
    const coalesce = candidates.find((c) => c.id === 'coalesce-misses')!;
    expect(coalesce.how).toBe('When requests miss the cache for the same entry at once, one of them makes the reads behind it and the rest share its answer.');
  });

  it('fan-in: fixes aimed at the database go to the caller sending it the most; the queue limit fits the least patient caller', () => {
    const config = fanIn();
    const { run, analysis } = analyzed(config);
    const candidates = candidateFixes(config, analysis.signals, graphLabels, run);
    // Reports gives up sooner (800 ms), so it repeats more: it sends the database the most.
    expect(candidates.find((c) => c.id === 'retry-budget')!.title).toBe('Retry budget of 10%: Reports service → DB');
    expect(candidates.find((c) => c.id === 'longer-timeout')!.title).toBe('Longer timeout (×3): Reports service → DB, 800 ms → 2.4 s');
    const bound = candidates.find((c) => c.id === 'bound-queue')!;
    expect(bound.why).toMatch(/longer than the Reports service's 800 ms timeout$/);
    expect(bound.how).toContain('before the caller gives up');
    const drop = candidates.find((c) => c.id === 'drop-expired')!;
    expect(drop.how).toBe('The database skips requests whose caller has already given up on them, so its time goes to requests someone is still waiting for.');
    // Without the run, by share of user traffic: both get every request, so the first caller.
    expect(applyFix(def('retryBudget'), config, analysis.signals)!.tiers.find((t) => t.id === 'orders')!.downstream!.retryBudget).toBe(0.1);
  });

  it('a split: retry fixes change the call into the overloaded pool only', () => {
    const config = splitPools({ shareBlue: 3, clientRetries: 2 });
    const { run, analysis } = analyzed(config);
    const fixed = applyFix(def('capRetries'), config, analysis.signals, run)!;
    const lb = fixed.tiers.find((t) => t.id === 'lb')!;
    expect(analysis.signals.queueWaitOverTimeout?.tier ?? analysis.signals.wastedShare?.tier).toBe('blue');
    expect([lb.downstream!.target, lb.downstream!.retries, lb.moreDownstream![0].retries]).toEqual(['blue', 1, 2]);
    expect(lb.downstream!.share).toBe(3); // the share is kept
  });

  it('fixes that need a signal or a caller are left out without one', () => {
    expect(candidateFixes(webWithSearch('sequence'), noSignals, graphLabels)).toEqual([]);
  });
});

describe('explanations with branches', { timeout: 120_000 }, () => {
  it('a layer whose calls retry differently shows the range', () => {
    const base = webWithSearch('parallel');
    const config: RunConfig = { ...base, tiers: base.tiers.map((t) => (t.id === 'api' ? { ...t, moreDownstream: [{ ...t.moreDownstream![0], retries: 3 }] } : t)) };
    const before = analyzed(config);
    const candidate = candidateFixes(config, before.analysis.signals, graphLabels, before.run).find((c) => c.id === 'jitter-backoff')!;
    const after = analyzed(candidate.config);
    const helped = fixHelped(before.analysis.recovery, after.analysis.recovery);
    const e = explainFix('jitterBackoff', helped, { config, result: before }, { config: candidate.config, result: after }, graphLabels);
    expect(helped).toBe(false);
    expect(e.text).toMatch(/^Every repeat is still sent, only later: users' apps \(5×\), the gateway \(3×\) and the app server \(1–3×\) still retry/);
  });

  it('a longer timeout on a further call is compared with the failure of the part it waits for', () => {
    const config = webWithSearch('sequence', 200, [{ tier: 'search', kind: 'slow', factor: 20, startMs: 30_000, endMs: 40_000 }]);
    const ref = allCalls(config).find((r) => r.field === 'more')!;
    const after = withCall(config, ref, { timeoutMs: 3000 });
    const [b, a] = [analyzed(config), analyzed(after)];
    const e = explainFix('longerTimeout', false, { config, result: b }, { config: after, result: a }, graphLabels);
    expect(e.text).toMatch(/^The failure lasted 10 s, longer than the new 3 s wait, so the app server still gave up and asked again/);
  });
});
