import { CacheStore, ZipfKeys } from './cache';
import { Stream, uniform } from './rng';
import { cheLruHitRate, ttlCacheHitRate, zipfProbabilities } from './theory';

describe('CacheStore', () => {
  it('hits only for stored, unexpired keys', () => {
    const c = new CacheStore(10, 100);
    expect(c.get(1, 0)).toBe(false);
    c.set(1, 0);
    expect(c.get(1, 50)).toBe(true);
    expect(c.get(1, 100)).toBe(false); // expired exactly at TTL
    expect(c.size).toBe(0); // expired entries are removed on access
  });

  it('evicts the least recently used key beyond capacity', () => {
    const c = new CacheStore(2, null);
    c.set(1, 0);
    c.set(2, 0);
    c.get(1, 1); // 1 becomes most recent
    c.set(3, 2); // evicts 2
    expect(c.get(2, 3)).toBe(false);
    expect(c.get(1, 3)).toBe(true);
    expect(c.get(3, 3)).toBe(true);
  });

  it('accepts an explicit expiry and can be cleared', () => {
    const c = new CacheStore(5, 1000);
    c.set(7, 0, 10);
    expect(c.get(7, 5)).toBe(true);
    expect(c.get(7, 10)).toBe(false);
    c.set(8, 0);
    c.clear();
    expect(c.size).toBe(0);
  });
});

describe('ZipfKeys', () => {
  it('matches the Zipf probabilities', () => {
    const z = new ZipfKeys(50, 1.1);
    const p = zipfProbabilities(50, 1.1);
    const counts = new Float64Array(50);
    const n = 200_000;
    for (let i = 0; i < n; i++) counts[z.sample(uniform(1, Stream.CacheKey, i))]++;
    for (const k of [0, 1, 5, 49]) expect(Math.abs(counts[k] / n - p[k])).toBeLessThan(0.004);
  });

  it('maps the extremes of (0, 1) to the first and last keys', () => {
    const z = new ZipfKeys(10, 1);
    expect(z.sample(1e-12)).toBe(0);
    expect(z.sample(1 - 1e-12)).toBe(9);
  });
});

/** Steady-state hit rate of the store under independent Zipf requests at `rps`. */
function simulateHitRate(store: CacheStore, keys: ZipfKeys, rps: number, requests: number): number {
  let hits = 0;
  const warmup = requests / 5;
  for (let i = 0; i < requests; i++) {
    const now = (i * 1000) / rps;
    const key = keys.sample(uniform(9, Stream.CacheKey, i));
    const hit = store.get(key, now);
    if (!hit) store.set(key, now);
    if (i >= warmup && hit) hits++;
  }
  return hits / (requests - warmup);
}

describe('cache hit rate emerges as theory predicts', () => {
  it('LRU without TTL matches the Che approximation', () => {
    for (const [keys, skew, capacity] of [[10_000, 1.1, 2000], [10_000, 0.8, 1000], [2_000, 1.2, 100]]) {
      const hit = simulateHitRate(new CacheStore(capacity, null), new ZipfKeys(keys, skew), 1000, 400_000);
      expect(Math.abs(hit - cheLruHitRate(zipfProbabilities(keys, skew), capacity))).toBeLessThan(0.01);
    }
  });

  it('TTL cache with room for every key matches the TTL-cache formula', () => {
    const keys = 5_000;
    for (const ttlMs of [1_000, 10_000]) {
      const hit = simulateHitRate(new CacheStore(keys, ttlMs), new ZipfKeys(keys, 1.0), 200, 400_000);
      expect(Math.abs(hit - ttlCacheHitRate(zipfProbabilities(keys, 1.0), 0.2, ttlMs))).toBeLessThan(0.01);
    }
  });
});
