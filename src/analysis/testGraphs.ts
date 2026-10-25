import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { Fault, RunConfig, TierConfig } from '../engine/config';
import { call, tier } from '../engine/testConfigs';

/** Test helper: branched systems for the analysis and fix tests. Not used by the app. */

export const graphLabels: Record<string, string> = {
  ...Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label])),
  search: 'Search service',
  lb: 'Load balancer',
  blue: 'Blue pool',
  green: 'Green pool',
  orders: 'Orders service',
  reports: 'Reports service',
  q: 'Queue',
  front: 'Front',
};

/**
 * The web app with a second call behind the app server: on a cache miss it asks the DB and a
 * search service (made like the DB, a little faster), one after the other or at once. Default
 * retries (users 5, lb 3, app server 1 on each call); the DB slows 8× for 5 s at 30 s.
 */
export function webWithSearch(fanOut: 'sequence' | 'parallel', rps = 200, faults?: Fault[]): RunConfig {
  const base = buildRunConfig(webChain, retryStorm, { rps });
  const db = base.tiers.find((t) => t.id === 'db')!;
  const search: TierConfig = { ...db, id: 'search', service: { kind: 'lognormal', medianMs: 10, p99Ms: 50 } };
  return {
    ...base,
    tiers: [
      ...base.tiers.map((t) => (t.id === 'api' ? { ...t, moreDownstream: [{ ...t.downstream!, target: 'search' }], fanOut } : t)),
      search,
    ],
    ...(faults ? { faults } : {}),
  };
}

/**
 * Users → load balancer splitting over two identical pools (blue `shareBlue`, green 1), which do
 * the work themselves. The load balancer retries each pool `retries` times; users retry
 * `clientRetries` times. The green pool goes down for 5 s at 30 s.
 */
export function splitPools(o: { shareBlue?: number; retries?: number; clientRetries?: number; rps?: number; faults?: Fault[] } = {}): RunConfig {
  const pool = (id: string) => tier(id, { kind: 'lognormal', medianMs: 20, p99Ms: 100 }, { instances: 1, workersPerInstance: 64, coresPerInstance: 4 });
  return {
    seed: 42,
    durationMs: 120_000,
    client: { rps: o.rps ?? 200, call: call('lb', { timeoutMs: 3000, retries: o.clientRetries ?? 0, backoffBaseMs: 100 }) },
    tiers: [
      tier('lb', { kind: 'lognormal', medianMs: 1, p99Ms: 5 }, {
        instances: 2,
        workersPerInstance: 256,
        coresPerInstance: 4,
        downstream: call('blue', { timeoutMs: 1000, retries: o.retries ?? 2, backoffBaseMs: 50, share: o.shareBlue ?? 1 }),
        moreDownstream: [call('green', { timeoutMs: 1000, retries: o.retries ?? 2, backoffBaseMs: 50 })],
        fanOut: 'split',
      }),
      pool('blue'),
      pool('green'),
    ],
    faults: o.faults ?? [{ tier: 'green', kind: 'dead', startMs: 30_000, endMs: 35_000 }],
  };
}

/**
 * Fan-in: users → lb, which asks Orders and Reports at once; both call the DB, Orders with
 * a 1.5 s timeout, Reports with 800 ms. The DB slows `factor`× for 5 s at 30 s.
 */
export function fanIn(o: { rps?: number; factor?: number; reportsRetries?: number } = {}): RunConfig {
  const app = (id: string, timeoutMs: number, retries: number) =>
    tier(id, { kind: 'lognormal', medianMs: 4, p99Ms: 20 }, { instances: 2, workersPerInstance: 200, coresPerInstance: 4, downstream: call('db', { timeoutMs, retries, backoffBaseMs: 50 }) });
  return {
    seed: 42,
    durationMs: 120_000,
    client: { rps: o.rps ?? 60, call: call('lb', { timeoutMs: 3000, retries: 0 }) },
    tiers: [
      tier('lb', { kind: 'lognormal', medianMs: 1, p99Ms: 5 }, { instances: 2, workersPerInstance: 256, coresPerInstance: 4, downstream: call('orders', { timeoutMs: 2000 }), moreDownstream: [call('reports', { timeoutMs: 2000 })], fanOut: 'parallel' }),
      app('orders', 1500, 1),
      app('reports', 800, o.reportsRetries ?? 1),
      tier('db', { kind: 'lognormal', medianMs: 20, p99Ms: 100 }, { workersPerInstance: 64, coresPerInstance: 4 }),
    ],
    faults: [{ tier: 'db', kind: 'slow', factor: o.factor ?? 8, startMs: 30_000, endMs: 35_000 }],
  };
}

/**
 * Users → front, which (in parallel) stores a message in a queue and asks the app server; the
 * queue's consumers call the DB. With `apiToDb`, the app server calls the DB too (so users reach
 * the DB both through the queue and not). The DB goes down for 5 s at 30 s.
 */
export function queueBranch(apiToDb: boolean): RunConfig {
  const leaf = (id: string, overrides: Partial<TierConfig> = {}) => tier(id, { kind: 'lognormal', medianMs: 5, p99Ms: 25 }, { workersPerInstance: 64, coresPerInstance: 4, ...overrides });
  return {
    seed: 42,
    durationMs: 120_000,
    client: { rps: 50, call: call('front', { timeoutMs: 3000, retries: 3, backoffBaseMs: 100 }) },
    tiers: [
      leaf('front', { workersPerInstance: 256, downstream: call('q', { timeoutMs: 1000, retries: 2 }), moreDownstream: [call('api', { timeoutMs: 1000, retries: 2 })], fanOut: 'parallel' }),
      tier('q', { kind: 'fixed', ms: 1 }, { workersPerInstance: 64, queue: { maxDepth: 10_000, consumers: 8 }, downstream: call('db', { timeoutMs: 500, retries: 2, backoffBaseMs: 50 }) }),
      leaf('api', apiToDb ? { downstream: call('db', { timeoutMs: 500, retries: 1, backoffBaseMs: 50 }) } : {}),
      leaf('db'),
    ],
    faults: [{ tier: 'db', kind: 'dead', startMs: 30_000, endMs: 35_000 }],
  };
}
