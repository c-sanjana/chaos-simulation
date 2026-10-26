/**
 * How big a simulation may get. Shared by the input forms (ui/draft.ts), the traffic ranges of
 * built systems (builder/scenarios.ts) and the worker, which refuses anything larger.
 *
 * ASSUMPTION: 5,000 req/s for up to 600 s keeps one run to a few seconds in a browser tab; far
 * larger values can run for minutes and exhaust memory (every request is simulated one by one).
 */
export const LIMITS = { maxRps: 5000, minDurationS: 30, maxDurationS: 600 } as const;

/**
 * How long a run must go on after its last failure ends, so there is room to see whether it
 * recovers. Recovery is judged only up to maxRequestMs (analysis/recovery: the longest a request
 * can take, every retry included) before the run's end, so this leaves time after the failure
 * even then. Used by the failure editor's limits (ui/draft.ts) and by the check that a fix still
 * helps with a longer slowdown (fixes/rank.ts withLongerOutage).
 * ASSUMPTION: 20 s; the retry storm recovers within seconds when it recovers at all.
 */
export const JUDGE_AFTER_FAILURE_S = 20;

/**
 * The most requests users may send in one run: the largest traffic for the longest run (3 million).
 * ASSUMPTION: this counts users' first attempts only. Retries can multiply them during a failure,
 * but nested timeouts cap that (the default retry storm peaks at ~3× the DB's capacity), and a run
 * at this size already takes about a minute. A tipping-point map once asked for ~70,000 req/s for
 * 120 s (8.4 million) and crashed the tab; nothing may get that far again.
 */
export const MAX_REQUESTS_PER_RUN = LIMITS.maxRps * LIMITS.maxDurationS;

/**
 * The most calls between parts one run may make, before retries: 10 per request at the largest
 * traffic for the longest run (30 million).
 * ASSUMPTION: every call is simulated one by one, so the work of a run grows with its calls, not
 * only with users' requests. The presets make 4 calls per request (load balancer, app server, its
 * cache lookup, database), so their largest run is 12 million; 10 per request leaves room for
 * bigger built systems at the largest settings. A diagram where every part calls every part of
 * the next column multiplies its calls from column to column (a 5-wide, 8-deep mesh makes 390,625
 * database calls per request) and would run for hours; this refuses it (review 3, F6). Retries are
 * left out: validation caps them per call (engine/config.ts MAX_RETRIES), and nested timeouts cap
 * how far they multiply.
 */
export const MAX_CALLS_PER_RUN = 10 * MAX_REQUESTS_PER_RUN;

/** Requests users send in a run: traffic × duration. */
export function expectedRequests(rps: number, durationMs: number): number {
  return (rps * durationMs) / 1000;
}

/**
 * Why a run is too big to simulate, in plain words, or null when it is fine. `callsPerRequest`:
 * the calls between parts one request makes (analysis/helpers' callsPerRequest; 1 counts
 * requests only).
 */
export function runSizeProblem(rps: number, durationMs: number, callsPerRequest = 1): string | null {
  const n = expectedRequests(rps, durationMs);
  const millions = (x: number) => `${(Math.round(x / 100_000) / 10).toLocaleString('en-US')} million`;
  if (n > MAX_REQUESTS_PER_RUN) {
    return `This many requests would take too long to simulate in a browser: ${rps} req/s for ${durationMs / 1000} s is about ${millions(n)} requests, and the most is ${millions(MAX_REQUESTS_PER_RUN)}. Lower the traffic or shorten the run.`;
  }
  const calls = n * callsPerRequest;
  if (!(calls > MAX_CALLS_PER_RUN)) return null;
  // A mesh deep enough can make more calls than a number can hold.
  const each = Number.isFinite(callsPerRequest) ? `about ${Math.round(callsPerRequest).toLocaleString('en-US')} calls` : 'more calls than can be counted';
  const total = Number.isFinite(calls) ? `about ${millions(calls)} calls` : 'more than can be counted';
  return `This system makes too many calls to simulate in a browser: each request goes on to ${each} between its parts, so ${rps} req/s for ${durationMs / 1000} s is ${total}, and the most is ${millions(MAX_CALLS_PER_RUN)}. Make fewer calls per request (fewer arrows from each part), lower the traffic or shorten the run.`;
}
