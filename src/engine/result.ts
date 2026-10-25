/**
 * Plain-data output of one simulation run. Arrays are indexed by metrics bucket
 * (bucket i covers [i × bucketMs, (i+1) × bucketMs)).
 */

export interface TierSeries {
  id: string;
  /** Totals across instances, for normalising the averages below. */
  workers: number;
  cores: number;
  /** Queue tiers: the consumer pool's size (0 elsewhere). */
  consumers: number;
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
  /**
   * Of `arrivalsFirst`: first tries here made on behalf of a repeat further up (a retry by a caller
   * above, or a request sent for one). arrivalsFirst − this = load from users' own first tries.
   */
  arrivalsFromRepeats: number[];
  /**
   * Queue tiers only (zeros elsewhere). A queue tier's `ok` counts messages stored (producers
   * answered), `rejected` producers turned away because the queue was full.
   * - backlogAvg: time-averaged messages waiting (stored, not yet taken by a consumer).
   * - busyConsumersAvg: time-averaged consumers handling a message.
   * - delivered / deadLettered: messages whose downstream call finally succeeded / failed after
   *   its retries (dropped), counted when the call finished.
   * - messageAgeMeanMs / messageAgeP99Ms: time from being stored to being delivered, for messages
   *   delivered in the bucket. NaN when none were. The p99 is read from the latency histogram, so
   *   ages beyond 120 s all read as about 120 s; the mean is exact.
   */
  backlogAvg: number[];
  busyConsumersAvg: number[];
  delivered: number[];
  deadLettered: number[];
  messageAgeMeanMs: number[];
  messageAgeP99Ms: number[];
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
    /**
     * Queue tiers (0 elsewhere). Every stored message (= `ok`) ends up in exactly one of
     * delivered, deadLettered, backlogAtEnd or inProcessingAtEnd.
     */
    delivered: number;
    deadLettered: number;
    /** Messages waiting × ms over the whole run. */
    backlogArea: number;
    busyConsumersArea: number;
    backlogAtEnd: number;
    /** Messages a consumer was still handling when the run ended. */
    inProcessingAtEnd: number;
  };
  /** `backlog` is the queue tier's highest number of messages waiting (0 for other tiers). */
  peaks: { busyWorkersPerInstance: number; busyCoresPerInstance: number; queuePerInstance: number; backlog: number };
  /**
   * As a caller: what each of its calls sent, one entry per call in the order it makes them (its
   * cache lookups first, then its downstream calls, `downstream` then `moreDownstream`): the tier
   * called, first tries and retries per bucket. A queue tier's entry counts its consumers' calls.
   * With fan-in (two parts calling one database) this tells which caller sent what; `arrivals*`
   * at the database only tell the sum. Empty for a tier that calls nothing. Optional so that
   * hand-made results in tests may leave it out; a run always fills it.
   */
  calls?: Array<{ target: string; first: number[]; retries: number[] }>;
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
