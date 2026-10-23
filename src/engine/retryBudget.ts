/**
 * A retry budget: the token bucket that Finagle, gRPC (retry throttling) and Envoy-style clients use
 * to stop retries from multiplying load during an outage.
 *
 * Every first attempt deposits `ratio` tokens; a retry is allowed only if at least one token is
 * available, and spends it. Over time, retries are therefore at most about `ratio` × first attempts,
 * however many retries the call policy allows per request. A refused retry fails the call as if its
 * retries had run out.
 *
 * One budget is shared by all instances of a caller, per call policy it owns.
 *
 * ASSUMPTION: the bucket holds at most max(10, 100 × ratio) tokens and starts full. The cap lets a
 * short burst of failures (up to 10 retries, or 100 first attempts' worth) retry freely, and a
 * quiet period can never bank more than that. Real clients differ in the details (Finagle adds a
 * minimum retries-per-second allowance over a time window; gRPC throttles below half a full
 * bucket); this is the simplest form with the same long-run ratio.
 */
export class RetryBudget {
  readonly maxTokens: number;
  private tokens: number;

  constructor(readonly ratio: number) {
    this.maxTokens = Math.max(10, 100 * ratio);
    this.tokens = this.maxTokens;
  }

  /** A first attempt was sent. */
  deposit(): void {
    this.tokens = Math.min(this.maxTokens, this.tokens + this.ratio);
  }

  /**
   * Asks to retry: spends a token and returns true, or returns false if none is available.
   * The tolerance absorbs floating-point error from adding up fractional deposits (10 × 0.1 < 1).
   */
  tryWithdraw(): boolean {
    if (this.tokens < 1 - 1e-9) return false;
    this.tokens -= 1;
    return true;
  }

  get available(): number {
    return this.tokens;
  }
}

/** A budget for `policy`, or null if it has none. */
export function budgetFor(policy: { retryBudget?: number } | null | undefined): RetryBudget | null {
  return policy?.retryBudget === undefined ? null : new RetryBudget(policy.retryBudget);
}
