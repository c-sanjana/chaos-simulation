import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RunConfig } from '../engine/config';
import { SweepResult, type SweepSpec } from '../sweep/sweep';
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
  return useSweeps(pool, [spec])[0];
}

type KeyedSweep = SweepState & { key: string | null };
const NO_SWEEP: KeyedSweep = { key: null, result: null, done: 0, total: 0, error: null };

/**
 * Several sweeps shown side by side (step 3's before and after maps), filled together: their cells
 * go to the pool alternately, one from each map in turn, so no map waits for another to finish (the
 * pool takes jobs in order). Before, the after map stayed empty until the before map was done, but
 * for its one cell the pool already held (the fix at your settings), which looked like a result
 * from nowhere. A sweep whose spec is unchanged keeps the cells it has and only asks for the rest.
 */
export function useSweeps(pool: SimPool, specs: Array<SweepSpec | null>): SweepState[] {
  const keys = specs.map((spec) => (spec ? stableKey(spec.cells.map((c) => c.config)) : null));
  const joined = JSON.stringify(keys);
  const [states, setStates] = useState<KeyedSweep[]>(() => keys.map(() => NO_SWEEP));
  const latest = useRef(states);
  latest.current = states;
  useEffect(() => {
    const batch = pool.batch({ priority: PRIORITY.map });
    const results = specs.map((spec, i) => {
      if (!spec) return null;
      const result = new SweepResult(spec);
      const kept = latest.current[i];
      if (kept?.key === keys[i] && kept.result) for (const c of kept.result.cells()) result.set(c.x, c.y, c.summary);
      return result;
    });
    const show = (i: number, change: Partial<KeyedSweep>) => setStates((prev) => prev.map((p, j) => (j === i && p.key === keys[i] ? { ...p, ...change } : p)));
    setStates(keys.map((key, i) => ({ key, result: results[i], done: results[i]?.done ?? 0, total: results[i]?.total ?? 0, error: null })));
    // One cell from each map in turn, skipping cells a map already has.
    const queues = specs.map((spec, i) => (spec ? spec.cells.filter((c) => !results[i]!.get(c.x, c.y)) : []));
    for (let n = 0; n < Math.max(0, ...queues.map((q) => q.length)); n++) {
      queues.forEach((queue, i) => {
        const cell = queue[n];
        if (!cell) return;
        batch.cell(cell.config).then(
          (summary) => {
            results[i]!.set(cell.x, cell.y, summary);
            show(i, { result: results[i], done: results[i]!.done });
          },
          (e: unknown) => {
            if (e instanceof CancelledError) return;
            show(i, { error: String(e) });
            batch.cancel(); // a failed cell stops the rest, as runSweep does
          },
        );
      });
    }
    return () => batch.cancel();
  }, [pool, joined]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by the specs' configs, not their identity
  // As in useAnalysis: never a previous spec's result alongside a new spec.
  return keys.map((key, i) => {
    const s = states[i] ?? NO_SWEEP;
    if (s.key !== key) return { result: null, done: 0, total: specs[i] ? specs[i]!.cells.length : 0, error: null };
    return { result: s.result, done: s.done, total: s.total, error: s.error };
  });
}
