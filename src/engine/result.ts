/**
 * Plain-data output of one simulation run. Arrays are indexed by metrics bucket
 * (bucket i covers [i × bucketMs, (i+1) × bucketMs)).
 */

export interface TierSeries {
  id: string;
  /** Totals across instances, for normalising the averages below. */
  workers: number;
  cores: number;
  /** Attempts arriving at this tier, split by whether the caller was retrying. */
  arrivalsFirst: number[];
  arrivalsRetry: number[];
  /** Responses sent: success, failure after processing, rejected (queue full), dropped (expired before computing, see `dropExpired`). */
  ok: number[];
  failed: number[];
  rejected: number[];
  dropped: number[];
  /** As a caller: downstream calls that timed out, and retries this tier sent. */
  timeouts: number[];
  retriesSent: number[];
  /** Latency of successful responses, measured from arrival at this tier. NaN when there were none. */
  latencyMeanMs: number[];
  latencyP50Ms: number[];
  latencyP99Ms: number[];
  /** Time-averaged levels within each bucket. */
  queueAvg: number[];
  busyWorkersAvg: number[];
  busyCoresAvg: number[];
  /** Compute time spent on attempts whose caller had already given up. */
  wastedMs: number[];
  /** Cache tiers only (zeros elsewhere): lookups answered from the cache. Hit rate = hits / ok. */
  hits: number[];
  totals: {
    arrivals: number;
    ok: number;
    failed: number;
    rejected: number;
    dropped: number;
    inFlightAtEnd: number;
    latencySumMs: number;
    latencyCount: number;
    /** Time integrals (level × ms) over the whole run. */
    queueArea: number;
    busyWorkersArea: number;
    busyCoresArea: number;
    computeMs: number;
    wastedMs: number;
  };
  peaks: { busyWorkersPerInstance: number; busyCoresPerInstance: number; queuePerInstance: number };
}

/** Outcome of each user request, by request id. Used to compare a run against its no-failure control. */
export interface RequestOutcomes {
  arrivalMs: Float64Array;
  /** Time from arrival to final success/failure. NaN while unfinished. */
  latencyMs: Float64Array;
  /** 1 = succeeded, 0 = failed, 2 = unfinished when the run ended. */
  status: Uint8Array;
}

export interface ClientSeries {
  sent: number[];
  ok: number[];
  failed: number[];
  latencyP50Ms: number[];
  latencyP99Ms: number[];
  requests: RequestOutcomes;
}

export interface RunResult {
  durationMs: number;
  bucketMs: number;
  tiers: Record<string, TierSeries>;
  client: ClientSeries;
  eventsProcessed: number;
}

export const STATUS_FAILED = 0;
export const STATUS_OK = 1;
export const STATUS_UNFINISHED = 2;
