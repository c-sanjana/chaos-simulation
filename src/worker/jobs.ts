/**
 * The work a simulation worker does, as pure functions. Shared by the real Web Worker and the
 * in-process fallback pool, and tested directly (the worker entry point only wires messages).
 */
import { analyzeRun, type Analysis } from '../analysis/analyze';
import type { Verdict } from '../analysis/recovery';
import { simulateUntilSettled } from '../analysis/settle';
import type { RunConfig } from '../engine/config';
import type { RunResult } from '../engine/result';

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
  const { config, run, control, recovery } = simulateUntilSettled(job.config);
  if (job.kind === 'analyze') {
    const analysis = analyzeRun(run, control, config, job.labels);
    return { run, control, analysis: { ...analysis, recovery } };
  }
  const { verdict, recoveryMs, failedRequests } = recovery;
  return { verdict, recoveryMs, failedRequests };
}
