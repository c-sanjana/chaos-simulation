import type { TopologyPreset } from './types';

/**
 * A classic web app: Client → Load balancer → API → DB, with a cache-aside cache beside the API.
 *
 * Numbers are illustrative but in realistic ranges (PLAN.md: "intuition, not prediction"):
 * - Load balancer and API run thread pools of a few hundred workers per instance (e.g. Tomcat's
 *   default of 200), so many requests can be waiting on the DB at once.
 * - The DB has 4 cores and a ~25 ms mean query time: about 160 queries/s of capacity, sized so
 *   normal cache-miss traffic keeps it well below saturation.
 * - Timeouts shrink going down the stack (client 3 s > load balancer→API 2 s > API→DB 1 s), a common
 *   configuration.
 * - Every layer retries, and differently: users' clients retry 5 times, the load balancer retries the API
 *   3 times and the API retries the DB once (user decision, 2026-10-24). One slow DB answer can
 *   therefore come back as many requests; nested timeouts limit how many (PLAN.md).
 */
export const webChain: TopologyPreset = {
  id: 'web-chain',
  name: 'Web app with cache',
  clientCall: { target: 'lb', timeoutMs: 3000, retries: 5, backoffBaseMs: 100, jitter: false },
  tiers: [
    {
      id: 'lb',
      instances: 2,
      workersPerInstance: 256,
      coresPerInstance: 4,
      queueLimit: null,
      service: { kind: 'lognormal', medianMs: 1, p99Ms: 5 },
      downstream: { target: 'api', timeoutMs: 2000, retries: 3, backoffBaseMs: 50, jitter: false },
      dropExpired: false,
    },
    {
      id: 'api',
      instances: 4,
      workersPerInstance: 200,
      coresPerInstance: 4,
      queueLimit: null,
      service: { kind: 'lognormal', medianMs: 4, p99Ms: 20 },
      cacheAside: { target: 'cache', timeoutMs: 100, retries: 0, backoffBaseMs: 0, jitter: false },
      downstream: { target: 'db', timeoutMs: 1000, retries: 1, backoffBaseMs: 50, jitter: false },
      dropExpired: false,
    },
    {
      id: 'cache',
      instances: 1,
      workersPerInstance: 512,
      coresPerInstance: 8,
      queueLimit: null,
      service: { kind: 'lognormal', medianMs: 0.3, p99Ms: 1.5 },
      downstream: null,
      dropExpired: false,
      cache: { capacity: 2000, ttlMs: 60_000, keys: 10_000, skew: 1.0 },
    },
    {
      id: 'db',
      instances: 1,
      workersPerInstance: 64,
      coresPerInstance: 4,
      queueLimit: null,
      service: { kind: 'lognormal', medianMs: 20, p99Ms: 100 },
      downstream: null,
      dropExpired: false,
    },
  ],
  layout: {
    client: { label: 'Client', col: 1, row: 3 },
    // The same component the builder calls a load balancer (user decision: one name everywhere).
    lb: { label: 'Load balancer', col: 3, row: 3 },
    // The tier runs the app's own code; "App server" is plainer for newcomers than "API" (user decision).
    api: { label: 'App server', col: 5, row: 3 },
    cache: { label: 'Cache', col: 5, row: 1 },
    db: { label: 'DB', col: 7, row: 3 },
  },
};

export const topologies: Record<string, TopologyPreset> = { [webChain.id]: webChain };
