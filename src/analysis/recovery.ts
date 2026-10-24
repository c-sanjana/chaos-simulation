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
 *   2. end-to-end p99 latency is no higher than the control's highest per-second p99, at the
 *      latency histogram's resolution (in the same bin or a lower one), and
 *   3. every tier's average queue is no higher than that tier's highest per-second queue in the control, and
 *   4. every queue tier's average backlog (messages waiting) is no higher than that tier's highest
 *      per-second backlog in the control, and
 *   5. every queue tier dead-letters (drops after its retries) no more messages than in the
 *      control's worst second.
 * The run has recovered at the start of the first second from which every later judged second is
 * healthy. Bounds 2–5 come from the control run itself, so there is no tolerance to tune.
 *
 * Why the backlog (4)? A message queue answers its producers as soon as a message is stored, so
 * users can see fast, successful answers while the work behind the queue piles up. Criteria 1–3
 * would call that healthy; with 4, "recovered" also means "the backlog drained". Users never see a
 * dead-lettered message either, but it is work lost: with 5, a system still dropping messages has
 * not recovered.
 *
 * Why compare p99 by histogram bin? p99 is read from a histogram with ~12%-wide bins. Measured on
 * the "cache restarts empty" preset at 160 req/s: one second's p99 came out 145.29 ms against the
 * control's highest, 145.12 ms, in the same second and the same bin (one slow request landing a
 * hair later, because the refilled cache holds slightly different keys). Compared exactly, that
 * labelled a 1 s cache outage as "recovered 62 s after". Within one bin the histogram cannot tell
 * the two apart, so neither does the verdict.
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
  if (controlFailures > 0 || queueFallsBehind(control, config, firstFaultStartMs, judgedUntilMs)) return { verdict: 'overloaded', recoveredAtMs: null, recoveryMs: null, ...base };

  const maxIgnoringNaN = (xs: number[]) => xs.reduce((m, x) => (x > m ? x : m), 0);
  const p99CeilingBin = latencyBin(maxIgnoringNaN(control.client.latencyP99Ms));
  const tierIds = Object.keys(run.tiers);
  const queueCeiling = Object.fromEntries(tierIds.map((id) => [id, maxIgnoringNaN(control.tiers[id].queueAvg)]));
  const queueTierIds = config.tiers.filter((t) => t.queue).map((t) => t.id);
  const backlogCeiling = Object.fromEntries(queueTierIds.map((id) => [id, maxIgnoringNaN(control.tiers[id].backlogAvg)]));
  const deadLetterCeiling = Object.fromEntries(queueTierIds.map((id) => [id, maxIgnoringNaN(control.tiers[id].deadLettered)]));
  const healthy = (s: number) =>
    !mismatchedSeconds.has(s) &&
    !(latencyBin(run.client.latencyP99Ms[s]) > p99CeilingBin) && // NaN (no successes) is bin 0: passes only if requests matched
    tierIds.every((id) => run.tiers[id].queueAvg[s] <= queueCeiling[id]) &&
    queueTierIds.every((id) => run.tiers[id].backlogAvg[s] <= backlogCeiling[id] && run.tiers[id].deadLettered[s] <= deadLetterCeiling[id]);

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

/**
 * Does some message queue fall further and further behind even without the failure? Its senders
 * are all answered, so no request fails, but the work behind it can't keep up: too much traffic
 * for this system, like failing requests in the control.
 * ASSUMPTION: "falling behind" = over the last 10 judged seconds of the control, more than 4× its
 * consumers' worth of messages wait on average, and more than twice as many as in the 10 s before
 * the failure. A queue keeping up fluctuates around a small backlog; one that can't grows steadily
 * (measured: 7,600 waiting after 110 s at 220 msg/s against ~160/s of work done).
 */
function queueFallsBehind(control: RunResult, config: RunConfig, firstFaultStartMs: number, judgedUntilMs: number): boolean {
  const mean = (xs: number[], from: number, to: number) => {
    const part = xs.slice(Math.max(0, from), Math.max(0, to));
    return part.length ? part.reduce((a, b) => a + b, 0) / part.length : 0;
  };
  const before = Math.floor(firstFaultStartMs / control.bucketMs);
  const end = Math.floor(judgedUntilMs / control.bucketMs);
  return config.tiers.some((t) => {
    if (!t.queue) return false;
    const backlog = control.tiers[t.id].backlogAvg;
    const late = mean(backlog, end - 10, end);
    return late > 4 * t.queue.consumers && late > 2 * mean(backlog, before - 10, before);
  });
}

/** The control for a config: identical except that nothing fails. */
export function controlConfig(config: RunConfig): RunConfig {
  return { ...config, faults: [] };
}
