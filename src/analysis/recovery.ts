import type { RunConfig } from '../engine/config';
import { latencyBin } from '../engine/stats';
import { STATUS_OK, STATUS_UNFINISHED, type RunResult } from '../engine/result';

export type Verdict =
  /** Never left the healthy range. */
  | 'unaffected'
  /** Left it, and came back for good. */
  | 'recovered'
  /** Left it and had not come back when the run ended. */
  | 'stuck'
  /** The no-failure control is itself failing requests: too much traffic for this system. */
  | 'overloaded';

export interface RecoveryResult {
  verdict: Verdict;
  /** Start of the first second from which the run stays in the healthy range (recovered only). */
  recoveredAtMs: number | null;
  /** recoveredAtMs − the moment the last failure ended (recovered only). */
  recoveryMs: number | null;
  /** Requests that failed (or never finished) in this run but succeeded in the control. */
  failedRequests: number;
  /**
   * Seconds after this one are not judged: requests arriving later may not have finished. Never
   * later than the end of the run.
   */
  judgedUntilMs: number;
  /** When the last failure ends, as configured (it may be at or after the end of the run). */
  lastFaultEndMs: number;
}

/**
 * Longest a request can take before the client gives up on its last retry, or 0 if the client
 * waits forever.
 */
export function maxRequestMs(config: RunConfig): number {
  const c = config.client.call;
  if (c.timeoutMs === null) return 0;
  let backoff = 0;
  for (let n = 1; n <= c.retries; n++) backoff += c.backoffBaseMs * 2 ** (n - 1);
  return (c.retries + 1) * c.timeoutMs + backoff;
}

/**
 * Did the system return to normal after the failure, and when?
 *
 * The reference is a control run: the same config and seed with the failures removed, so it sees
 * identical traffic and identical random values. A second counts as healthy when:
 *   1. every request arriving in it succeeded if and only if it succeeded in the control, and
 *   2. end-to-end p99 latency is no higher than the control's highest per-second p99, and
 *   3. every tier's average queue is no higher than that tier's highest per-second queue in the control.
 * The run has recovered at the start of the first second from which every later judged second is
 * healthy. Bounds 2 and 3 come from the control run itself, so there is no tolerance to tune.
 *
 * Why not require every request to match the control exactly (PLAN.md option C)? It was tried and
 * measured: after a recovery, the cache holds slightly different keys than in the control until TTL
 * churn evens them out, so a few requests miss where the control hit, harmlessly, for up to a TTL.
 * Exact matching labelled clearly recovered runs as stuck. See PLAN.md decision log.
 *
 * Only what happened inside the run is judged:
 * - The judged range ends at the end of the run at the latest, even when the failure lasts longer.
 * - A request still unfinished (in either run) when the run ended is not judged if it arrived late
 *   enough that it could have finished afterwards: how it would have ended is unknown.
 * - A failure that starts at or after the end of the judged range never happened as far as the
 *   judged seconds are concerned: the run is unaffected.
 * - A failure still going on when the judged range ends leaves no time to see a recovery: the run
 *   is stuck unless it never left the healthy range.
 */
export function assessRecovery(run: RunResult, control: RunResult, config: RunConfig): RecoveryResult {
  const bucketMs = run.bucketMs;
  const faults = config.faults ?? [];
  const firstFaultStartMs = faults.length ? Math.min(...faults.map((f) => f.startMs)) : 0;
  const lastFaultEndMs = faults.length ? Math.max(...faults.map((f) => f.endMs)) : 0;
  // Requests arriving from here on may legitimately still be running when the run ends.
  const settledBeforeMs = run.durationMs - maxRequestMs(config);
  const judgedUntilMs = Math.min(run.durationMs, Math.max(lastFaultEndMs, settledBeforeMs));
  const lastSecond = Math.floor(judgedUntilMs / bucketMs) - 1;

  const a = run.client.requests;
  const b = control.client.requests;
  const mismatchedSeconds = new Set<number>();
  let failedRequests = 0;
  let controlFailures = 0;
  for (let i = 0; i < a.status.length && a.arrivalMs[i] < judgedUntilMs; i++) {
    const cutOff = a.status[i] === STATUS_UNFINISHED || b.status[i] === STATUS_UNFINISHED;
    if (cutOff && a.arrivalMs[i] >= settledBeforeMs) continue; // the run ended before it could
    if (b.status[i] !== STATUS_OK) controlFailures++;
    if ((a.status[i] === STATUS_OK) !== (b.status[i] === STATUS_OK)) mismatchedSeconds.add(Math.floor(a.arrivalMs[i] / bucketMs));
    if (a.status[i] !== STATUS_OK && b.status[i] === STATUS_OK) failedRequests++;
  }

  const base = { failedRequests, judgedUntilMs, lastFaultEndMs };
  if (controlFailures > 0) return { verdict: 'overloaded', recoveredAtMs: null, recoveryMs: null, ...base };

  const maxIgnoringNaN = (xs: number[]) => xs.reduce((m, x) => (x > m ? x : m), 0);
  const p99Ceiling = maxIgnoringNaN(control.client.latencyP99Ms);
  const tierIds = Object.keys(run.tiers);
  const queueCeiling = Object.fromEntries(tierIds.map((id) => [id, maxIgnoringNaN(control.tiers[id].queueAvg)]));
  const healthy = (s: number) =>
    !mismatchedSeconds.has(s) &&
    !(latencyBin(run.client.latencyP99Ms[s]) > latencyBin(p99Ceiling)) && // NaN (no successes) only passes if requests matched
    tierIds.every((id) => run.tiers[id].queueAvg[s] <= queueCeiling[id]);

  // A failure starting after the judged range: nothing to judge, so nothing went wrong.
  const firstJudged = Math.min(Math.floor(firstFaultStartMs / bucketMs), lastSecond + 1);
  let recoveredFrom = lastSecond + 1;
  for (let s = lastSecond; s >= firstJudged && healthy(s); s--) recoveredFrom = s;

  if (recoveredFrom === firstJudged) return { verdict: 'unaffected', recoveredAtMs: null, recoveryMs: null, ...base };
  const stillFailing = lastFaultEndMs >= judgedUntilMs;
  if (recoveredFrom > lastSecond || stillFailing) return { verdict: 'stuck', recoveredAtMs: null, recoveryMs: null, ...base };
  const recoveredAtMs = Math.max(recoveredFrom * bucketMs, lastFaultEndMs);
  return { verdict: 'recovered', recoveredAtMs, recoveryMs: recoveredAtMs - lastFaultEndMs, ...base };
}

/** The control for a config: identical except that nothing fails. */
export function controlConfig(config: RunConfig): RunConfig {
  return { ...config, faults: [] };
}
