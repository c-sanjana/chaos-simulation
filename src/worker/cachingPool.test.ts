import type { RunConfig } from '../engine/config';
import { singleTier } from '../engine/testConfigs';
import { CachingPool, Lru, stableKey } from './cachingPool';
import { cellSummaryOf, executeJob, type AnalyzeResult, type CellSummary, type JobResult } from './jobs';
import { CancelledError, InlinePool, type BatchOptions, type JobOptions, type SimBatch, type SimPool } from './pool';

/** One job the inner pool was given; the test settles it. */
interface InnerJob {
  kind: 'analyze' | 'cell';
  config: RunConfig;
  labels?: Record<string, string>;
  priority: number;
  options: JobOptions<JobResult>;
  batch: { cancelled: boolean };
  resolve: (r: JobResult) => void;
  reject: (e: unknown) => void;
}

/** An inner pool whose jobs wait until the test resolves or rejects them. */
class ManualPool implements SimPool {
  readonly size = 2;
  readonly jobs: InnerJob[] = [];
  disposed = false;

  batch({ priority = 0 }: BatchOptions = {}): SimBatch {
    const state = { cancelled: false };
    const add = (kind: InnerJob['kind'], config: RunConfig, labels: Record<string, string> | undefined, options: JobOptions<JobResult> = {}) =>
      new Promise<JobResult>((resolve, reject) => {
        if (state.cancelled) return reject(new CancelledError());
        this.jobs.push({ kind, config, labels, priority, options, batch: state, resolve, reject });
      });
    return {
      analyze: (config, labels, options) => add('analyze', config, labels, options as JobOptions<JobResult>) as Promise<AnalyzeResult>,
      cell: (config, options) => add('cell', config, undefined, options as JobOptions<JobResult>) as Promise<CellSummary>,
      cancel: () => {
        state.cancelled = true;
        for (const j of this.jobs) if (j.batch === state) j.reject(new CancelledError());
      },
      get cancelled() {
        return state.cancelled;
      },
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const j of this.jobs) j.reject(new CancelledError('Simulation pool disposed'));
  }
}

const cfg = (seed: number, rps = 50): RunConfig => ({ ...singleTier(rps, { kind: 'exponential', meanMs: 5 }, 2000), seed });
const summary = (n: number): CellSummary => ({ verdict: 'recovered', recoveryMs: n, failedRequests: 0 });
/** A stand-in analysis (only the recovery part is read by the cache). */
const analysis = (n: number) => ({ run: {}, control: {}, analysis: { recovery: { ...summary(n), extra: 'x' } } }) as unknown as AnalyzeResult;
const flush = () => new Promise((r) => setTimeout(r, 0));
function track<T>(p: Promise<T>) {
  const state: { value?: T; error?: unknown; settled: boolean } = { settled: false };
  p.then(
    (value) => Object.assign(state, { value, settled: true }),
    (error) => Object.assign(state, { error, settled: true }),
  );
  return state;
}

describe('stableKey', () => {
  it('tells apart what JSON conflates, and keeps key order', () => {
    const keys = [{ a: NaN }, { a: null }, { a: Infinity }, { a: -Infinity }, { a: -0 }, { a: 0 }, { a: undefined }, {}, { a: '#NaN' }, { a: '$x' }, { a: 'x' }].map(stableKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(stableKey({ a: 1, b: 2 })).not.toBe(stableKey({ b: 2, a: 1 }));
    expect(stableKey({ a: [1, { b: 'c' }] })).toBe(stableKey({ a: [1, { b: 'c' }] }));
  });
});

describe('Lru', () => {
  it('forgets the least recently used entry beyond its limit; reading counts as use', () => {
    const lru = new Lru<number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    expect(lru.get('a')).toBe(1); // a is now the most recent
    lru.set('c', 3);
    expect([lru.get('a'), lru.get('b'), lru.get('c')]).toEqual([1, undefined, 3]);
    lru.set('a', 4); // replacing keeps one entry
    expect(lru.size).toBe(2);
    lru.clear();
    expect(lru.size).toBe(0);
  });
});

describe('CachingPool', () => {
  it('runs a job once and answers the same request again from its result, asynchronously', async () => {
    const inner = new ManualPool();
    const pool = new CachingPool(inner);
    expect(pool.size).toBe(2);
    const first = pool.batch().cell(cfg(1));
    inner.jobs[0].resolve(summary(1));
    await expect(first).resolves.toEqual(summary(1));
    let settled = false;
    const again = pool.batch().cell(cfg(1)).then((r) => ((settled = true), r));
    expect(settled).toBe(false);
    await expect(again).resolves.toEqual(summary(1));
    expect(inner.jobs).toHaveLength(1);
  });

  it('keys by everything that affects a result: config (seed included), kind and labels', async () => {
    const inner = new ManualPool();
    const pool = new CachingPool(inner);
    const b = pool.batch();
    void b.cell(cfg(1));
    void b.cell(cfg(2)); // another seed
    void b.cell(cfg(1, 60)); // other traffic
    void b.analyze(cfg(1), { svc: 'Service' });
    void b.analyze(cfg(1), { svc: 'API' }); // other labels: other text
    expect(inner.jobs.map((j) => j.kind)).toEqual(['cell', 'cell', 'cell', 'analyze', 'analyze']);
  });

  it('answers a cell from a finished analysis of the same config, and peeks analyses without running anything', async () => {
    const inner = new ManualPool();
    const pool = new CachingPool(inner);
    expect(pool.peekAnalysis(cfg(1), {})).toBeUndefined();
    const full = pool.batch().analyze(cfg(1), {});
    inner.jobs[0].resolve(analysis(7));
    await full;
    expect(pool.peekAnalysis(cfg(1), {})).toBe(await full);
    expect(pool.peekAnalysis(cfg(1), { other: 'labels' })).toBeUndefined();
    await expect(pool.batch().cell(cfg(1))).resolves.toEqual(summary(7));
    expect(inner.jobs).toHaveLength(1);
  });

  describe('cells with an analysis hint (the fix ranking)', () => {
    it('runs the analysis instead, keeps both, and resolves with the cell summary', async () => {
      const inner = new ManualPool();
      const pool = new CachingPool(inner);
      const cell = pool.batch({ priority: 1 }).cell(cfg(1), { analysisLabels: { svc: 'S' } });
      expect(inner.jobs[0]).toMatchObject({ kind: 'analyze', labels: { svc: 'S' }, priority: 1 });
      inner.jobs[0].resolve(analysis(3));
      await expect(cell).resolves.toEqual(summary(3));
      expect(pool.peekAnalysis(cfg(1), { svc: 'S' })).toEqual(analysis(3)); // the replay reuses it
      await expect(pool.batch().cell(cfg(1))).resolves.toEqual(summary(3));
      expect(inner.jobs).toHaveLength(1);
    });

    it('is answered by a kept cell or analysis, and joins a cell job already running', async () => {
      const inner = new ManualPool();
      const pool = new CachingPool(inner);
      const plain = pool.batch().cell(cfg(1));
      const hinted = pool.batch().cell(cfg(1), { analysisLabels: {} }); // joins the running cell job
      expect(inner.jobs).toHaveLength(1);
      inner.jobs[0].resolve(summary(1));
      expect(await hinted).toEqual(await plain);
      await expect(pool.batch().cell(cfg(1), { analysisLabels: {} })).resolves.toEqual(summary(1));
      const full = pool.batch().analyze(cfg(2), {});
      inner.jobs[1].resolve(analysis(2));
      await full;
      await expect(pool.batch().cell(cfg(2), { analysisLabels: {} })).resolves.toEqual(summary(2));
      expect(inner.jobs).toHaveLength(2);
    });
  });

  describe('requests in flight', () => {
    it('share one job, with its progress, across batches', async () => {
      const inner = new ManualPool();
      const pool = new CachingPool(inner);
      const heard: string[] = [];
      const a = pool.batch().analyze(cfg(1), {}, { onProgress: (f) => heard.push(`a${f}`) });
      const b = pool.batch().analyze(cfg(1), {}, { onProgress: (f) => heard.push(`b${f}`) });
      expect(inner.jobs).toHaveLength(1);
      inner.jobs[0].options.onProgress!(0.5);
      expect(heard).toEqual(['a0.5', 'b0.5']);
      inner.jobs[0].resolve(analysis(1));
      expect(await a).toBe(await b);
    });

    it('cancelling one request leaves the shared job running for the others; cancelling all cancels it', async () => {
      const inner = new ManualPool();
      const pool = new CachingPool(inner);
      const one = pool.batch();
      const two = pool.batch();
      const r1 = track(one.cell(cfg(1)));
      const r2 = track(two.cell(cfg(1)));
      one.cancel();
      one.cancel(); // harmless
      await flush();
      expect(r1.error).toBeInstanceOf(CancelledError);
      expect(inner.jobs[0].batch.cancelled).toBe(false);
      two.cancel();
      await flush();
      expect(r2.error).toBeInstanceOf(CancelledError);
      expect(inner.jobs[0].batch.cancelled).toBe(true);
      // Nothing was kept: the next request runs the job again.
      void pool.batch().cell(cfg(1));
      expect(inner.jobs).toHaveLength(2);
      expect(one.cancelled).toBe(true);
      await expect(one.cell(cfg(9))).rejects.toBeInstanceOf(CancelledError);
    });

    it('keeps a result that arrives after every request was cancelled (onResult)', async () => {
      const inner = new ManualPool();
      const pool = new CachingPool(inner);
      const batch = pool.batch();
      void batch.analyze(cfg(1), {}).catch(() => {});
      batch.cancel();
      inner.jobs[0].options.onResult!(analysis(4)); // the worker finished it anyway
      expect(pool.peekAnalysis(cfg(1), {})).toEqual(analysis(4));
      await expect(pool.batch().cell(cfg(1))).resolves.toEqual(summary(4));
      expect(inner.jobs).toHaveLength(1);
    });

    it('never keeps an error: the job runs again next time', async () => {
      const inner = new ManualPool();
      const pool = new CachingPool(inner);
      const failed = pool.batch().cell(cfg(1));
      inner.jobs[0].reject(new Error('worker crashed'));
      await expect(failed).rejects.toThrow('worker crashed');
      const retried = pool.batch().cell(cfg(1));
      expect(inner.jobs).toHaveLength(2);
      inner.jobs[1].resolve(summary(1));
      await expect(retried).resolves.toEqual(summary(1));
    });

    it('starts a job with the priority of the batch that asked first', () => {
      const inner = new ManualPool();
      const pool = new CachingPool(inner);
      void pool.batch().cell(cfg(1));
      void pool.batch({ priority: 2 }).analyze(cfg(2), {});
      expect(inner.jobs.map((j) => j.priority)).toEqual([0, 2]);
    });
  });

  it('stays within its limits, forgetting the least recently used results', async () => {
    const inner = new ManualPool();
    const pool = new CachingPool(inner, { cells: 2, analyses: 1 });
    for (const seed of [1, 2, 3]) {
      const p = pool.batch().cell(cfg(seed));
      inner.jobs.at(-1)!.resolve(summary(seed));
      await p;
    }
    void pool.batch().cell(cfg(1)); // forgotten: runs again
    void pool.batch().cell(cfg(3)); // kept
    expect(inner.jobs.map((j) => j.config.seed)).toEqual([1, 2, 3, 1]);
    for (const seed of [4, 5]) {
      const p = pool.batch().analyze(cfg(seed), {});
      inner.jobs.at(-1)!.resolve(analysis(seed));
      await p;
    }
    expect(pool.peekAnalysis(cfg(4), {})).toBeUndefined();
    expect(pool.peekAnalysis(cfg(5), {})).toEqual(analysis(5));
  });

  it('dispose: disposes the inner pool, rejects what is pending and refuses new work', async () => {
    const inner = new ManualPool();
    const pool = new CachingPool(inner);
    const pending = pool.batch().cell(cfg(1));
    pool.dispose();
    expect(inner.disposed).toBe(true);
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    await expect(pool.batch().cell(cfg(1))).rejects.toThrow('Simulation pool disposed');
    inner.jobs[0].options.onResult?.(summary(1)); // late: nothing kept after dispose
  });

  it('gives exactly the results of a fresh run (real in-process pool)', async () => {
    const config = { ...cfg(3, 80), faults: [{ tier: 'svc', kind: 'slow' as const, factor: 4, startMs: 500, endMs: 1000 }] };
    const pool = new CachingPool(new InlinePool());
    const full = await pool.batch().analyze(config, { svc: 'Service' });
    expect(full).toEqual(executeJob({ kind: 'analyze', config, labels: { svc: 'Service' } }));
    await expect(pool.batch().cell(config)).resolves.toEqual(executeJob({ kind: 'cell', config }));
    expect(cellSummaryOf(full)).toEqual(executeJob({ kind: 'cell', config }));
    pool.dispose();
  });
});
