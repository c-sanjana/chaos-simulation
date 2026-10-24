/**
 * The work a simulation worker does, as pure functions. Shared by the real Web Worker and the
 * in-process fallback pool, and tested directly (the worker entry point only wires messages).
 */
import { analyzeRun, type Analysis } from '../analysis/analyze';
import type { Verdict } from '../analysis/recovery';
import { simulateUntilSettled } from '../analysis/settle';
import type { RunConfig } from '../engine/config';
import { withSimulationProgress } from '../engine/progress';
import type { RunResult } from '../engine/result';
import { runSizeProblem } from '../data/limits';

/** What a tipping-point map needs from one cell: small, so it is cheap to send between threads. */
export interface CellSummary {
  verdict: Verdict;
  recoveryMs: number | null;
  failedRequests: number;
}

/** Everything the run player shows: the run, its no-failure control, and the analysis. */
export interface AnalyzeResult {
  run: RunResult;
  control: RunResult;
  analysis: Analysis;
}

export type AnalyzeJob = { kind: 'analyze'; config: RunConfig; labels: Record<string, string> };
export type CellJob = { kind: 'cell'; config: RunConfig };
export type Job = AnalyzeJob | CellJob;
export type JobResult = AnalyzeResult | CellSummary;

/** How often a job reports its progress at most, in wall-clock ms (and never in its first such interval). */
export const PROGRESS_INTERVAL_MS = 200;

/**
 * Runs a job's config and its control (same config and seed, no failures), extended while a
 * backlog is still draining (see settle.ts), then analyses them. `onProgress` hears the fraction
 * done (0–1) at most every PROGRESS_INTERVAL_MS, so a long run can show "Simulating… 40%"; it
 * doesn't change the result.
 */
export function executeJob(job: AnalyzeJob, onProgress?: (fraction: number) => void): AnalyzeResult;
export function executeJob(job: CellJob, onProgress?: (fraction: number) => void): CellSummary;
export function executeJob(job: Job, onProgress?: (fraction: number) => void): JobResult;
export function executeJob(job: Job, onProgress?: (fraction: number) => void): JobResult {
  // A guard before any work: one oversized run can exhaust the tab's memory. (Settling extends a
  // run to at most MAX_SETTLE_MS, well inside the cap for any traffic the guard lets through.)
  const tooBig = runSizeProblem(job.config.client.rps, job.config.durationMs);
  if (tooBig) throw new Error(tooBig);
  const phase = onProgress ? progressPhases(job.config.durationMs, onProgress) : () => null;
  const { config, run, control, recovery } = simulateUntilSettled(job.config, (which, simulate) => withSimulationProgress(phase(which), simulate));
  if (job.kind === 'analyze') return { run, control, analysis: analyzeRun(run, control, config, job.labels, recovery) };
  return summarise(recovery);
}

/**
 * The cell summary of a config, read from its full analysis. Identical to running a cell job for
 * the same config (both judge the settled run the same way; jobs.test.ts checks it), so a cache
 * can answer a cell from an analysis it already has.
 */
export function cellSummaryOf(result: AnalyzeResult): CellSummary {
  return summarise(result.analysis.recovery);
}

function summarise({ verdict, recoveryMs, failedRequests }: CellSummary): CellSummary {
  return { verdict, recoveryMs, failedRequests };
}

/**
 * Turns simulated time into the job's fraction done, throttled by wall-clock time.
 * ASSUMPTION: the run and its control count for half the job each. The control (no failure) is
 * usually quicker, so progress speeds up in the second half; good enough for "about 40%". A run
 * may go on past `durationMs` (e.g. while a backlog drains); each half then waits at its end.
 */
function progressPhases(durationMs: number, onProgress: (fraction: number) => void) {
  let last = performance.now();
  return (phase: 0 | 1) => (simulatedMs: number) => {
    const now = performance.now();
    if (now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    onProgress((phase + Math.min(1, simulatedMs / durationMs)) / 2);
  };
}
