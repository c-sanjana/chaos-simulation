import { Attempt } from './attempt';
import type { CallPolicy } from './config';
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

/**
 * Calls `target` following `policy`: each try gets its own timeout; on failure or timeout the caller
 * backs off and retries until it runs out of retries. `done` is called exactly once.
 *
 * A timed-out try is marked abandoned but keeps running at the target (the target cannot tell its
 * caller left). Its late response is ignored.
 *
 * ASSUMPTION: retries are always scheduled as a new event (even with zero backoff), never made
 * synchronously inside a response, which keeps tiers free of re-entrant calls.
 */
export function callWithRetries(
  sim: Simulation,
  policy: CallPolicy,
  target: CallTarget,
  requestId: number,
  parentPath: number,
  stats: CallStats | null,
  done: (ok: boolean, attempt: Attempt) => void,
  /** Called on each new attempt before it is sent (e.g. to attach a cache key). */
  prepare?: (attempt: Attempt) => void,
): void {
  let attemptNo = 0;

  const failed = (path: number, attempt: Attempt) => {
    if (attemptNo > policy.retries) {
      done(false, attempt);
      return;
    }
    const delay = backoffDelayMs(policy, attemptNo, uniform(sim.seed, Stream.Jitter, requestId, path));
    sim.schedule(sim.now + delay, tryOnce);
  };

  function tryOnce() {
    attemptNo++;
    if (attemptNo > 1) stats?.retry(sim.now);
    const path = hashPath(parentPath, attemptNo);
    const deadline = policy.timeoutMs === null ? Infinity : sim.now + policy.timeoutMs;
    let settled = false;
    const attempt = new Attempt(requestId, path, attemptNo > 1, sim.now, deadline, (ok) => {
      if (settled) return; // late response after we gave up
      settled = true;
      if (ok) done(true, attempt);
      else failed(path, attempt);
    });
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
    target.accept(attempt);
  }

  tryOnce();
}
