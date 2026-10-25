import type { Signals } from '../analysis/signals';
import { analyzed, retryStormRun } from '../analysis/testRuns';
import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RunConfig } from '../engine/config';
import { call, singleTier, tier } from '../engine/testConfigs';
import { applyFix, candidateFixes, COMMON_INSTINCT, describeSignal, fillNames, queueLimitFor } from './candidates';
import { FIX_CATALOG, type FixDefinition, type FixKind } from './catalog';

const labels = Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label]));
const def = (kind: FixKind): FixDefinition => FIX_CATALOG.find((d) => d.kind === kind)!;
const noSignals: Signals = { retryShare: null, wastedShare: null, queueWaitOverTimeout: null, idleSaturation: null, cacheHitDrop: null, queueBacklog: null };
const signalsWith = (s: Partial<Signals>): Signals => ({ ...noSignals, ...s });

/** Paths of every leaf value that differs between two plain-data values. */
function diffPaths(a: unknown, b: unknown, path = ''): string[] {
  if (Object.is(a, b)) return [];
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return [path];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((k) => diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
}

describe('FIX_CATALOG', () => {
  it('has one entry per kind, unique ids, a short tab name, and one-line pros and cons', () => {
    const kinds: FixKind[] = ['retryBudget', 'retryBudgetEveryLayer', 'capRetries', 'jitterBackoff', 'retryOneLayer', 'boundQueue', 'dropExpired', 'coalesceMisses', 'moreConsumers', 'longerTimeout', 'addInstances'];
    expect(FIX_CATALOG.map((d) => d.kind).sort()).toEqual([...kinds].sort());
    expect(new Set(FIX_CATALOG.map((d) => d.id)).size).toBe(FIX_CATALOG.length);
    for (const d of FIX_CATALOG) {
      expect(d.short.length).toBeLessThanOrEqual(18); // a full name that wraps on two lines at most
      expect(d.pros.length).toBeGreaterThanOrEqual(2);
      expect(d.cons.length).toBeGreaterThanOrEqual(2);
      for (const line of [...d.pros, ...d.cons]) {
        expect(line.length).toBeGreaterThan(10);
        expect(line).not.toMatch(/\n|\.$/); // shown as list items
      }
    }
    expect(FIX_CATALOG.filter((d) => d.signal === null).map((d) => d.kind)).toEqual(['longerTimeout', 'addInstances']);
  });

  it('explains how each fix works in one or two plain sentences', () => {
    for (const d of FIX_CATALOG) {
      const sentences = d.how.split(/(?<=\.) /);
      expect(sentences.length).toBeGreaterThanOrEqual(1);
      expect(sentences.length).toBeLessThanOrEqual(2);
      expect(d.how).toMatch(/\.$/);
      expect(d.how.replace(/\{(caller|target|Caller|Target)\}/g, '')).not.toMatch(/[{}]/); // only known placeholders
      expect(d.how).not.toMatch(/p99|rps|tier|timeout|retr|latency/i);
      // The mechanism only: whether it worked is measured per run (fixes/explain.ts), so `how`
      // never promises or denies an outcome next to a result that might say otherwise.
      expect(d.how).not.toMatch(/drain|usually|goes on|recover|enough|stuck|keeps growing|the loop/i);
    }
  });

  it('marks only its own pros and cons as contradictable by a run', () => {
    for (const d of FIX_CATALOG) {
      for (const claim of Object.keys(d.refutable ?? {})) expect([...d.pros, ...d.cons]).toContain(claim);
    }
    expect(FIX_CATALOG.find((d) => d.id === 'cap-retries')!.refutable).toEqual({ 'Repeats from this layer can at most double its calls to the struggling service': 'loadOverDouble' });
  });

  it('keeps its pros and cons true to what was measured', () => {
    const byId = Object.fromEntries(FIX_CATALOG.map((d) => [d.id, d]));
    // The queue limit is sized from normal speed: during the slowdown accepted requests still time out.
    expect(byId['bound-queue'].pros[0]).toBe('At normal speed, anything it accepts is served before the caller gives up');
    expect(byId['bound-queue'].cons).toContain('During a slowdown some accepted requests still take longer than the caller waits');
    // Retries can double the calls, but the database's load can climb much further as the cache empties.
    expect(byId['cap-retries'].pros.join(' ')).not.toMatch(/twice the normal load/);
    expect(byId['longer-timeout'].cons[0]).toBe('Only helps if the slowdown is shorter than the new wait');
    expect([...byId['retry-budget'].cons, ...byId['jitter-backoff'].cons].join(' ')).not.toMatch(/gRPC|halves/);
    // Measured: keeping one layer's retries does not save a run overloaded by an emptied cache.
    expect(byId['retry-one-layer'].cons).toContain('Does not help when the extra load comes from elsewhere, such as an emptied cache');
  });
});

describe('on the stuck retry storm, retrying at one layer (3 App server → DB retries)', { timeout: 60_000 }, () => {
  const { config, analysis } = retryStormRun({ retries: 3 });
  const signals = analysis.signals;
  const snapshot = structuredClone(config);

  const expectedChange: Record<Exclude<FixKind, 'retryOneLayer' | 'retryBudgetEveryLayer' | 'moreConsumers'>, [string, unknown]> = {
    retryBudget: ['tiers.1.downstream.retryBudget', 0.1],
    capRetries: ['tiers.1.downstream.retries', 1],
    jitterBackoff: ['tiers.1.downstream.jitter', true],
    boundQueue: ['tiers.3.queueLimit', 93],
    dropExpired: ['tiers.3.dropExpired', true],
    coalesceMisses: ['tiers.1.coalesceMisses', true],
    longerTimeout: ['tiers.1.downstream.timeoutMs', 3000],
    addInstances: ['tiers.1.instances', 6],
  };

  // No queue here, so no consumers to add (see candidates.queue.test.ts).
  const oneSetting = FIX_CATALOG.filter((d) => d.kind !== 'retryOneLayer' && d.kind !== 'retryBudgetEveryLayer' && d.kind !== 'moreConsumers').map((d) => [d.kind as Exclude<FixKind, 'retryOneLayer' | 'retryBudgetEveryLayer' | 'moreConsumers'>, d] as const);
  it.each(oneSetting)('applyFix(%s) changes exactly one setting and leaves the original alone', (kind, d) => {
    const patched = applyFix(d, config, signals)!;
    expect(patched).not.toBeNull();
    const [path, value] = expectedChange[kind];
    expect(diffPaths(config, patched)).toEqual([path]);
    expect(path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], patched)).toBe(value);
    expect(config).toEqual(snapshot);
  });

  it('does not suggest retrying at one layer only, or a budget at every layer: only one layer retries already', () => {
    expect(applyFix(def('retryOneLayer'), config, signals)).toBeNull();
    expect(applyFix(def('retryBudgetEveryLayer'), config, signals)).toBeNull();
  });

  it('suggests every other catalog fix, in catalog order, each quoting its signal with real numbers', () => {
    const candidates = candidateFixes(config, signals, labels);
    expect(candidates.map((c) => c.id)).toEqual(['retry-budget', 'cap-retries', 'jitter-backoff', 'bound-queue', 'drop-expired', 'coalesce-misses', 'longer-timeout', 'add-instances']);
    const why = Object.fromEntries(candidates.map((c) => [c.id, c.why]));
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    expect(why['retry-budget']).toBe(`retries made up ${pct(signals.retryShare!.value)} of DB's load`);
    expect(why['cap-retries']).toBe(why['retry-budget']);
    expect(why['bound-queue']).toBe(`requests waited in DB's queue up to ${Math.round(signals.queueWaitOverTimeout!.value)}× longer than the App server's 1 s timeout`);
    expect(why['drop-expired']).toBe(`${pct(signals.wastedShare!.value)} of DB work was for requests whose caller had already given up`);
    const { before, during } = signals.cacheHitDrop!.value;
    expect(why['coalesce-misses']).toBe(`Cache hit rate fell from ${pct(before)} to ${pct(during)}`);
    expect(why['longer-timeout']).toBe("it is a common first instinct, so it's worth checking whether it actually helps");
    expect(why['add-instances']).toBe(COMMON_INSTINCT);
    expect(why['retry-budget']).toMatch(/^retries made up [5-9]\d% of DB's load$/);
    for (const c of candidates) {
      const def = FIX_CATALOG.find((d) => d.id === c.id)!;
      expect([c.name, c.short, c.pros, c.cons]).toEqual([def.title, def.short, def.pros, def.cons]);
      expect(c.config).toEqual(applyFix(FIX_CATALOG.find((d) => d.id === c.id)!, config, signals));
    }
    expect(candidates.find((c) => c.id === 'bound-queue')!.title).toBe('Bound the queue (load shedding): DB, at most 93 queued per instance');
    expect(candidates.find((c) => c.id === 'retry-budget')!.title).toBe('Retry budget of 10%: App server → DB');
    expect(candidates.find((c) => c.id === 'longer-timeout')!.title).toBe('Longer timeout (×3): App server → DB, 1 s → 3 s');
    expect(candidates.find((c) => c.id === 'add-instances')!.title).toBe('Add instances (+50%): App server, 4 → 6 instances');
    // What each one changes, in a plain sentence with this run's numbers.
    expect(Object.fromEntries(candidates.map((c) => [c.id, c.what]))).toEqual({
      'retry-budget': 'App server stops retrying DB once retries reach 10% of first attempts.',
      'cap-retries': 'App server retries a failed call to DB at most once (instead of 3 times).',
      'jitter-backoff': 'App server waits a random, growing delay before each retry to DB, so retries spread out instead of arriving together.',
      'bound-queue': 'DB lets at most 93 requests wait per instance and turns the rest away immediately.',
      'drop-expired': 'DB skips requests whose caller has already timed out, instead of doing work nobody will use.',
      'coalesce-misses': 'When several requests miss the cache for the same key at once, App server makes one read and shares the result.',
      'longer-timeout': 'App server waits up to 3 s for DB before giving up (instead of 1 s).',
      'add-instances': 'App server runs 6 instances instead of 4.',
    });
    // How each one works (the mechanism, not the outcome), with this config's names filled in.
    const how = Object.fromEntries(candidates.map((c) => [c.id, c.how]));
    expect(how['bound-queue']).toBe(
      'The database turns requests away when its short queue is full instead of letting them wait, so it spends its time on requests it can answer before the caller gives up.',
    );
    expect(how['retry-budget']).toMatch(/^Once repeats reach 10% of first tries, the app server stops asking the database again/);
    expect(how['coalesce-misses']).toMatch(/one goes to the database and the rest share its answer/);
    expect(how['add-instances']).toBe('The app server gets more servers; the database can handle no more than before.');
    for (const c of candidates) expect(c.how).not.toMatch(/[{}]/);
    expect(config).toEqual(snapshot);
  });

  it('leaves out fixes whose signal did not show up', () => {
    const { config: calm, analysis: calmAnalysis } = retryStormRun({ retries: 0 });
    const ids = candidateFixes(calm, calmAnalysis.signals, labels).map((c) => c.id);
    for (const id of ['retry-budget', 'cap-retries', 'jitter-backoff', 'retry-one-layer']) expect(ids).not.toContain(id);
  });
});

describe('on the default retry storm, every layer retrying (users\' apps 5, Load balancer 3, API 1)', { timeout: 60_000 }, () => {
  const { config, analysis } = analyzed(buildRunConfig(webChain, retryStorm));
  const candidates = candidateFixes(config, analysis.signals, labels);
  const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));

  it('suggests every fix, retrying at one layer included', () => {
    expect(candidates.map((c) => c.id)).toEqual(FIX_CATALOG.filter((d) => d.kind !== 'moreConsumers').map((d) => d.id)); // no queue here
    // Retries arrived mostly at the load balancer (users' repeats), but the DB is where the pile is.
    expect(analysis.signals.retryShare!.tier).toBe('gateway');
    expect(analysis.signals.queueWaitOverTimeout!.tier).toBe('db');
  });

  it('aims the retry fixes at the call into the DB, moving out to the load balancer to cap its 3 retries', () => {
    expect(Object.fromEntries(['retry-budget', 'cap-retries', 'jitter-backoff', 'retry-one-layer'].map((id) => [id, byId[id].title]))).toEqual({
      'retry-budget': 'Retry budget of 10%: App server → DB',
      'cap-retries': 'Cap retries at 1: Load balancer → App server',
      'jitter-backoff': 'Exponential backoff with full jitter: App server → DB',
      'retry-one-layer': 'Retry at one layer only: App server → DB',
    });
    expect(byId['cap-retries'].what).toBe('Load balancer retries a failed call to App server at most once (instead of 3 times).');
    expect(diffPaths(config, byId['cap-retries'].config)).toEqual(['tiers.0.downstream.retries']);
  });

  it('retrying at one layer keeps the app server → DB retry and turns off users\' and the load balancer\'s', () => {
    const fix = byId['retry-one-layer'];
    expect(fix.what).toBe("Only the App server asks the DB again (once); users' apps and the Load balancer no longer retry.");
    expect(fix.how).toBe(
      'The app server is the only one that asks the database again; every other layer passes errors straight back, so repeats no longer multiply from layer to layer.',
    );
    expect(fix.why).toBe(`retries made up ${Math.round(analysis.signals.retryShare!.value * 100)}% of Load balancer's load`);
    expect(diffPaths(config, fix.config).sort()).toEqual(['client.call.retries', 'tiers.0.downstream.retries']);
    expect([fix.config.client.call.retries, fix.config.tiers[0].downstream!.retries, fix.config.tiers[1].downstream!.retries]).toEqual([0, 0, 1]);
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

  it('retry fixes start at the call into the bottleneck and move out towards users to the first call they would change', () => {
    // The bottleneck is the DB (queue signal), whatever tier the retries arrived at.
    const s = signalsWith({ retryShare: at('api'), queueWaitOverTimeout: at('db') });
    expect(diffPaths(chain(), applyFix(def('retryBudget'), chain(), s)!)).toEqual(['tiers.0.downstream.retryBudget']);
    // App server → DB already retries at most once, so the cap moves out to the client's call.
    const c = chain();
    c.tiers[0].downstream!.retries = 1;
    expect(diffPaths(c, applyFix(def('capRetries'), c, s)!)).toEqual(['client.call.retries']);
    // A call that does not retry is skipped.
    c.tiers[0].downstream!.retries = 0;
    expect(diffPaths(c, applyFix(def('jitterBackoff'), c, s)!).sort()).toEqual(['client.call.backoffBaseMs', 'client.call.jitter']);
  });

  it('stops walking out towards users at a loop (which validation would reject)', () => {
    const loop: RunConfig = {
      ...chain(),
      tiers: [
        tier('a', { kind: 'fixed', ms: 1 }, { downstream: call('b', { retries: 0 }) }),
        tier('b', { kind: 'fixed', ms: 1 }, { downstream: call('a', { retries: 0 }) }),
        ...chain().tiers,
      ],
    };
    expect(applyFix(def('capRetries'), loop, signalsWith({ retryShare: at('b') }))).toBeNull();
  });

  it('does not apply a change that is already in place', () => {
    const c = chain();
    c.client.call = { ...c.client.call, retries: 0 }; // or it would move out to the client's call
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
    c.client.call = { ...c.client.call, retries: 0 };
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
    // Scaling the overloaded service itself adds room for the work, and `how` says so.
    expect(candidateFixes(noTimeout, signalsWith({ retryShare: at('svc') }), {}).find((c) => c.id === 'add-instances')!.how).toMatch(/^The svc gets more servers, so it can handle more work/);
    // A tier nothing calls has no call to change, so only adding instances applies (to itself).
    const orphan = { ...noTimeout, tiers: [...noTimeout.tiers, tier('spare', { kind: 'fixed', ms: 1 }, { instances: 4 })] };
    const s = signalsWith({ retryShare: at('spare'), queueWaitOverTimeout: at('spare') });
    expect(applyFix(def('longerTimeout'), orphan, s)).toBeNull();
    expect(applyFix(def('retryBudget'), orphan, s)).toBeNull();
    expect(applyFix(def('boundQueue'), orphan, s)).toBeNull();
    expect(applyFix(def('dropExpired'), orphan, signalsWith({ wastedShare: at('spare') }))).toBeNull(); // no caller to give up on it
    expect(applyFix(def('addInstances'), orphan, s)!.tiers[1].instances).toBe(6);
  });

  it('retrying at one layer keeps the call into the bottleneck and turns off every other retrying call', () => {
    const c = chain();
    c.tiers[0].cacheAside = { ...c.tiers[0].cacheAside!, retries: 2 };
    const fix = applyFix(def('retryOneLayer'), c, signalsWith({ retryShare: at('db') }))!;
    expect(diffPaths(c, fix).sort()).toEqual(['client.call.retries', 'tiers.0.cacheAside.retries']);
    expect([fix.client.call.retries, fix.tiers[0].cacheAside!.retries, fix.tiers[0].downstream!.retries]).toEqual([0, 0, 3]);
    const candidate = candidateFixes(c, signalsWith({ retryShare: at('db') }), {}).find((x) => x.id === 'retry-one-layer')!;
    expect(candidate.what).toBe("Only the api asks the db again (up to 3 times); users' apps and the api's cache lookups no longer retry.");
    expect(candidate.how).toMatch(/^The api is the only one that asks the db again;/);
  });

  it('retrying at one layer: the nearest retrying call in front of the bottleneck, else the innermost one', () => {
    // The bottleneck is the API: the client's call into it retries, so that one stays.
    const toApi = applyFix(def('retryOneLayer'), chain(), signalsWith({ retryShare: at('api') }))!;
    expect(diffPaths(chain(), toApi)).toEqual(['tiers.0.downstream.retries']);
    const what = candidateFixes(chain(), signalsWith({ retryShare: at('api') }), {}).find((x) => x.id === 'retry-one-layer')!.what;
    expect(what).toBe("Only users' apps ask the api again (up to 2 times); the api no longer retries.");
    // The bottleneck is the cache: the app server's lookups don't retry, so the nearest retrying call in front is the client's.
    expect(diffPaths(chain(), applyFix(def('retryOneLayer'), chain(), signalsWith({ queueWaitOverTimeout: at('cache') }))!)).toEqual(['tiers.0.downstream.retries']);
    // Nothing on the way to the bottleneck retries: the innermost retrying call (App server → DB) stays.
    const orphan = { ...chain(), tiers: [...chain().tiers, tier('spare', { kind: 'fixed', ms: 1 })] };
    const kept = applyFix(def('retryOneLayer'), orphan, signalsWith({ queueWaitOverTimeout: at('spare') }))!;
    expect(diffPaths(orphan, kept)).toEqual(['client.call.retries']);
    expect(candidateFixes(orphan, signalsWith({ retryShare: at('spare') }), {}).find((x) => x.id === 'retry-one-layer')!.what).toBe(
      "Only the api asks the db again (up to 3 times); users' apps no longer retry.",
    );
  });

  it('retrying at one layer can keep a cache-aside call when the cache is the bottleneck', () => {
    const c = chain();
    c.tiers[0].cacheAside = { ...c.tiers[0].cacheAside!, retries: 2 };
    const what = candidateFixes(c, signalsWith({ retryShare: at('cache') }), {}).find((x) => x.id === 'retry-one-layer')!.what;
    expect(what).toBe("Only the api's cache lookups ask the cache again (up to 2 times); users' apps and the api no longer retry.");
  });

  it('retrying at one layer needs at least two retrying calls and something overloaded', () => {
    const one = chain();
    one.client.call = { ...one.client.call, retries: 0 };
    expect(applyFix(def('retryOneLayer'), one, signalsWith({ retryShare: at('db') }))).toBeNull();
    expect(applyFix(def('retryOneLayer'), chain(), noSignals)).toBeNull();
    const onceEach = chain();
    onceEach.tiers[0].downstream!.retries = 1;
    expect(candidateFixes(onceEach, signalsWith({ retryShare: at('db') }), {}).find((x) => x.id === 'retry-one-layer')!.what).toBe(
      "Only the api asks the db again (once); users' apps no longer retry.",
    );
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

describe('fillNames', () => {
  it('fills in spoken names, capitalised at the start of a sentence', () => {
    expect(fillNames('{Caller} asks {target}; {Target} answers {caller}.', 'api', 'db', { api: 'App server', db: 'DB' })).toBe('The app server asks the database; The database answers the app server.');
  });
});

describe('describeSignal', () => {
  it('quotes idle saturation in seconds', () => {
    const s = signalsWith({ idleSaturation: { tier: 'api', value: 30 } });
    expect(describeSignal('idleSaturation', s, singleTier(1, { kind: 'fixed', ms: 1 }, 1000), (id) => id.toUpperCase())).toBe('API workers were all occupied but mostly idle for 30 s');
  });

  it('formats small queue-wait ratios with one decimal', () => {
    const c = singleTier(1, { kind: 'fixed', ms: 1 }, 1000, {}, { timeoutMs: 250 });
    expect(describeSignal('queueWaitOverTimeout', signalsWith({ queueWaitOverTimeout: { tier: 'svc', value: 2.345 } }), c, (id) => id)).toBe("requests waited in svc's queue up to 2.3× longer than the client's 250 ms timeout");
  });
});
