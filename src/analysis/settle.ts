import type { RunConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import { runSimulation } from '../engine/run';
import { assessRecovery, controlConfig, maxRequestMs, type RecoveryResult } from './recovery';

/**
 * Runs are never extended past this (2× the presets' 120 s): ~1 s to simulate, a ~15 s replay at
 * 16× (user decision, 2026-10-24: 600 s made the replay too long). Slower drains are reported as
 * "still catching up".
 */
export const MAX_SETTLE_MS = 240_000;
/** A backlog's trend is read from three 5 s windows this far apart, ending at the judged range's end. */
const TREND_S = 10;
/** Time the judged range must leave after the failure ends to see a recovery. */
const AFTER_FAILURE_MS = 30_000;
/**
 * ASSUMPTION: with less than this judged after the failure, a stuck verdict says more about where
 * the run ends than about the system (review 4: a 60 s run whose failure ended 0.4 s before the judged
 * range did read "stuck" with 0 failed requests), so the run is extended as for a late failure.
 */
const MIN_JUDGED_AFTER_FAILURE_MS = 10_000;

/** Wraps each simulation (0 = the run, 1 = its control), e.g. to report progress. Must return its result. */
export type RunWrapper = (which: 0 | 1, simulate: () => RunResult) => RunResult;

export interface Settled {
  /** The config as simulated: the input, with a longer duration if the run was extended. */
  config: RunConfig;
  run: RunResult;
  control: RunResult;
  recovery: RecoveryResult;
}

/**
 * Runs a config and its control, extending both while the verdict depends on where the run happens
 * to end rather than on what happened:
 * - a backlog is still draining at the end of the judged range (falling steadily, so it would
 *   settle given time) — e.g. a message queue working through messages after a slowdown; or
 * - the failure ends too close to the end of the run for a recovery to be seen.
 * The run is lengthened to when the drain should finish (plus a margin), at most MAX_SETTLE_MS, and
 * only to a length `fits` allows (the caller's run-size limit: a longer run means more requests).
 * If it still hasn't settled by then, the verdict stays stuck and `catchingUpMs` estimates how
 * much longer the drain needs.
 *
 * Why not judge by trend alone? A falling backlog can level off or rise again (retries, a cache
 * emptying); only running on shows whether it really gets back to normal. Measured on queue
 * systems: most backlogs drain within the 120 s run; near capacity, settling took 160–430 s.
 * A 120 s run takes ~0.35 s to simulate, 240 s ~0.9 s, and only runs that need it are extended.
 *
 * Extending is exact: the same seed gives the same requests and random values, so the first
 * 120 s of a longer run are identical to the 120 s run.
 */
export function simulateUntilSettled(config: RunConfig, wrap: RunWrapper = (_, simulate) => simulate(), fits: (durationMs: number) => boolean = () => true): Settled {
  let cfg = config;
  for (;;) {
    const current = cfg;
    const run = wrap(0, () => runSimulation(current));
    const control = wrap(1, () => runSimulation(controlConfig(current)));
    const recovery = assessRecovery(run, control, cfg);
    const need = moreTimeNeeded(run, control, cfg, recovery);
    if (need === null) return { config: cfg, run, control, recovery };
    const longer = Math.min(MAX_SETTLE_MS, cfg.durationMs + need.extraMs);
    if (cfg.durationMs >= MAX_SETTLE_MS || !fits(longer)) {
      return { config: cfg, run, control, recovery: need.drainMs === null ? recovery : { ...recovery, catchingUpMs: need.drainMs } };
    }
    cfg = { ...cfg, durationMs: longer };
  }
}

/**
 * How much longer the run needs to tell how it ends, or null when the verdict already stands.
 * `drainMs`: the estimated time for the backlog to drain (null when the run is extended for a
 * late failure instead).
 */
export function moreTimeNeeded(run: RunResult, control: RunResult, config: RunConfig, r: RecoveryResult): { extraMs: number; drainMs: number | null } | null {
  if (r.verdict !== 'stuck') return null;
  const margin = maxRequestMs(config) + 10_000;
  // A failure ending inside (or just before) the last stretch of the run: run on until a recovery could be seen.
  if (r.lastFaultEndMs + MIN_JUDGED_AFTER_FAILURE_MS > r.judgedUntilMs) {
    if (r.lastFaultEndMs >= config.durationMs) return null; // it lasts to the end by design
    return { extraMs: roundUp(r.lastFaultEndMs + AFTER_FAILURE_MS + margin - config.durationMs), drainMs: null };
  }
  const drainS = drainSeconds(run, control, Math.floor(r.judgedUntilMs / run.bucketMs));
  if (drainS === null) return null;
  // ASSUMPTION: 25% more than the straight-line estimate, since a drain slows as it nears the end.
  return { extraMs: roundUp(drainS * 1250 + margin), drainMs: Math.round(drainS * 1000) };
}

/**
 * Seconds until every tier queue and message backlog that is above its no-failure level gets back
 * to it, at the rate each fell over the end of the judged range; null unless something is above its
 * level and everything above it is falling steadily: lower in each of three 5 s windows TREND_S
 * apart, and by at least 3% overall.
 * ASSUMPTION: three falling windows in a row tell a steady drain from noise around a stuck level;
 * a stuck tier's queue sits at a plateau, so it rarely falls three times running, and when it
 * does, running on settles it (the extended run is judged afresh).
 */
function drainSeconds(run: RunResult, control: RunResult, end: number): number | null {
  if (end < 3 * TREND_S) return null;
  const mean = (xs: number[], to: number) => xs.slice(to - 5, to).reduce((a, b) => a + b, 0) / 5;
  const levels: Array<{ now: number; first: number; ceiling: number }> = [];
  for (const id of Object.keys(run.tiers)) {
    for (const key of ['queueAvg', 'backlogAvg'] as const) {
      const series = run.tiers[id][key];
      const ceiling = control.tiers[id][key].reduce((m, x) => (x > m ? x : m), 0);
      const now = mean(series, end);
      if (now <= ceiling) continue;
      const middle = mean(series, end - TREND_S);
      const first = mean(series, end - 2 * TREND_S);
      if (!(first > middle && middle > now && now <= 0.97 * first)) return null; // flat or growing: stuck, not settling
      levels.push({ now, first, ceiling });
    }
  }
  if (levels.length === 0) return null;
  return Math.max(...levels.map(({ now, first, ceiling }) => ((now - ceiling) * 2 * TREND_S) / (first - now)));
}

const roundUp = (ms: number) => Math.ceil(ms / 5000) * 5000;
