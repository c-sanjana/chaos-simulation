/**
 * Runs simulation jobs off the main thread, several at once, and lets callers cancel stale work.
 *
 * - One FIFO queue is shared by every batch; each idle worker takes the next job. A worker runs
 *   one job at a time, so at most `size` jobs are in flight.
 * - A batch groups the jobs of one request (e.g. one tipping-point map). Cancelling it rejects
 *   its unfinished jobs with `CancelledError` straight away: queued ones are removed from the
 *   queue, and running ones have their results discarded when they arrive. A running job cannot
 *   be interrupted (the engine is synchronous), so its worker stays busy until it finishes.
 *   Other batches are unaffected.
 */
import { handleRequest } from './handler';
import type { AnalyzeResult, CellSummary, Job, JobResult } from './jobs';
import type { RunConfig } from '../engine/config';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface SimBatch {
  analyze(config: RunConfig, labels: Record<string, string>): Promise<AnalyzeResult>;
  cell(config: RunConfig): Promise<CellSummary>;
  cancel(): void;
  readonly cancelled: boolean;
}

export interface SimPool {
  batch(): SimBatch;
  dispose(): void;
  /** Jobs that can run at once. */
  readonly size: number;
}

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
  resolve: (result: JobResult) => void;
  reject: (error: Error) => void;
}

export class WorkerPool implements SimPool {
  private workers: WorkerLike[] = [];
  private readonly running = new Map<WorkerLike, Task>();
  private queue: Task[] = [];
  private nextId = 1;
  private disposed = false;

  constructor(size: number, private readonly makeWorker: () => WorkerLike) {
    for (let i = 0; i < size; i++) this.workers.push(this.spawn());
  }

  get size(): number {
    return this.workers.length;
  }

  batch(): SimBatch {
    const state: BatchState = { cancelled: false };
    return {
      analyze: (config, labels) => this.enqueue({ kind: 'analyze', config, labels }, state) as Promise<AnalyzeResult>,
      cell: (config) => this.enqueue({ kind: 'cell', config }, state) as Promise<CellSummary>,
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

  private enqueue(job: Job, batch: BatchState): Promise<JobResult> {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new CancelledError('Simulation pool disposed'));
      if (batch.cancelled) return reject(new CancelledError());
      this.queue.push({ id: this.nextId++, job, batch, resolve, reject });
      this.dispatch();
    });
  }

  /** Hands queued jobs, oldest first, to idle workers. */
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
    // Queued jobs never start. Running ones keep their worker until they finish (see onReply).
    this.queue = this.queue.filter((task) => !mine(task));
  }

  private onReply(w: WorkerLike, msg: WorkerResponse): void {
    const task = this.running.get(w);
    if (!task || msg.type === 'pong' || msg.id !== task.id) return; // not a reply to the job it is running
    this.running.delete(w);
    // A cancelled batch's job was already rejected; its result is discarded.
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

  batch(): SimBatch {
    return this.pool.batch();
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
