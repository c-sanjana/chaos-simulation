import { useEffect, useState } from 'react';
import type { RunConfig } from '../engine/config';
import { runSweep, SweepResult, type SweepSpec } from '../sweep/sweep';
import type { AnalyzeResult } from '../worker/jobs';
import { CancelledError, type SimPool } from '../worker/pool';

export type Async<T> = { status: 'idle' } | { status: 'running' } | { status: 'done'; value: T } | { status: 'error'; message: string };

/**
 * Runs `config` and its control in a worker and analyses them. Re-runs when the config changes
 * (compared by value) and cancels the previous run's work. null = nothing to run.
 *
 * A result is only ever returned for the config it belongs to: in the render where the config
 * changes (before the effect starts the new run) the hook already says 'running', so a view never
 * pairs the new config with the old run (a built topology's tiers differ from the last one's).
 */
export function useAnalysis(pool: SimPool, config: RunConfig | null, labels: Record<string, string>): Async<AnalyzeResult> {
  const key = config ? JSON.stringify(config) + JSON.stringify(labels) : null;
  const [state, setState] = useState<{ key: string | null; value: Async<AnalyzeResult> }>({ key: null, value: { status: 'idle' } });
  useEffect(() => {
    if (!config) {
      setState({ key, value: { status: 'idle' } });
      return;
    }
    setState({ key, value: { status: 'running' } });
    const batch = pool.batch();
    batch.analyze(config, labels).then(
      (value) => setState({ key, value: { status: 'done', value } }),
      (e: unknown) => {
        if (!(e instanceof CancelledError)) setState({ key, value: { status: 'error', message: String(e) } });
      },
    );
    return () => batch.cancel();
    // `key` stands in for `config` and `labels` (compared by value).
  }, [pool, key]);
  if (state.key !== key) return key === null ? { status: 'idle' } : { status: 'running' };
  return state.value;
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
  const [state, setState] = useState<SweepState & { key: string | null }>({ key: null, result: null, done: 0, total: 0, error: null });
  useEffect(() => {
    if (!spec) {
      setState({ key, result: null, done: 0, total: 0, error: null });
      return;
    }
    const empty = new SweepResult(spec);
    setState({ key, result: empty, done: 0, total: empty.total, error: null });
    const batch = pool.batch();
    runSweep(spec, batch, (_, result) => setState({ key, result, done: result.done, total: result.total, error: null })).catch((e: unknown) => {
      if (!(e instanceof CancelledError)) setState((s) => ({ ...s, error: String(e) }));
    });
    return () => batch.cancel();
  }, [pool, key]);
  // As in useAnalysis: never the previous spec's result alongside a new spec.
  if (state.key !== key) return { result: null, done: 0, total: spec ? spec.cells.length : 0, error: null };
  return { result: state.result, done: state.done, total: state.total, error: state.error };
}
