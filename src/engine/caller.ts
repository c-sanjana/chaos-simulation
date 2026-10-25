import { Attempt } from './attempt';
import type { CallPolicy } from './config';
import type { RetryBudget } from './retryBudget';
import { hashPath, Stream, uniform } from './rng';
import type { Simulation } from './simulation';

/** Anything that can receive attempts (a tier). */
export interface CallTarget {
  accept(attempt: Attempt): void;
}

/** Caller-side counters. */
export interface CallStats {
  timeout(timeMs: number): void;
  retry(timeMs: number): void;
}

/**
 * Delay before retrying after attempt number `failedAttemptNo` (1-based) failed:
 * baseMs × 2^(n−1), or a uniform draw from [0, that] with full jitter.
 */
export function backoffDelayMs(policy: CallPolicy, failedAttemptNo: number, u: number): number {
  if (policy.backoffBaseMs <= 0) return 0;
  const ceiling = policy.backoffBaseMs * 2 ** (failedAttemptNo - 1);
  return policy.jitter ? u * ceiling : ceiling;
}

/** Caller-side context for `callWithRetries`; every field is optional. */
export interface CallOptions {
  /** Counts timeouts and retries sent (the calling tier's metrics). */
  stats?: CallStats;
  /** The caller's shared retry budget for this policy. */
  budget?: RetryBudget | null;
  /** Called on each new attempt before it is sent (e.g. to attach a cache key). */
  prepare?: (attempt: Attempt) => void;
  /** The call is made on behalf of a repeat further up (see Attempt.fromRepeat). */
  fromRepeat?: boolean;
  /**
   * Where try number `attemptNo` (from 1) goes, when that can change from try to try (a load
   * balancer retrying another pool); `target` otherwise. Asked before `prepare`.
   */
  targetFor?: (attemptNo: number) => CallTarget;
}

/**
 * Calls `target` following `policy`: each try gets its own timeout; on failure or timeout the caller
 * backs off and retries until it runs out of retries (or its retry budget refuses one). `done` is
 * called exactly once.
 *
 * A timed-out try is marked abandoned but keeps running at the target (the target cannot tell its
 * caller left). Its late response is ignored.
 *
 * ASSUMPTION: retries are always scheduled as a new event (even with zero backoff), never made
 * synchronously inside a response, which keeps tiers free of re-entrant calls.
 * ASSUMPTION: the budget is asked when a try fails (before backing off), as Finagle does.
 */
export function callWithRetries(
  sim: Simulation,
  policy: CallPolicy,
  target: CallTarget,
  requestId: number,
  parentPath: number,
  options: CallOptions,
  done: (ok: boolean, attempt: Attempt) => void,
): void {
  const { stats, budget, prepare, fromRepeat = false, targetFor } = options;
  let attemptNo = 0;

  const failed = (path: number, attempt: Attempt) => {
    if (attemptNo > policy.retries || (budget && !budget.tryWithdraw())) {
      done(false, attempt);
      return;
    }
    const delay = backoffDelayMs(policy, attemptNo, uniform(sim.seed, Stream.Jitter, requestId, path));
    sim.schedule(sim.now + delay, tryOnce);
  };

  function tryOnce() {
    attemptNo++;
    if (attemptNo > 1) stats?.retry(sim.now);
    else budget?.deposit();
    const path = hashPath(parentPath, attemptNo);
    const deadline = policy.timeoutMs === null ? Infinity : sim.now + policy.timeoutMs;
    let settled = false;
    const attempt = new Attempt(requestId, path, attemptNo > 1, sim.now, deadline, (ok) => {
      if (settled) return; // late response after we gave up
      settled = true;
      if (ok) done(true, attempt);
      else failed(path, attempt);
    });
    attempt.fromRepeat = fromRepeat;
    const to = targetFor ? targetFor(attemptNo) : target;
    prepare?.(attempt);
    if (deadline !== Infinity) {
      sim.schedule(deadline, () => {
        if (settled) return;
        settled = true;
        attempt.abandoned = true;
        stats?.timeout(sim.now);
        failed(path, attempt);
      });
    }
    to.accept(attempt);
  }

  tryOnce();
}
