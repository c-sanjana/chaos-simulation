/**
 * Plain-data configuration for one simulation run.
 *
 * Everything here is serialisable (it crosses the Web Worker boundary), so it contains no classes
 * or functions. Units: times in milliseconds, traffic in requests per second.
 */

/** How long one unit of work takes to compute on a core. */
export type ServiceTime =
  | { kind: 'exponential'; meanMs: number }
  /** Long-tailed: parameterised by median and 99th percentile, which is how engineers describe latency. */
  | { kind: 'lognormal'; medianMs: number; p99Ms: number }
  | { kind: 'fixed'; ms: number };

/** How a caller calls a downstream tier: timeout, retries and backoff. */
export interface CallPolicy {
  /** Target tier id. */
  target: string;
  /** Caller gives up after this long. null = waits forever. */
  timeoutMs: number | null;
  /** Extra attempts after the first fails or times out. */
  retries: number;
  /** Delay before retry n is baseMs × 2^(n-1). 0 = retry immediately. */
  backoffBaseMs: number;
  /**
   * "Full jitter": the delay is drawn uniformly from [0, baseMs × 2^(n-1)].
   * ASSUMPTION: full jitter (as popularised by the AWS Architecture Blog) is the jitter variant modelled.
   */
  jitter: boolean;
}

export interface TierConfig {
  id: string;
  instances: number;
  /** Concurrent requests one instance can hold (thread pool / connection limit). */
  workersPerInstance: number;
  /** CPU cores per instance. A worker needs a free core to compute; waiting on a downstream call needs none. */
  coresPerInstance: number;
  /** Max queued (not yet started) requests per instance. null = unbounded. */
  queueLimit: number | null;
  service: ServiceTime;
  /** Downstream call made after computing (after a cache miss, if `cacheAside` is set), or null for a leaf tier. */
  downstream: CallPolicy | null;
  /**
   * Cache-aside: before calling `downstream`, look the request's key up in this cache tier. On a hit
   * the tier responds without calling downstream; on a miss (or if the cache call fails) it calls
   * downstream and, if that succeeds, writes the key to the cache.
   */
  cacheAside?: CallPolicy;
  /** Makes this tier a cache: it answers lookups from an LRU + TTL store instead of calling anything. */
  cache?: CacheConfig;
  /** Skip queued requests whose caller has already given up (deadline passed) instead of serving them. */
  dropExpired: boolean;
}

export interface CacheConfig {
  /** Max keys held. */
  capacity: number;
  /** Entries expire this long after being written. null = never. */
  ttlMs: number | null;
  /** Distinct keys requests ask for. */
  keys: number;
  /** Zipf popularity skew (0 = uniform; ~1 is typical of web workloads). */
  skew: number;
}

/**
 * An injected failure on a tier (or one of its instances) between startMs and endMs.
 * - slow: every compute takes `factor` × longer.
 * - dead: the tier refuses every attempt immediately (connection refused).
 * `flushAtEnd` empties a cache tier when the failure ends (it restarts cold).
 */
export interface Fault {
  tier: string;
  /** 0-based instance index; omit to affect every instance. */
  instance?: number;
  kind: 'slow' | 'dead';
  factor?: number;
  startMs: number;
  endMs: number;
  flushAtEnd?: boolean;
}

export interface ClientConfig {
  /** Open-loop Poisson arrival rate. */
  rps: number;
  /** How the client calls the entry tier. */
  call: CallPolicy;
}

export interface RunConfig {
  seed: number;
  durationMs: number;
  /** Width of a metrics bucket. Defaults to 1000 ms. */
  bucketMs?: number;
  client: ClientConfig;
  tiers: TierConfig[];
  faults?: Fault[];
}
