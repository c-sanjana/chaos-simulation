import { act, renderHook, waitFor } from '@testing-library/react';
import { singleTier } from '../engine/testConfigs';
import type { RunConfig } from '../engine/config';
import { CachingPool } from '../worker/cachingPool';
import type { AnalyzeResult } from '../worker/jobs';
import { CancelledError, PRIORITY, type BatchOptions, type JobOptions, type SimBatch, type SimPool } from '../worker/pool';
import type { SweepSpec } from '../sweep/sweep';
import type { CellSummary } from '../worker/jobs';
import { useCancellableAnalysis, useSweeps } from './useSimulation';

const config = (rps: number): RunConfig => singleTier(rps, { kind: 'exponential', meanMs: 5 }, 2000);
const result = (n: number) => ({ n, analysis: { recovery: { verdict: 'recovered', recoveryMs: n, failedRequests: 0 } } }) as unknown as AnalyzeResult;

/** A pool whose analyses wait for the test. */
class ManualPool implements SimPool {
  readonly size = 1;
  readonly jobs: Array<{ config: RunConfig; priority: number; options?: JobOptions<AnalyzeResult>; resolve: (r: AnalyzeResult) => void; reject: (e: unknown) => void }> = [];
  batch({ priority = 0 }: BatchOptions = {}): SimBatch {
    let cancelled = false;
    const mine: Array<(e: unknown) => void> = [];
    return {
      analyze: (c, _labels, options) =>
        new Promise((resolve, reject) => {
          mine.push(reject);
          this.jobs.push({ config: c, priority, options, resolve, reject });
        }),
      cell: () => Promise.reject(new Error('unused')),
      cancel: () => {
        cancelled = true;
        mine.forEach((r) => r(new CancelledError()));
      },
      get cancelled() {
        return cancelled;
      },
    };
  }
  dispose(): void {}
}

describe('useCancellableAnalysis', () => {
  it('runs at replay priority, reports progress, and can be cancelled and retried', async () => {
    const pool = new ManualPool();
    const { result: hook } = renderHook(() => useCancellableAnalysis(pool, config(10), {}));
    expect(hook.current.state).toEqual({ status: 'running' });
    expect(pool.jobs[0].priority).toBe(PRIORITY.replay);
    act(() => pool.jobs[0].options!.onProgress!(0.3));
    expect(hook.current.state).toEqual({ status: 'running', progress: 0.3 });
    act(() => hook.current.cancel());
    expect(hook.current.state).toEqual({ status: 'cancelled' });
    act(() => hook.current.cancel()); // already cancelled: nothing happens
    act(() => pool.jobs[0].options!.onProgress!(0.5)); // a late report changes nothing
    expect(hook.current.state).toEqual({ status: 'cancelled' });
    act(() => hook.current.retry());
    expect(pool.jobs).toHaveLength(2);
    expect(hook.current.state).toEqual({ status: 'running' });
    await act(async () => pool.jobs[1].resolve(result(1)));
    expect(hook.current.state).toEqual({ status: 'done', value: result(1) });
    act(() => hook.current.cancel()); // done: nothing to cancel
    expect(hook.current.state).toEqual({ status: 'done', value: result(1) });
  });

  it('reports errors, and is idle without a config', async () => {
    const pool = new ManualPool();
    const { result: hook, rerender } = renderHook(({ c }: { c: RunConfig | null }) => useCancellableAnalysis(pool, c, {}), { initialProps: { c: config(10) as RunConfig | null } });
    await act(async () => pool.jobs[0].reject(new Error('boom')));
    expect(hook.current.state).toEqual({ status: 'error', message: 'Error: boom' });
    rerender({ c: null });
    expect(hook.current.state).toEqual({ status: 'idle' });
  });

  it('returns a result the pool keeps at once, even in the render where the config changes, and keeps its identity', async () => {
    const inner = new ManualPool();
    const pool = new CachingPool(inner);
    const { result: hook, rerender } = renderHook(({ c }: { c: RunConfig }) => useCancellableAnalysis(pool, c, {}), { initialProps: { c: config(10) } });
    await act(async () => inner.jobs[0].resolve(result(1)));
    rerender({ c: config(20) });
    await act(async () => inner.jobs[1].resolve(result(2)));
    const states: unknown[] = [];
    rerender({ c: config(10) });
    states.push(hook.current.state);
    await waitFor(() => expect(hook.current.state).toEqual({ status: 'done', value: result(1) }));
    expect(states[0]).toEqual({ status: 'done', value: result(1) }); // no 'running' in between
    const first = hook.current;
    rerender({ c: config(10) });
    expect(hook.current).toBe(first); // stable, so effects that depend on it don't re-run
    act(() => hook.current.cancel()); // nothing running: nothing happens
    expect(inner.jobs).toHaveLength(2);
  });
});

/** A pool whose cells wait for the test, recording the order they were asked for. */
class CellPool implements SimPool {
  readonly size = 1;
  readonly cells: Array<{ rps: number; resolve: (s: CellSummary) => void }> = [];
  batch(): SimBatch {
    return {
      analyze: () => Promise.reject(new Error('unused')),
      cell: (c) => new Promise((resolve) => this.cells.push({ rps: c.client.rps, resolve })),
      cancel: () => {},
      cancelled: false,
    };
  }
  dispose(): void {}
}

const sweepOf = (rpss: number[]): SweepSpec => ({
  xAxis: { param: 'rps', label: 'traffic', values: rpss },
  yAxis: { param: 'outageMs', label: 'failure length', values: [1000] },
  cells: rpss.map((x) => ({ x, y: 1000, config: config(x) })),
});
const summary: CellSummary = { verdict: 'recovered', recoveryMs: 0, failedRequests: 0 };

describe('useSweeps', () => {
  it('fills side-by-side maps together, one cell from each in turn, and keeps an unchanged map\'s cells', async () => {
    const pool = new CellPool();
    const before = sweepOf([1, 2, 3]);
    const { result: hook, rerender } = renderHook(({ after }: { after: SweepSpec }) => useSweeps(pool, [before, after]), { initialProps: { after: sweepOf([101, 102, 103]) } });
    expect(pool.cells.map((c) => c.rps)).toEqual([1, 101, 2, 102, 3, 103]);
    await act(async () => pool.cells[1].resolve(summary)); // the after map's first cell
    expect(hook.current[1].done).toBe(1);
    expect(hook.current[0].done).toBe(0);
    await act(async () => pool.cells[0].resolve(summary));
    // Another fix: the after map starts again, the before map keeps its cell and asks only for the rest.
    rerender({ after: sweepOf([201, 202, 203]) });
    expect(hook.current[0].done).toBe(1);
    expect(pool.cells.slice(6).map((c) => c.rps)).toEqual([2, 201, 3, 202, 203]);
  });
});
