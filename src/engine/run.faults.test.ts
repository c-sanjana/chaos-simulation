/** Faults (slow, dead, per-instance, cache flush) and cache-aside behaviour. */
import type { RunConfig } from './config';
import { runSimulation } from './run';
import { STATUS_FAILED, STATUS_OK, type RunResult } from './result';
import { call, singleTier, tier } from './testConfigs';
import { cheLruHitRate, zipfProbabilities } from './theory';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Client outcomes of requests that arrived in [fromMs, toMs). */
function outcomes(r: RunResult, fromMs: number, toMs: number) {
  const { arrivalMs, status, latencyMs } = r.client.requests;
  const picked: Array<{ status: number; latency: number }> = [];
  arrivalMs.forEach((t, i) => {
    if (t >= fromMs && t < toMs) picked.push({ status: status[i], latency: latencyMs[i] });
  });
  return picked;
}

function cached(cacheOverrides: Partial<NonNullable<RunConfig['tiers'][number]['cache']>> = {}, faults: RunConfig['faults'] = []): RunConfig {
  return {
    seed: 11,
    durationMs: 120_000,
    client: { rps: 200, call: call('api') },
    tiers: [
      tier('api', { kind: 'fixed', ms: 1 }, { workersPerInstance: 500, cacheAside: call('cache', { timeoutMs: 50 }), downstream: call('db') }),
      tier('cache', { kind: 'fixed', ms: 0.2 }, { workersPerInstance: 500, cache: { capacity: 500, ttlMs: null, keys: 5000, skew: 1.0, ...cacheOverrides } }),
      tier('db', { kind: 'fixed', ms: 5 }, { workersPerInstance: 500 }),
    ],
    faults,
  };
}

describe('faults', () => {
  it('slow multiplies compute time while active, then returns to normal', () => {
    const r = runSimulation({
      ...singleTier(20, { kind: 'fixed', ms: 10 }, 60_000, { workersPerInstance: 50 }),
      faults: [{ tier: 'svc', kind: 'slow', factor: 5, startMs: 20_000, endMs: 30_000 }],
    });
    for (const o of outcomes(r, 21_000, 29_000)) expect(o.latency).toBeCloseTo(50, 6);
    for (const o of outcomes(r, 31_000, 59_000)) expect(o.latency).toBeCloseTo(10, 6);
  });

  it('dead refuses immediately: requests fail fast during the outage only', () => {
    const r = runSimulation({
      ...singleTier(20, { kind: 'fixed', ms: 10 }, 60_000, { workersPerInstance: 50 }),
      faults: [{ tier: 'svc', kind: 'dead', startMs: 20_000, endMs: 30_000 }],
    });
    const during = outcomes(r, 20_000, 30_000);
    expect(during.length).toBeGreaterThan(100);
    for (const o of during) {
      expect(o.status).toBe(STATUS_FAILED);
      expect(o.latency).toBe(0);
    }
    for (const o of outcomes(r, 30_001, 59_000)) expect(o.status).toBe(STATUS_OK);
  });

  it('an instance-level fault only hits the traffic routed to that instance', () => {
    const r = runSimulation({
      ...singleTier(100, { kind: 'fixed', ms: 1 }, 60_000, { instances: 4, workersPerInstance: 20 }),
      faults: [{ tier: 'svc', instance: 2, kind: 'dead', startMs: 0, endMs: 60_000 }],
    });
    const failedShare = sum(r.client.failed) / (sum(r.client.ok) + sum(r.client.failed));
    expect(failedShare).toBeCloseTo(0.25, 2); // round-robin sends exactly every 4th attempt there
  });
});

describe('cache-aside', () => {
  it('serves hits from the cache and only sends misses to the DB', () => {
    const r = runSimulation(cached());
    const t = r.tiers;
    expect(sum(t.db.arrivalsFirst)).toBe(t.cache.totals.ok - sum(t.cache.hits));
    expect(t.api.totals.ok).toBe(t.api.totals.arrivals - t.api.totals.inFlightAtEnd);
  });

  it('the emergent hit rate matches the Che approximation for LRU', () => {
    const r = runSimulation(cached());
    const hitRate = sum(r.tiers.cache.hits) / r.tiers.cache.totals.ok;
    expect(Math.abs(hitRate - cheLruHitRate(zipfProbabilities(5000, 1.0), 500))).toBeLessThan(0.01);
  });

  it('a cache outage sends every lookup to the DB, and a restart comes back cold', () => {
    const r = runSimulation(cached({}, [{ tier: 'cache', kind: 'dead', startMs: 40_000, endMs: 50_000, flushAtEnd: true }]));
    const c = r.tiers.cache;
    const hitRate = (b: number) => c.hits[b] / Math.max(1, c.ok[b]);
    expect(hitRate(30)).toBeGreaterThan(0.5); // warm before
    expect(c.ok[45]).toBe(0); // down: no lookups answered…
    expect(r.tiers.db.arrivalsFirst[45]).toBeGreaterThan(190); // …so everything hits the DB
    // Restarted empty: the hottest keys refill within the first second (Zipf), so the hit rate dips
    // well below the warm rate rather than to zero, then climbs back as colder keys refill.
    expect(hitRate(50)).toBeLessThan(0.75 * hitRate(30));
    expect(hitRate(110)).toBeGreaterThan(hitRate(50));
  });

  it('keys written while the cache is down are lost', () => {
    const r = runSimulation(cached({}, [{ tier: 'cache', kind: 'dead', startMs: 0, endMs: 120_000 }]));
    expect(sum(r.tiers.cache.hits)).toBe(0);
    expect(sum(r.client.ok)).toBe(r.client.requests.status.filter((s) => s === STATUS_OK).length);
  });

  it('a failed lookup with no downstream would be a failure (guarded by validation)', () => {
    expect(() => runSimulation({ ...cached(), tiers: cached().tiers.map((t) => (t.id === 'api' ? { ...t, downstream: null } : t)) })).toThrow(/no downstream/);
  });
});
