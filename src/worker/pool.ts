/**
 * Runs simulation jobs off the main thread, several at once, and lets callers cancel stale work.
 *
 * - One queue is shared by every batch; each idle worker takes the next job. A worker runs one
 *   job at a time, so at most `size` jobs are in flight. Jobs start in priority order (a batch's
 *   `priority`, higher first: e.g. a replay the viewer is waiting for jumps ahead of map cells),
 *   and in submission order within a priority.
 * - A batch groups the jobs of one request (e.g. one tipping-point map). Cancelling it rejects
 *   its unfinished jobs with `CancelledError` straight away: queued ones are removed from the
 *   queue. A running job can't be interrupted (the engine is synchronous): if it is about to
 *   finish (see KEEP_FINISHING_MS) it runs on and its result goes only to `onResult` (so a cache
 *   can keep it); otherwise its worker is terminated and replaced, so a long run stops at once.
 *   Other batches are unaffected.
 * - Workers report a long job's progress; it reaches the job's `onProgress`.
 */
import { handleRequest } from './handler';
import type { AnalyzeResult, CellSummary, Job, JobResult } from './jobs';
import type { RunConfig } from '../engine/config';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface JobOptions<T> {
  /** The fraction done (0–1), now and then while a long job runs. Not called after cancelling. */
  onProgress?: (fraction: number) => void;
  /**
   * The result, whenever the job finishes successfully: also after its batch was cancelled (when
   * the promise has already been rejected), so a cache can keep finished work.
   */
  onResult?: (result: T) => void;
}

export interface CellOptions extends JobOptions<CellSummary> {
  /**
   * A hint that the full analysis of this config (with these labels) will probably be wanted
   * too, e.g. to replay a fix the ranking tested. A caching pool runs the analysis instead and
   * keeps it; other pools ignore the hint. The promise still resolves with the cell summary.
   */
  analysisLabels?: Record<string, string>;
}

export interface SimBatch {
  analyze(config: RunConfig, labels: Record<string, string>, options?: JobOptions<AnalyzeResult>): Promise<AnalyzeResult>;
  cell(config: RunConfig, options?: CellOptions): Promise<CellSummary>;
  cancel(): void;
  readonly cancelled: boolean;
}

export interface BatchOptions {
  /** Higher runs first (default 0). See PRIORITY. */
  priority?: number;
}

/** The priorities the app uses: what the viewer is waiting to watch first, then the fix ranking, then maps. */
export const PRIORITY = { replay: 2, ranking: 1, map: 0 } as const;

export interface SimPool {
  batch(options?: BatchOptions): SimBatch;
  dispose(): void;
  /** Jobs that can run at once. */
  readonly size: number;
  /** A finished analysis of exactly this job, if the pool keeps results (see CachingPool); never runs anything. */
  peekAnalysis?(config: RunConfig, labels: Record<string, string>): AnalyzeResult | undefined;
}

/**
 * ASSUMPTION: a cancelled job expected to finish within this long runs on (its result is worth
 * keeping, and a new worker would start cold); a longer one is stopped by replacing its worker.
 * The estimate comes from the job's progress reports; until the first one arrives (a job reports
 * after PROGRESS_INTERVAL_MS) it runs on, and is judged again on each report.
 */
export const KEEP_FINISHING_MS = 1000;

/** The job's batch was cancelled, or the pool was disposed, before the job's result was delivered. */
export class CancelledError extends Error {
  constructor(message = 'Simulation job cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

/** The part of the Web Worker API the pool uses (a real `Worker` satisfies it), so tests can fake it. */
export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
}

interface BatchState {
  cancelled: boolean;
}

interface Task {
  id: number;
  job: Job;
  batch: BatchState;
  priority: number;
  resolve: (result: JobResult) => void;
  reject: (error: Error) => void;
  options: JobOptions<JobResult>;
  /** When a worker took it, and its latest progress report (clock ms). */
  startedAt?: number;
  progress?: { fraction: number; atMs: number };
}

export class WorkerPool implements SimPool {
  private workers: WorkerLike[] = [];
  private readonly running = new Map<WorkerLike, Task>();
  private queue: Task[] = [];
  private nextId = 1;
  private disposed = false;

  /** `now` is a clock in ms (injectable for tests). */
  constructor(
    size: number,
    private readonly makeWorker: () => WorkerLike,
    private readonly now: () => number = () => performance.now(),
  ) {
    for (let i = 0; i < size; i++) this.workers.push(this.spawn());
  }

  get size(): number {
    return this.workers.length;
  }

  batch({ priority = 0 }: BatchOptions = {}): SimBatch {
    const state: BatchState = { cancelled: false };
    // The analysis hint of a cell job is for caching pools (see CellOptions); this pool runs the cell.
    return {
      analyze: (config, labels, options = {}) => this.enqueue({ kind: 'analyze', config, labels }, state, priority, options as JobOptions<JobResult>) as Promise<AnalyzeResult>,
      cell: (config, { onProgress, onResult } = {}) => this.enqueue({ kind: 'cell', config }, state, priority, { onProgress, onResult } as JobOptions<JobResult>) as Promise<CellSummary>,
      cancel: () => this.cancelBatch(state),
      get cancelled() {
        return state.cancelled;
      },
    };
  }

  /** Terminates every worker and rejects every unfinished job with `CancelledError`. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.workers) w.terminate();
    const error = new CancelledError('Simulation pool disposed');
    for (const task of [...this.queue, ...this.running.values()]) task.reject(error);
    this.workers = [];
    this.queue = [];
    this.running.clear();
  }

  private spawn(): WorkerLike {
    const w = this.makeWorker();
    w.onmessage = (e) => this.onReply(w, e.data);
    w.onerror = (e) => this.onWorkerFailure(w, `Simulation worker failed: ${e.message || 'unknown error'}`);
    w.onmessageerror = () => this.onWorkerFailure(w, 'Simulation worker sent a message that could not be read');
    return w;
  }

  private enqueue(job: Job, batch: BatchState, priority: number, options: JobOptions<JobResult>): Promise<JobResult> {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new CancelledError('Simulation pool disposed'));
      if (batch.cancelled) return reject(new CancelledError());
      const task: Task = { id: this.nextId++, job, batch, priority, resolve, reject, options };
      // After every queued job of the same or higher priority.
      const at = this.queue.findIndex((t) => t.priority < priority);
      this.queue.splice(at < 0 ? this.queue.length : at, 0, task);
      this.dispatch();
    });
  }

  /** Hands queued jobs, in queue order, to idle workers. */
  private dispatch(): void {
    if (this.workers.length === 0) {
      // Only reachable if every worker failed while idle (see onWorkerFailure).
      for (const task of this.queue) task.reject(new Error('No simulation workers are running'));
      this.queue = [];
      return;
    }
    for (const w of this.workers) {
      if (this.queue.length === 0) return;
      if (this.running.has(w)) continue;
      const task = this.queue.shift()!;
      task.startedAt = this.now();
      this.running.set(w, task);
      w.postMessage({ type: 'job', id: task.id, job: task.job });
    }
  }

  private cancelBatch(batch: BatchState): void {
    if (batch.cancelled) return;
    batch.cancelled = true;
    const error = new CancelledError();
    const mine = (task: Task) => task.batch === batch;
    for (const task of [...this.queue.filter(mine), ...[...this.running.values()].filter(mine)]) task.reject(error);
    // Queued jobs never start. Running ones finish if they are nearly done, else are stopped.
    this.queue = this.queue.filter((task) => !mine(task));
    for (const [w, task] of [...this.running]) if (mine(task)) this.stopIfLong(w, task);
  }

  /** Replaces the worker of a cancelled job that is expected to take longer than KEEP_FINISHING_MS more. */
  private stopIfLong(w: WorkerLike, task: Task): void {
    const p = task.progress;
    if (!p) return; // no estimate yet: judged again on its first progress report
    const elapsed = p.atMs - task.startedAt!;
    const remaining = p.fraction > 0 ? (elapsed * (1 - p.fraction)) / p.fraction : Infinity;
    if (remaining <= KEEP_FINISHING_MS) return;
    w.terminate();
    this.running.delete(w);
    this.workers[this.workers.indexOf(w)] = this.spawn();
    this.dispatch();
  }

  private onReply(w: WorkerLike, msg: WorkerResponse): void {
    const task = this.running.get(w);
    if (!task || msg.type === 'pong' || msg.id !== task.id) return; // not a reply to the job it is running
    if (msg.type === 'progress') {
      task.progress = { fraction: msg.fraction, atMs: this.now() };
      if (task.batch.cancelled) this.stopIfLong(w, task);
      else task.options.onProgress?.(msg.fraction);
      return;
    }
    this.running.delete(w);
    if (msg.type === 'result') task.options.onResult?.(msg.result);
    // A cancelled batch's job was already rejected; its result goes only to onResult.
    if (!task.batch.cancelled) {
      if (msg.type === 'result') task.resolve(msg.result);
      else task.reject(new Error(msg.message));
    }
    this.dispatch();
  }

  /**
   * A worker crashed (`error`) or its reply could not be deserialised (`messageerror`). Its job, if
   * any, fails, and the worker is replaced. A worker that fails while idle is removed instead of
   * replaced: that happens when the worker script cannot load at all, and replacing it would spawn
   * failing workers forever.
   */
  private onWorkerFailure(w: WorkerLike, message: string): void {
    const index = this.workers.indexOf(w);
    if (index < 0) return; // already replaced or disposed
    w.terminate();
    const task = this.running.get(w);
    this.running.delete(w);
    if (task) {
      task.reject(new Error(message));
      this.workers[index] = this.spawn();
    } else {
      this.workers.splice(index, 1);
    }
    this.dispatch();
  }
}

/**
 * Runs jobs in-process, one at a time, on a later macrotask so that callers see the same
 * asynchronous ordering as with real workers. Used in tests and where Web Workers are unavailable.
 * The main thread is blocked while each job runs.
 */
export class InlinePool implements SimPool {
  private readonly pool = new WorkerPool(1, () => new InlineWorker());

  get size(): number {
    return this.pool.size;
  }

  batch(options?: BatchOptions): SimBatch {
    return this.pool.batch(options);
  }

  dispose(): void {
    this.pool.dispose();
  }
}

/** A stand-in for a Web Worker that answers on a setTimeout, in the same thread. */
class InlineWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  onmessageerror: WorkerLike['onmessageerror'] = null;
  private terminated = false;

  postMessage(msg: WorkerRequest): void {
    setTimeout(() => {
      if (this.terminated) return;
      this.onmessage?.({ data: handleRequest(msg, false) } as MessageEvent<WorkerResponse>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** Upper bound on workers, whatever the core count (PLAN.md 9.1). */
const MAX_WORKERS = 8;

/**
 * One worker per spare core (leaving one for the UI), between 1 and 8. Falls back to running jobs
 * in-process if this environment cannot create module workers.
 */
export function createDefaultPool(): SimPool {
  if (typeof Worker === 'undefined') return new InlinePool();
  const cores = navigator.hardwareConcurrency || 1;
  const size = Math.min(MAX_WORKERS, Math.max(1, cores - 1));
  try {
    // Written inline so Vite recognises the pattern and bundles the worker.
    return new WorkerPool(size, () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }));
  } catch {
    return new InlinePool();
  }
}
