/**
 * The work a simulation worker does, as pure functions. Shared by the real Web Worker and the
 * in-process fallback pool, and tested directly (the worker entry point only wires messages).
 */
import { analyzeRun, type Analysis } from '../analysis/analyze';
import type { Verdict } from '../analysis/recovery';
import { simulateUntilSettled } from '../analysis/settle';
import type { RunConfig } from '../engine/config';
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

/**
 * Runs a job's config and its control (same config and seed, no failures), extended while a
 * backlog is still draining (see settle.ts), then analyses them.
 */
export function executeJob(job: AnalyzeJob): AnalyzeResult;
export function executeJob(job: CellJob): CellSummary;
export function executeJob(job: Job): JobResult;
export function executeJob(job: Job): JobResult {
  // A guard before any work: one oversized run can exhaust the tab's memory. (Settling extends a
  // run to at most MAX_SETTLE_MS, well inside the cap for any traffic the guard lets through.)
  const tooBig = runSizeProblem(job.config.client.rps, job.config.durationMs);
  if (tooBig) throw new Error(tooBig);
  const { config, run, control, recovery } = simulateUntilSettled(job.config);
  if (job.kind === 'analyze') return { run, control, analysis: analyzeRun(run, control, config, job.labels, recovery) };
  const { verdict, recoveryMs, failedRequests } = recovery;
  return { verdict, recoveryMs, failedRequests };
}
