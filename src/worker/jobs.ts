/**
 * The work a simulation worker does, as pure functions. Shared by the real Web Worker and the
 * in-process fallback pool, and tested directly (the worker entry point only wires messages).
 */
import { analyzeRun, type Analysis } from '../analysis/analyze';
import { assessRecovery, controlConfig, type Verdict } from '../analysis/recovery';
import type { RunConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import { runSimulation } from '../engine/run';

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

/** Runs a job's config and its control (same config and seed, no failures), then analyses them. */
export function executeJob(job: AnalyzeJob): AnalyzeResult;
export function executeJob(job: CellJob): CellSummary;
export function executeJob(job: Job): JobResult;
export function executeJob(job: Job): JobResult {
  const run = runSimulation(job.config);
  const control = runSimulation(controlConfig(job.config));
  if (job.kind === 'analyze') return { run, control, analysis: analyzeRun(run, control, job.config, job.labels) };
  const { verdict, recoveryMs, failedRequests } = assessRecovery(run, control, job.config);
  return { verdict, recoveryMs, failedRequests };
}
