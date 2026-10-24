/** Coalesced cache misses ("single flight"): concurrent misses for one key share one downstream read. */
import type { RunConfig } from './config';
import { runSimulation } from './run';
import { STATUS_FAILED, STATUS_OK, type RunResult } from './result';
import { call, tier } from './testConfigs';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function expectConservation(r: RunResult) {
  for (const t of Object.values(r.tiers)) {
    const x = t.totals;
    expect(x.arrivals).toBe(x.ok + x.failed + x.rejected + x.dropped + x.inFlightAtEnd);
    expect(x.inFlightAtEnd).toBeGreaterThanOrEqual(0);
  }
}

/**
 * A cache of 200 hot keys in front of a slow-ish DB (100 ms median reads). The cache is down for
 * 5 s and restarts empty: every lookup misses, and many requests want the same hot keys at once.
 */
function coldCacheBurst(coalesceMisses: boolean, dbOverrides: Partial<RunConfig['tiers'][number]> = {}, apiDbTimeoutMs: number | null = null): RunConfig {
  return {
    seed: 5,
    durationMs: 45_000,
    client: { rps: 1000, call: call('api') },
    tiers: [
      tier('api', { kind: 'fixed', ms: 1 }, {
        instances: 2,
        workersPerInstance: 2000,
        cacheAside: call('cache', { timeoutMs: 50 }),
        downstream: call('db', { timeoutMs: apiDbTimeoutMs }),
        coalesceMisses,
      }),
      tier('cache', { kind: 'fixed', ms: 0.2 }, { workersPerInstance: 500, cache: { capacity: 200, ttlMs: null, keys: 200, skew: 1.0 } }),
      tier('db', { kind: 'lognormal', medianMs: 100, p99Ms: 400 }, { workersPerInstance: 1000, coresPerInstance: 1000, ...dbOverrides }),
    ],
    faults: [{ tier: 'cache', kind: 'dead', startMs: 30_000, endMs: 35_000, flushAtEnd: true }],
  };
}

describe('coalesced cache misses', { timeout: 30_000 }, () => {
  const plain = runSimulation(coldCacheBurst(false));
  const coalesced = runSimulation(coldCacheBurst(true));
  const dbReads = (r: RunResult) => sum(r.tiers.db.arrivalsFirst.slice(30, 40));

  it('during a cold-cache burst, sends far fewer reads to the DB', () => {
    expect(dbReads(plain)).toBeGreaterThan(4000); // ~1000/s while the cache is down
    expect(dbReads(coalesced)).toBeLessThan(0.5 * dbReads(plain));
  });

  it('every request still completes, and succeeds', () => {
    for (const r of [plain, coalesced]) {
      const { status, arrivalMs } = r.client.requests;
      // Requests arriving in the run's last second may still be in flight when it ends.
      const judged = Array.from(status).filter((_, i) => arrivalMs[i] < 44_000);
      expect(judged.every((s) => s === STATUS_OK)).toBe(true);
      expect(r.tiers.api.totals.failed).toBe(0);
      expect(r.tiers.api.totals.inFlightAtEnd).toBeLessThan(1000);
    }
  });

  it('conserves attempts at every tier', () => {
    expectConservation(plain);
    expectConservation(coalesced);
  });

  it('sees identical traffic and changes nothing while the cache is warm', () => {
    expect(coalesced.client.requests.arrivalMs).toEqual(plain.client.requests.arrivalMs);
    // Before the outage the warm cache holds every key, so nothing misses and nothing coalesces.
    expect(sum(plain.tiers.db.arrivalsFirst.slice(0, 30))).toBe(0);
    expect(coalesced.client.requests.latencyMs.slice(0, 25_000)).toEqual(plain.client.requests.latencyMs.slice(0, 25_000));
  });

  it('waiters share the reading attempt\'s outcome: a failed read fails every waiter', () => {
    // The DB is slower than the app server's 50 ms timeout, so every read fails (and nothing is written back).
    const failing = runSimulation(coldCacheBurst(true, { service: { kind: 'fixed', ms: 200 } }, 50));
    const plainFailing = runSimulation(coldCacheBurst(false, { service: { kind: 'fixed', ms: 200 } }, 50));
    const { status, arrivalMs } = failing.client.requests;
    for (let i = 0; i < status.length; i++) {
      if (arrivalMs[i] >= 30_000 && arrivalMs[i] < 40_000) expect(status[i]).toBe(STATUS_FAILED);
    }
    // Reads now last only 50 ms (the timeout), so fewer misses overlap than in the burst above.
    expect(sum(failing.tiers.db.arrivalsFirst)).toBeLessThan(0.75 * sum(plainFailing.tiers.db.arrivalsFirst));
    expect(sum(failing.tiers.cache.hits.slice(36, 45))).toBe(0); // nothing was ever written back
    expectConservation(failing);
  });

  it('is deterministic', () => {
    expect(runSimulation(coldCacheBurst(true))).toEqual(coalesced);
  });
});
