import { useEffect, useState } from 'react';
import type { RunConfig } from '../engine/config';
import { runSweep, SweepResult, type SweepSpec } from '../sweep/sweep';
import type { AnalyzeResult } from '../worker/jobs';
import { CancelledError, type SimPool } from '../worker/pool';

export type Async<T> = { status: 'idle' } | { status: 'running' } | { status: 'done'; value: T } | { status: 'error'; message: string };

/**
 * Runs `config` and its control in a worker and analyses them. Re-runs when the config changes
 * (compared by value) and cancels the previous run's work. null = nothing to run.
 */
export function useAnalysis(pool: SimPool, config: RunConfig | null, labels: Record<string, string>): Async<AnalyzeResult> {
  const key = config ? JSON.stringify(config) : null;
  const [state, setState] = useState<Async<AnalyzeResult>>({ status: 'idle' });
  useEffect(() => {
    if (!config) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'running' });
    const batch = pool.batch();
    batch.analyze(config, labels).then(
      (value) => setState({ status: 'done', value }),
      (e: unknown) => {
        if (!(e instanceof CancelledError)) setState({ status: 'error', message: String(e) });
      },
    );
    return () => batch.cancel();
    // `key` stands in for `config` and `labels` (compared by value).
  }, [pool, key]);
  return state;
}

export interface SweepState {
  result: SweepResult | null;
  done: number;
  total: number;
  error: string | null;
}

/** Runs a tipping-point sweep in the worker pool, updating as each cell finishes. */
export function useSweep(pool: SimPool, spec: SweepSpec | null): SweepState {
  const key = spec ? JSON.stringify(spec.cells.map((c) => c.config)) : null;
  const [state, setState] = useState<SweepState>({ result: null, done: 0, total: 0, error: null });
  useEffect(() => {
    if (!spec) {
      setState({ result: null, done: 0, total: 0, error: null });
      return;
    }
    const empty = new SweepResult(spec);
    setState({ result: empty, done: 0, total: empty.total, error: null });
    const batch = pool.batch();
    runSweep(spec, batch, (_, result) => setState({ result, done: result.done, total: result.total, error: null })).catch((e: unknown) => {
      if (!(e instanceof CancelledError)) setState((s) => ({ ...s, error: String(e) }));
    });
    return () => batch.cancel();
  }, [pool, key]);
  return state;
}
