/**
 * How big a simulation may get. Shared by the input forms (ui/draft.ts), the traffic ranges of
 * built systems (builder/scenarios.ts) and the worker, which refuses anything larger.
 *
 * ASSUMPTION: 5,000 req/s for up to 600 s keeps one run to a few seconds in a browser tab; far
 * larger values can run for minutes and exhaust memory (every request is simulated one by one).
 */
export const LIMITS = { maxRps: 5000, minDurationS: 30, maxDurationS: 600 } as const;

/**
 * The most requests users may send in one run: the largest traffic for the longest run (3 million).
 * ASSUMPTION: this counts users' first attempts only. Retries can multiply them during a failure,
 * but nested timeouts cap that (the default retry storm peaks at ~3× the DB's capacity), and a run
 * at this size already takes about a minute. A tipping-point map once asked for ~70,000 req/s for
 * 120 s (8.4 million) and crashed the tab; nothing may get that far again.
 */
export const MAX_REQUESTS_PER_RUN = LIMITS.maxRps * LIMITS.maxDurationS;

/** Requests users send in a run: traffic × duration. */
export function expectedRequests(rps: number, durationMs: number): number {
  return (rps * durationMs) / 1000;
}

/** Why a run is too big to simulate, in plain words, or null when it is fine. */
export function runSizeProblem(rps: number, durationMs: number): string | null {
  const n = expectedRequests(rps, durationMs);
  if (!(n > MAX_REQUESTS_PER_RUN)) return null;
  const millions = (x: number) => `${(Math.round(x / 100_000) / 10).toString()} million`;
  return `This many requests would take too long to simulate in a browser: ${rps} req/s for ${durationMs / 1000} s is about ${millions(n)} requests, and the most is ${millions(MAX_REQUESTS_PER_RUN)}. Lower the traffic or shorten the run.`;
}
