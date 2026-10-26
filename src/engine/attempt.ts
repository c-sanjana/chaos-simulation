/**
 * One call to one tier: created by a caller (the client or an upstream tier) for every try.
 *
 * Lifecycle: queued → running → waiting (on a downstream call) → ok | failed,
 * or, without ever computing: rejected (queue full) | dropped (with `dropExpired`: the caller's
 * deadline passed while it waited for a worker, or for a core). At a queue tier, `rejected` also
 * follows computing when the queue is full (see MessageQueue).
 * Independently of that, the caller may give up (`abandoned`); unless the tier drops it as above,
 * the tier keeps working on the attempt regardless, and that work is "wasted" (see TierMetrics).
 */
export type AttemptState = 'queued' | 'running' | 'waiting' | FinalState;
export type FinalState = 'ok' | 'failed' | 'rejected' | 'dropped';

export class Attempt {
  state: AttemptState = 'queued';
  /** True once the caller stopped waiting (timed out). */
  abandoned = false;
  /**
   * A first try at this tier made on behalf of a repeat further up (the caller is handling a retry,
   * or a request that was itself sent for one). Counted with first attempts here, but caused by
   * retrying: the load chart counts these in its "Retries (from any layer)" band.
   */
  fromRepeat = false;
  /** Compute time spent on this attempt so far. */
  computeMs = 0;
  /** For cache lookups: the key asked for, and whether it was found. */
  key = -1;
  hit = false;

  constructor(
    readonly requestId: number,
    /** Identifies which retry this is at every layer above; keys the attempt's random values. */
    readonly pathHash: number,
    readonly isRetry: boolean,
    readonly arrivedAtMs: number,
    /** Absolute time the caller gives up. Infinity if it waits forever. */
    readonly deadlineMs: number,
    private readonly onResponse: (ok: boolean, attempt: Attempt) => void,
  ) {}

  /** The tier is done with this attempt. The caller ignores the response if it already gave up. */
  respond(state: FinalState): void {
    this.state = state;
    this.onResponse(state === 'ok', this);
  }
}
