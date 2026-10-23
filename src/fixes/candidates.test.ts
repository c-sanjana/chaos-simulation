import type { Signals } from '../analysis/signals';
import { retryStormRun } from '../analysis/testRuns';
import { webChain } from '../data/topologies';
import type { RunConfig } from '../engine/config';
import { call, singleTier, tier } from '../engine/testConfigs';
import { applyFix, candidateFixes, describeSignal, queueLimitFor } from './candidates';
import { FIX_CATALOG, type FixDefinition, type FixKind } from './catalog';

const labels = Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label]));
const def = (kind: FixKind): FixDefinition => FIX_CATALOG.find((d) => d.kind === kind)!;
const noSignals: Signals = { retryShare: null, wastedShare: null, queueWaitOverTimeout: null, idleSaturation: null, cacheHitDrop: null };
const signalsWith = (s: Partial<Signals>): Signals => ({ ...noSignals, ...s });

/** Paths of every leaf value that differs between two plain-data values. */
function diffPaths(a: unknown, b: unknown, path = ''): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return [path];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
}

describe('FIX_CATALOG', () => {
  it('has one entry per kind, unique ids, and one-line caveats', () => {
    const kinds: FixKind[] = ['retryBudget', 'capRetries', 'jitterBackoff', 'boundQueue', 'dropExpired', 'coalesceMisses', 'longerTimeout', 'addInstances'];
    expect(FIX_CATALOG.map((d) => d.kind).sort()).toEqual([...kinds].sort());
    expect(new Set(FIX_CATALOG.map((d) => d.id)).size).toBe(FIX_CATALOG.length);
    for (const d of FIX_CATALOG) {
      expect(d.caveat.length).toBeGreaterThan(10);
      expect(d.caveat).not.toMatch(/\n/);
    }
    expect(FIX_CATALOG.filter((d) => d.signal === null).map((d) => d.kind)).toEqual(['longerTimeout', 'addInstances']);
  });
});

describe('on the stuck retry storm', { timeout: 60_000 }, () => {
  const { config, analysis } = retryStormRun({ retries: 3 });
  const signals = analysis.signals;
  const snapshot = structuredClone(config);

  const expectedChange: Record<FixKind, [string, unknown]> = {
    retryBudget: ['tiers.1.downstream.retryBudget', 0.1],
    capRetries: ['tiers.1.downstream.retries', 1],
    jitterBackoff: ['tiers.1.downstream.jitter', true],
    boundQueue: ['tiers.3.queueLimit', 93],
    dropExpired: ['tiers.3.dropExpired', true],
    coalesceMisses: ['tiers.1.coalesceMisses', true],
    longerTimeout: ['tiers.1.downstream.timeoutMs', 3000],
    addInstances: ['tiers.1.instances', 6],
  };

  it.each(FIX_CATALOG.map((d) => [d.kind, d] as const))('applyFix(%s) changes exactly one setting and leaves the original alone', (kind, d) => {
    const patched = applyFix(d, config, signals)!;
    expect(patched).not.toBeNull();
    const [path, value] = expectedChange[kind];
    expect(diffPaths(config, patched)).toEqual([path]);
    expect(path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], patched)).toBe(value);
    expect(config).toEqual(snapshot);
  });

  it('suggests every catalog fix, in catalog order, each quoting its signal with real numbers', () => {
    const candidates = candidateFixes(config, signals, labels);
    expect(candidates.map((c) => c.id)).toEqual(['retry-budget', 'cap-retries', 'jitter-backoff', 'bound-queue', 'drop-expired', 'coalesce-misses', 'longer-timeout', 'add-instances']);
    const why = Object.fromEntries(candidates.map((c) => [c.id, c.why]));
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    expect(why['retry-budget']).toBe(`retries were ${pct(signals.retryShare!.value)} of DB load`);
    expect(why['cap-retries']).toBe(why['retry-budget']);
    expect(why['bound-queue']).toBe(`DB's queued wait reached ${Math.round(signals.queueWaitOverTimeout!.value)}× the API's 1 s timeout`);
    expect(why['drop-expired']).toBe(`${pct(signals.wastedShare!.value)} of DB work was for requests whose caller had already given up`);
    const { before, during } = signals.cacheHitDrop!.value;
    expect(why['coalesce-misses']).toBe(`Cache hit rate fell from ${pct(before)} to ${pct(during)}`);
    expect(why['longer-timeout']).toBe('a common first instinct');
    expect(why['add-instances']).toBe('a common first instinct');
    expect(why['retry-budget']).toMatch(/^retries were [5-9]\d% of DB load$/);
    for (const c of candidates) {
      expect(c.caveat).toBe(FIX_CATALOG.find((d) => d.id === c.id)!.caveat);
      expect(c.config).toEqual(applyFix(FIX_CATALOG.find((d) => d.id === c.id)!, config, signals));
    }
    expect(candidates.find((c) => c.id === 'bound-queue')!.title).toBe('Bound the queue (load shedding): DB, at most 93 queued per instance');
    expect(candidates.find((c) => c.id === 'retry-budget')!.title).toBe('Retry budget of 10%: API → DB');
    expect(candidates.find((c) => c.id === 'longer-timeout')!.title).toBe('Longer timeout (×3): API → DB, 1 s → 3 s');
    expect(candidates.find((c) => c.id === 'add-instances')!.title).toBe('Add instances (+50%): API, 4 → 6 instances');
    expect(config).toEqual(snapshot);
  });

  it('leaves out fixes whose signal did not show up', () => {
    const { config: calm, analysis: calmAnalysis } = retryStormRun({ retries: 0 });
    const ids = candidateFixes(calm, calmAnalysis.signals, labels).map((c) => c.id);
    for (const id of ['retry-budget', 'cap-retries', 'jitter-backoff']) expect(ids).not.toContain(id);
  });
});

describe('applyFix: where it applies', () => {
  /** Client → api → db, api using a cache. */
  const chain = (): RunConfig => ({
    seed: 1,
    durationMs: 10_000,
    client: { rps: 10, call: call('api', { timeoutMs: 2000, retries: 2, backoffBaseMs: 0 }) },
    tiers: [
      tier('api', { kind: 'fixed', ms: 1 }, { workersPerInstance: 10, cacheAside: call('cache'), downstream: call('db', { timeoutMs: 500, retries: 3, backoffBaseMs: 0 }) }),
      tier('cache', { kind: 'fixed', ms: 1 }, { cache: { capacity: 10, ttlMs: null, keys: 100, skew: 1 } }),
      tier('db', { kind: 'fixed', ms: 10 }, { workersPerInstance: 8, coresPerInstance: 2 }),
    ],
  });
  const at = (id: string) => ({ tier: id, value: 1 });

  it('returns null for every fix when no signal points anywhere', () => {
    for (const d of FIX_CATALOG) expect(applyFix(d, chain(), noSignals)).toBeNull();
  });

  it('retry fixes target the call whose retries arrived, including the client’s', () => {
    const c = applyFix(def('retryBudget'), chain(), signalsWith({ retryShare: at('api') }))!;
    expect(diffPaths(chain(), c)).toEqual(['client.call.retryBudget']);
    expect(applyFix(def('capRetries'), chain(), signalsWith({ retryShare: at('api') }))!.client.call.retries).toBe(1);
  });

  it('adds a base delay when the call it jitters retries immediately', () => {
    const c = applyFix(def('jitterBackoff'), chain(), signalsWith({ retryShare: at('db') }))!;
    expect(diffPaths(chain(), c).sort()).toEqual(['tiers.0.downstream.backoffBaseMs', 'tiers.0.downstream.jitter']);
    expect(c.tiers[0].downstream).toMatchObject({ jitter: true, backoffBaseMs: 100 });
  });

  it('does not apply a change that is already in place', () => {
    const c = chain();
    c.tiers[0].downstream = { ...c.tiers[0].downstream!, retries: 1, retryBudget: 0.05, jitter: true, backoffBaseMs: 20 };
    c.tiers[0].coalesceMisses = true;
    c.tiers[2].dropExpired = true;
    c.tiers[2].queueLimit = 0;
    const s = signalsWith({ retryShare: at('db'), wastedShare: at('db'), queueWaitOverTimeout: at('db'), cacheHitDrop: { tier: 'cache', value: { before: 0.8, during: 0.1 } } });
    for (const kind of ['retryBudget', 'capRetries', 'jitterBackoff', 'boundQueue', 'dropExpired', 'coalesceMisses'] as const) {
      expect(applyFix(def(kind), c, s)).toBeNull();
    }
    expect(applyFix(def('retryBudget'), chain(), signalsWith({ retryShare: at('db') }))).not.toBeNull(); // looser budget would be tightened
  });

  it('retry fixes need a caller that retries; coalescing needs a cache-aside tier', () => {
    const c = chain();
    c.tiers[0].downstream!.retries = 0;
    expect(applyFix(def('retryBudget'), c, signalsWith({ retryShare: at('db') }))).toBeNull();
    const noCache = { ...chain(), tiers: chain().tiers.map((t) => (t.id === 'api' ? { ...t, cacheAside: undefined } : t)) };
    expect(applyFix(def('coalesceMisses'), noCache, signalsWith({ cacheHitDrop: { tier: 'cache', value: { before: 1, during: 0 } } }))).toBeNull();
  });

  it('the instincts need a timeout to lengthen, and scale the bottleneck itself when the client calls it', () => {
    const noTimeout = singleTier(10, { kind: 'fixed', ms: 1 }, 1000);
    expect(applyFix(def('longerTimeout'), noTimeout, signalsWith({ wastedShare: at('svc') }))).toBeNull();
    const scaled = applyFix(def('addInstances'), noTimeout, signalsWith({ retryShare: at('svc') }))!;
    expect(diffPaths(noTimeout, scaled)).toEqual(['tiers.0.instances']);
    expect(scaled.tiers[0].instances).toBe(2); // 1 × 1.5, rounded up
    // A tier nothing calls has no call to change, so only adding instances applies (to itself).
    const orphan = { ...noTimeout, tiers: [...noTimeout.tiers, tier('spare', { kind: 'fixed', ms: 1 }, { instances: 4 })] };
    const s = signalsWith({ retryShare: at('spare'), queueWaitOverTimeout: at('spare') });
    expect(applyFix(def('longerTimeout'), orphan, s)).toBeNull();
    expect(applyFix(def('retryBudget'), orphan, s)).toBeNull();
    expect(applyFix(def('boundQueue'), orphan, s)).toBeNull();
    expect(applyFix(def('addInstances'), orphan, s)!.tiers[1].instances).toBe(6);
  });

  it('bounds a non-leaf tier’s queue at its worker count', () => {
    const c = applyFix(def('boundQueue'), chain(), signalsWith({ queueWaitOverTimeout: at('api') }))!;
    expect(diffPaths(chain(), c)).toEqual(['tiers.0.queueLimit']);
    expect(c.tiers[0].queueLimit).toBe(10);
  });
});

describe('queueLimitFor', () => {
  it('admits only what the instance can serve within the caller’s timeout', () => {
    // 2 cores, 10 ms each: 200/s per instance; in 500 ms it serves 100, of which 8 hold workers.
    expect(queueLimitFor(tier('db', { kind: 'fixed', ms: 10 }, { workersPerInstance: 8, coresPerInstance: 2, instances: 3 }), 500)).toBe(92);
    // Workers bind before cores: 1 worker, 50 ms → 20/s; 1 s → 20, minus the 1 in service.
    expect(queueLimitFor(tier('db', { kind: 'fixed', ms: 50 }, { workersPerInstance: 1, coresPerInstance: 4 }), 1000)).toBe(19);
  });

  it('is never negative, and is the worker count for tiers that call others', () => {
    expect(queueLimitFor(tier('db', { kind: 'fixed', ms: 100 }, { workersPerInstance: 50, coresPerInstance: 1 }), 200)).toBe(0);
    expect(queueLimitFor(tier('api', { kind: 'fixed', ms: 1 }, { workersPerInstance: 7, downstream: call('db') }), 1000)).toBe(7);
  });
});

describe('describeSignal', () => {
  it('quotes idle saturation in seconds', () => {
    const s = signalsWith({ idleSaturation: { tier: 'api', value: 30 } });
    expect(describeSignal('idleSaturation', s, singleTier(1, { kind: 'fixed', ms: 1 }, 1000), (id) => id.toUpperCase())).toBe('API workers were all occupied but mostly idle for 30 s');
  });

  it('formats small queue-wait ratios with one decimal', () => {
    const c = singleTier(1, { kind: 'fixed', ms: 1 }, 1000, {}, { timeoutMs: 250 });
    expect(describeSignal('queueWaitOverTimeout', signalsWith({ queueWaitOverTimeout: { tier: 'svc', value: 2.345 } }), c, (id) => id)).toBe("svc's queued wait reached 2.3× the client's 250 ms timeout");
  });
});
