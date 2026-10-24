import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunConfig } from '../engine/config';
import { runSweep, SweepResult, type SweepSpec } from '../sweep/sweep';
import { stableKey } from '../worker/cachingPool';
import type { AnalyzeResult } from '../worker/jobs';
import { CancelledError, PRIORITY, type SimBatch, type SimPool } from '../worker/pool';

export type Async<T> =
  | { status: 'idle' }
  /** `progress`: the fraction done (0–1), once a long run reports it. */
  | { status: 'running'; progress?: number }
  | { status: 'done'; value: T }
  | { status: 'error'; message: string }
  /** Stopped by the viewer (see useCancellableAnalysis). */
  | { status: 'cancelled' };

const IDLE: Async<never> = { status: 'idle' };
const RUNNING: Async<never> = { status: 'running' };

export interface CancellableAnalysis {
  state: Async<AnalyzeResult>;
  /** Stops the run (its worker too, unless it is about to finish); the state becomes 'cancelled'. */
  cancel: () => void;
  /** Runs the same config again, e.g. after a cancel. */
  retry: () => void;
}

/**
 * Runs `config` and its control in a worker and analyses them. Re-runs when the config changes
 * (compared by value) and cancels the previous run's work. null = nothing to run.
 *
 * A result is only ever returned for the config it belongs to: in the render where the config
 * changes (before the effect starts the new run) the hook already says 'running', so a view never
 * pairs the new config with the old run (a built topology's tiers differ from the last one's).
 * A result the pool already holds (see CachingPool) is returned at once, with no 'running' render.
 * Single runs are what the viewer is waiting to watch, so they jump ahead of queued map cells.
 */
export function useAnalysis(pool: SimPool, config: RunConfig | null, labels: Record<string, string>): Async<AnalyzeResult> {
  return useCancellableAnalysis(pool, config, labels).state;
}

/** useAnalysis, plus a way to stop a long run and to try it again. */
export function useCancellableAnalysis(pool: SimPool, config: RunConfig | null, labels: Record<string, string>): CancellableAnalysis {
  const key = config ? stableKey(config) + stableKey(labels) : null;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string | null; value: Async<AnalyzeResult> }>({ key: null, value: IDLE });
  const batchRef = useRef<SimBatch | null>(null);
  useEffect(() => {
    batchRef.current = null;
    if (!config) {
      setState({ key, value: IDLE });
      return;
    }
    const kept = pool.peekAnalysis?.(config, labels);
    if (kept) {
      setState({ key, value: { status: 'done', value: kept } });
      return;
    }
    setState({ key, value: RUNNING });
    const batch = pool.batch({ priority: PRIORITY.replay });
    batchRef.current = batch;
    const onProgress = (progress: number) => setState((s) => (s.key === key && s.value.status === 'running' ? { key, value: { status: 'running', progress } } : s));
    batch.analyze(config, labels, { onProgress }).then(
      (value) => setState({ key, value: { status: 'done', value } }),
      (e: unknown) => {
        if (!(e instanceof CancelledError)) setState({ key, value: { status: 'error', message: String(e) } });
      },
    );
    return () => batch.cancel();
    // `key` stands in for `config` and `labels` (compared by value).
  }, [pool, key, attempt]);
  const cancel = useCallback(() => {
    const batch = batchRef.current;
    if (!batch || batch.cancelled) return;
    batch.cancel();
    setState((s) => (s.value.status === 'running' ? { key: s.key, value: { status: 'cancelled' } } : s));
  }, []);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  // Until the effect catches up with a new config: a result the pool holds, else 'running'.
  const kept = state.key !== key && config ? pool.peekAnalysis?.(config, labels) : undefined;
  const keptState = useMemo<Async<AnalyzeResult> | null>(() => (kept ? { status: 'done', value: kept } : null), [kept]);
  const value = state.key === key ? state.value : (keptState ?? (key === null ? IDLE : RUNNING));
  return useMemo(() => ({ state: value, cancel, retry }), [value, cancel, retry]);
}

export interface SweepState {
  result: SweepResult | null;
  done: number;
  total: number;
  error: string | null;
}

/** Runs a tipping-point sweep in the worker pool, updating as each cell finishes (cells the pool holds arrive at once). */
export function useSweep(pool: SimPool, spec: SweepSpec | null): SweepState {
  const key = spec ? stableKey(spec.cells.map((c) => c.config)) : null;
  const [state, setState] = useState<SweepState & { key: string | null }>({ key: null, result: null, done: 0, total: 0, error: null });
  useEffect(() => {
    if (!spec) {
      setState({ key, result: null, done: 0, total: 0, error: null });
      return;
    }
    const empty = new SweepResult(spec);
    setState({ key, result: empty, done: 0, total: empty.total, error: null });
    const batch = pool.batch({ priority: PRIORITY.map });
    runSweep(spec, batch, (_, result) => setState({ key, result, done: result.done, total: result.total, error: null })).catch((e: unknown) => {
      if (!(e instanceof CancelledError)) setState((s) => ({ ...s, error: String(e) }));
    });
    return () => batch.cancel();
  }, [pool, key]);
  // As in useAnalysis: never the previous spec's result alongside a new spec.
  if (state.key !== key) return { result: null, done: 0, total: spec ? spec.cells.length : 0, error: null };
  return { result: state.result, done: state.done, total: state.total, error: state.error };
}
