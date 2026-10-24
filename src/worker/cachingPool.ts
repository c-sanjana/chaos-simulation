/**
 * Keeps finished simulation results so that work is never done twice: switching steps, coming back
 * to earlier settings, step 3's "before" map (the same cells as step 2's map) and the replay of a
 * fix the ranking already tested are answered from here.
 *
 * - A result is keyed by everything that determines it: the job kind, the whole run config (seed
 *   included) and, for an analysis, the labels its text uses. The engine is deterministic, so a
 *   kept result is exactly what a fresh run of that key gives.
 * - Identical requests in flight share one job; it is cancelled only when every request for it is.
 * - Only successful results are kept: errors and cancellations never are. A job finished after
 *   its requests were cancelled is still kept (see JobOptions.onResult).
 * - Memory is bounded: least recently used results are dropped beyond CACHE_LIMITS.
 * - Kept results are shared by every caller: treat them as read-only (results already are).
 */
import type { RunConfig } from '../engine/config';
import { cellSummaryOf, type AnalyzeResult, type CellSummary, type JobResult } from './jobs';
import { CancelledError, type BatchOptions, type JobOptions, type SimBatch, type SimPool } from './pool';

/**
 * ASSUMPTION: a cell summary is a few dozen bytes; an analysis holds two whole runs (~165k
 * numbers, ~1.5 MB for the presets). These limits keep the cache to a few tens of MB while
 * holding several configs' maps (60–120 cells each) and fix rankings (about 10 analyses each).
 */
export const CACHE_LIMITS = { cells: 600, analyses: 24 };

/**
 * A key that tells apart every value a structured clone (how configs reach a worker) tells
 * apart, including key order, `undefined`, NaN, ±Infinity and -0, which plain JSON conflates.
 * Strings are prefixed so that they can never collide with those encodings.
 */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'string') return `$${v}`;
    if (v === undefined) return '#undefined';
    if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) return Object.is(v, -0) ? '#-0' : `#${v}`;
    return v;
  });
}

const cellKey = (config: RunConfig) => `cell ${stableKey(config)}`;
const analysisKey = (config: RunConfig, labels: Record<string, string>) => `analyze ${stableKey(config)} ${stableKey(labels)}`;

/** A map that forgets its least recently used entries beyond `limit`. */
export class Lru<V> {
  private readonly map = new Map<string, V>();

  constructor(readonly limit: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value!);
  }

  clear(): void {
    this.map.clear();
  }
}

interface Subscriber {
  outer: OuterBatch;
  shared: Shared;
  map: (raw: JobResult) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  onProgress?: (fraction: number) => void;
}

/** One job in the inner pool, shared by every request for its key. */
interface Shared {
  key: string;
  inner: SimBatch;
  subscribers: Set<Subscriber>;
}

interface OuterBatch {
  cancelled: boolean;
  /** Its requests waiting for a shared job. */
  pending: Set<Subscriber>;
}

export class CachingPool implements SimPool {
  private readonly cells: Lru<CellSummary>;
  private readonly analyses: Lru<AnalyzeResult>;
  private readonly inflight = new Map<string, Shared>();
  private disposed = false;

  constructor(
    private readonly inner: SimPool,
    limits: { cells: number; analyses: number } = CACHE_LIMITS,
  ) {
    this.cells = new Lru(limits.cells);
    this.analyses = new Lru(limits.analyses);
  }

  get size(): number {
    return this.inner.size;
  }

  peekAnalysis(config: RunConfig, labels: Record<string, string>): AnalyzeResult | undefined {
    return this.analyses.get(analysisKey(config, labels));
  }

  batch(options: BatchOptions = {}): SimBatch {
    const outer: OuterBatch = { cancelled: false, pending: new Set() };
    return {
      analyze: (config, labels, jobOptions = {}) => {
        const key = analysisKey(config, labels);
        return this.request(outer, key, this.analyses.get(key), (r) => r, jobOptions, () =>
          this.start<AnalyzeResult>(key, options, (inner, o) => inner.analyze(config, labels, o), (r) => this.keepAnalysis(key, config, r)),
        ) as Promise<AnalyzeResult>;
      },
      cell: (config, { analysisLabels, ...jobOptions } = {}) => {
        const key = cellKey(config);
        // A finished or running analysis of the same config answers the cell too.
        const aKey = analysisLabels && analysisKey(config, analysisLabels);
        const analysed = aKey ? this.analyses.get(aKey) : undefined;
        const hit = this.cells.get(key) ?? (analysed && cellSummaryOf(analysed));
        if (aKey && hit === undefined && !this.inflight.has(key)) {
          return this.request(outer, aKey, undefined, (r) => cellSummaryOf(r as AnalyzeResult), jobOptions, () =>
            this.start<AnalyzeResult>(aKey, options, (inner, o) => inner.analyze(config, analysisLabels!, o), (r) => this.keepAnalysis(aKey, config, r)),
          ) as Promise<CellSummary>;
        }
        return this.request(outer, key, hit, (r) => r, jobOptions, () =>
          this.start<CellSummary>(key, options, (inner, o) => inner.cell(config, o), (r) => this.cells.set(key, r)),
        ) as Promise<CellSummary>;
      },
      cancel: () => this.cancel(outer),
      get cancelled() {
        return outer.cancelled;
      },
    };
  }

  /** Disposes the inner pool (which rejects its unfinished jobs) and forgets every result. */
  dispose(): void {
    this.disposed = true;
    this.inner.dispose();
    this.cells.clear();
    this.analyses.clear();
  }

  private keepAnalysis(key: string, config: RunConfig, result: AnalyzeResult): void {
    this.analyses.set(key, result);
    this.cells.set(cellKey(config), cellSummaryOf(result));
  }

  /** Answers from the cache, joins the job in flight for `key`, or starts one. */
  private request(
    outer: OuterBatch,
    key: string,
    hit: unknown,
    map: (raw: JobResult) => unknown,
    { onProgress }: JobOptions<never>,
    start: () => Shared,
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(new CancelledError('Simulation pool disposed'));
    if (outer.cancelled) return Promise.reject(new CancelledError());
    if (hit !== undefined) return Promise.resolve(hit);
    const shared = this.inflight.get(key) ?? start();
    return new Promise((resolve, reject) => {
      const sub: Subscriber = { outer, shared, map, resolve, reject, onProgress };
      shared.subscribers.add(sub);
      outer.pending.add(sub);
    });
  }

  /**
   * Starts the inner job for `key`. ASSUMPTION: it keeps the priority of the batch that asked
   * first; a later, more urgent request for the same job doesn't move it up the queue.
   */
  private start<T extends JobResult>(
    key: string,
    options: BatchOptions,
    run: (inner: SimBatch, o: JobOptions<T>) => Promise<T>,
    keep: (result: T) => void,
  ): Shared {
    const shared: Shared = { key, inner: this.inner.batch(options), subscribers: new Set() };
    this.inflight.set(key, shared);
    const settle = (deliver: (sub: Subscriber) => void) => {
      if (this.inflight.get(key) === shared) this.inflight.delete(key);
      for (const sub of shared.subscribers) {
        sub.outer.pending.delete(sub);
        deliver(sub);
      }
      shared.subscribers.clear();
    };
    run(shared.inner, {
      onProgress: (fraction) => shared.subscribers.forEach((s) => s.onProgress?.(fraction)),
      onResult: (r) => this.disposed || keep(r), // also after every request was cancelled
    }).then(
      (r) => {
        if (!this.disposed) keep(r);
        settle((sub) => sub.resolve(sub.map(r)));
      },
      (e: unknown) => settle((sub) => sub.reject(e)),
    );
    return shared;
  }

  /** Rejects the batch's pending requests; a shared job nobody wants any more is cancelled. */
  private cancel(outer: OuterBatch): void {
    if (outer.cancelled) return;
    outer.cancelled = true;
    for (const sub of outer.pending) {
      const { shared } = sub;
      shared.subscribers.delete(sub);
      sub.reject(new CancelledError());
      if (shared.subscribers.size === 0) {
        if (this.inflight.get(shared.key) === shared) this.inflight.delete(shared.key);
        shared.inner.cancel();
      }
    }
    outer.pending.clear();
  }
}
