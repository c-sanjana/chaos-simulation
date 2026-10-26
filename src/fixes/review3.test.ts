/**
 * Review 3 on the fixes: "Across the stack" on branches and behind queues, where retry fixes and
 * "add instances" are aimed, and the bound-queue wording when no queue fits.
 */
import type { Signals } from '../analysis/signals';
import { graphLabels, queueBranch } from '../analysis/testGraphs';
import { retryStormRun } from '../analysis/testRuns';
import { webChain } from '../data/topologies';
import { explainFix } from './explain';
import type { RunConfig, TierConfig } from '../engine/config';
import { call, tier } from '../engine/testConfigs';
import { acrossTheStack, retryAmplification } from './amplification';
import { applyFix, candidateFixes } from './candidates';
import { FIX_CATALOG, type FixKind } from './catalog';

const def = (kind: FixKind) => FIX_CATALOG.find((d) => d.kind === kind)!;
const noSignals: Signals = { overloaded: null, retryShare: null, wastedShare: null, queueWaitOverTimeout: null, idleSaturation: null, cacheHitDrop: null, queueBacklog: null };
const fixed = { kind: 'fixed', ms: 1 } as const;
const labels = { lb: 'Load balancer', orders: 'Orders service', reports: 'Reports service', db: 'DB', s1: 'App server', s2: 'App server 2' };

/** Users (5 retries) → a load balancer splitting over Orders and Reports, which both call the DB. */
const twoWays = (ordersRetries: number, reportsRetries = 2, share?: number): RunConfig => ({
  seed: 1,
  durationMs: 1000,
  client: { rps: 1, call: call('lb', { retries: 5 }) },
  tiers: [
    tier('lb', fixed, { downstream: call('orders', share ? { share } : {}), moreDownstream: [call('reports')], fanOut: 'split' }),
    tier('orders', fixed, { downstream: call('db', { timeoutMs: 1000, retries: ordersRetries }) }),
    tier('reports', fixed, { downstream: call('db', { timeoutMs: 1000, retries: reportsRetries }) }),
    tier('db', fixed),
  ],
});

describe('across the stack, on branches', () => {
  it('names the layers when the fix moves the worst way to another one', () => {
    expect(acrossTheStack(twoWays(3), twoWays(0), 'db', 'layer', labels)).toBe(
      "Only one layer changes. If every call fails, retries can multiply the calls reaching the database up to 24× (users' apps 6 × the Orders service 4). With this fix: up to 18× (users' apps 6 × the Reports service 3).",
    );
  });

  it('says what a fix off the worst way does on the ways through its call', () => {
    // Orders retries once, Reports 4 times: the worst way goes through Reports. Budget Orders' call.
    const before = twoWays(1, 4);
    const after: RunConfig = { ...before, tiers: before.tiers.map((t) => (t.id === 'orders' ? { ...t, downstream: { ...t.downstream!, retryBudget: 0.1 } } : t)) };
    expect(acrossTheStack(before, after, 'db', 'layer', labels)).toBe(
      "Only one layer changes. If every call fails, retries can multiply the calls reaching the database up to 30× (users' apps 6 × the Reports service 5). This fix changes the Orders service's calls to the database: up to 12× → 6.6× through them. The worst way stays at 30× (users' apps 6 × the Reports service 5).",
    );
    // A change that does nothing to any way (jitter) still says so plainly.
    const jitter: RunConfig = { ...before, tiers: before.tiers.map((t) => (t.id === 'orders' ? { ...t, downstream: { ...t.downstream!, jitter: true } } : t)) };
    expect(acrossTheStack(before, jitter, 'db', 'layer', labels)).toMatch(/This fix leaves that at 30×\.$/);
  });

  it('writes a numbered name and its factor apart', () => {
    const named = { ...labels, orders: 'App server', reports: 'App server 2' };
    expect(acrossTheStack(twoWays(1, 3), twoWays(1, 0), 'db', 'layer', named)).toMatch(/\(users' apps 6 × App server 2 \(4\)\)/);
  });

  it('starts again at a message queue: retries in front of it never reach what is behind it', () => {
    // Users retry 3 times, the front 2 times, the queue's consumers 2 times; the app server once.
    expect(retryAmplification(queueBranch(false), 'db')).toEqual({ factor: 3, layers: [{ owner: 'q', factor: 3 }] });
    // Also through the app server: that way is worse, and counts every layer on it.
    expect(retryAmplification(queueBranch(true), 'db')!.factor).toBe(4 * 3 * 2);
    expect(retryAmplification(queueBranch(false), 'q')!.factor).toBe(4 * 3);
  });

  it('finds the worst way through a wide mesh in one pass', () => {
    // Every part of a column calls every part of the next (4 wide, 6 deep: 4^6 ways); only the
    // entry's last call retries.
    const col = (k: number) => Array.from({ length: 4 }, (_, i) => `n${k}_${i}`);
    const calls = (ids: string[], lastRetries = 0) => ({ downstream: call(ids[0]), moreDownstream: ids.slice(1).map((id, i) => call(id, { retries: i === ids.length - 2 ? lastRetries : 0 })), fanOut: 'parallel' as const });
    const tiers: TierConfig[] = [tier('entry', fixed, calls(col(1), 5))];
    for (let k = 1; k < 6; k++) for (const id of col(k)) tiers.push(tier(id, fixed, calls(col(k + 1))));
    for (const id of col(6)) tiers.push(tier(id, fixed, { downstream: call('db') }));
    const mesh: RunConfig = { seed: 1, durationMs: 1000, client: { rps: 1, call: call('entry') }, tiers: [...tiers, tier('db', fixed)] };
    const worst = retryAmplification(mesh, 'db')!;
    expect(worst.factor).toBe(6);
    expect(worst.layers[1]).toEqual({ owner: 'entry', factor: 6 });
  });
});

describe('explanations', { timeout: 60_000 }, () => {
  it('a "longer timeout" that lengthened no timeout falls back to what was measured', () => {
    const { config, run, control, analysis } = retryStormRun({ retries: 3 });
    const same = { config, result: { run, control, analysis } };
    const text = explainFix('longerTimeout', false, same, same, Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label]))).text;
    expect(text).not.toMatch(/longer than the new/);
    expect(text).toMatch(/the work it can handle after the failure ended/);
  });
});

describe('where fixes are aimed', () => {
  it('a retry fix behind a queue changes the consumers’ call, never the callers in front of the queue', () => {
    const config = queueBranch(false);
    const signals: Signals = { ...noSignals, queueWaitOverTimeout: { tier: 'db', value: 3 }, retryShare: { tier: 'db', value: 0.5 } };
    const cap = candidateFixes(config, signals, graphLabels).find((c) => c.id === 'cap-retries')!;
    expect(cap.title).toBe('Cap retries at 1: Queue → DB');
    // Nothing in front of the queue retries towards the database: with the queue's call already capped, no cap applies.
    const capped: RunConfig = { ...config, tiers: config.tiers.map((t) => (t.id === 'q' ? { ...t, downstream: { ...t.downstream!, retries: 1 } } : t)) };
    expect(applyFix(def('capRetries'), capped, signals)).toBeNull();
  });

  it('"add instances" scales the overloaded pool when its caller is a load balancer or barely busy', () => {
    const config: RunConfig = {
      seed: 1,
      durationMs: 1000,
      client: { rps: 1, call: call('lb') },
      tiers: [tier('lb', fixed, { instances: 2, downstream: call('s1'), moreDownstream: [call('s2')], fanOut: 'split' }), tier('s1', fixed, { downstream: call('db') }), tier('s2', fixed), tier('db', fixed)],
    };
    // The app server pool behind the load balancer is the bottleneck: scale it, not the load balancer.
    const atPool = applyFix(def('addInstances'), config, { ...noSignals, queueWaitOverTimeout: { tier: 's1', value: 3 } })!;
    expect(atPool.tiers.find((t) => t.id === 's1')!.instances).toBe(2);
    expect(atPool.tiers.find((t) => t.id === 'lb')!.instances).toBe(2);
    // The database is: its caller (the app server) is scaled, as people instinctively do...
    const signals: Signals = { ...noSignals, queueWaitOverTimeout: { tier: 'db', value: 3 } };
    expect(applyFix(def('addInstances'), config, signals)!.tiers.find((t) => t.id === 's1')!.instances).toBe(2);
    // ...unless the run shows the app server barely busy: then the database itself.
    const series = (busy: number) => ({ busyWorkersAvg: [busy], workers: 100, arrivalsFirst: [10], arrivalsRetry: [0], retriesSent: [0] });
    const run = { client: { sent: [10] }, tiers: { lb: series(50), s1: series(10), db: series(100) } } as never;
    const scaled = applyFix(def('addInstances'), config, signals, run)!;
    expect(scaled.tiers.find((t) => t.id === 'db')!.instances).toBe(2);
    expect(scaled.tiers.find((t) => t.id === 's1')!.instances).toBe(1);
    expect(applyFix(def('addInstances'), config, signals, { client: { sent: [10] }, tiers: { s1: series(80) } } as never)!.tiers.find((t) => t.id === 's1')!.instances).toBe(2);
  });

  it('"bound the queue" says plainly when no request should wait at all', () => {
    // A 50 ms caller and a database that can serve far fewer than its workers in that time.
    const config: RunConfig = {
      seed: 1,
      durationMs: 1000,
      client: { rps: 1, call: call('api') },
      tiers: [tier('api', fixed, { downstream: call('db', { timeoutMs: 50 }) }), tier('db', { kind: 'fixed', ms: 20 }, { workersPerInstance: 64, coresPerInstance: 1 })],
    };
    const fix = candidateFixes(config, { ...noSignals, queueWaitOverTimeout: { tier: 'db', value: 9 } }, { api: 'API', db: 'DB' }).find((c) => c.id === 'bound-queue')!;
    expect(fix.config.tiers.find((t) => t.id === 'db')!.queueLimit).toBe(0);
    expect(fix.title).toBe('Bound the queue (load shedding): DB, no queue');
    expect(fix.what).toBe("DB turns away every request it can't start at once, instead of letting it wait.");
    expect(fix.how).toBe("The database turns away any request it can't start at once instead of letting it wait, so it spends its time on requests it can answer before the caller gives up.");
  });

  it('quotes the part the struggling-part signal names', () => {
    const config = twoWays(1);
    const signals: Signals = { ...noSignals, overloaded: { tier: 'db', value: { load: 3.4, sustained: true } } };
    const timeout = candidateFixes(config, signals, labels).find((c) => c.id === 'longer-timeout')!;
    expect(timeout.title).toMatch(/→ DB,/);
    // During the failure only (not still over afterwards), the other signals choose.
    const during: Signals = { ...signals, overloaded: { tier: 'db', value: { load: 3.4, sustained: false } }, retryShare: { tier: 'orders', value: 0.5 } };
    expect(candidateFixes(config, during, labels).find((c) => c.id === 'add-instances')!.title).toBe('Add instances (+50%): Orders service, 1 → 2 instances');
  });
});
