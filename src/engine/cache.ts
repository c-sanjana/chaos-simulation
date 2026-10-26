/**
 * The cache's contents: real keys with LRU eviction and a TTL per entry.
 *
 * The hit rate is not a setting: it emerges from capacity, TTL, how many distinct keys are requested
 * and how skewed their popularity is (see ZipfKeys below and the accuracy tests against the Che
 * approximation and the TTL-cache formula in theory.ts).
 */
export class CacheStore {
  /** key → expiry time. Map iteration order is insertion order, so the first key is least recently used. */
  private readonly entries = new Map<number, number>();

  constructor(
    readonly capacity: number,
    /** null = entries never expire. */
    readonly ttlMs: number | null,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * Looks up `key`. A hit refreshes its LRU position but not its expiry.
   * ASSUMPTION: TTLs are not renewed by reads (the common "expire N seconds after write" behaviour).
   */
  get(key: number, nowMs: number): boolean {
    const expiry = this.entries.get(key);
    if (expiry === undefined) return false;
    this.entries.delete(key);
    if (expiry <= nowMs) return false;
    this.entries.set(key, expiry);
    return true;
  }

  /** Stores `key`, evicting least-recently-used keys beyond capacity. */
  set(key: number, nowMs: number, expiryMs = this.ttlMs === null ? Infinity : nowMs + this.ttlMs): void {
    this.entries.delete(key);
    this.entries.set(key, expiryMs);
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  /** Empties the cache (a restart). */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * Draws request keys from a Zipf distribution over `keys` keys (key 0 most popular) by inverse CDF.
 */
export class ZipfKeys {
  private readonly cdf: Float64Array;

  constructor(readonly keys: number, readonly skew: number) {
    this.cdf = new Float64Array(keys);
    let total = 0;
    for (let i = 0; i < keys; i++) total += 1 / (i + 1) ** skew;
    let running = 0;
    for (let i = 0; i < keys; i++) {
      running += 1 / (i + 1) ** skew / total;
      this.cdf[i] = running;
    }
    this.cdf[keys - 1] = 1;
  }

  /** Maps a uniform draw in (0, 1) to a key. */
  sample(u: number): number {
    let lo = 0;
    let hi = this.keys - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.cdf[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
