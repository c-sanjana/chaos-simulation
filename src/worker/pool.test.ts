import type { RunConfig } from '../engine/config';
import { singleTier } from '../engine/testConfigs';
import { executeJob, type CellSummary } from './jobs';
import { CancelledError, InlinePool, WorkerPool, createDefaultPool, type WorkerLike } from './pool';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** A worker that records the jobs it is given and replies only when the test says so. */
class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  onmessageerror: WorkerLike['onmessageerror'] = null;
  posted: WorkerRequest[] = [];
  terminated = false;
  /** Jobs posted but not yet replied to. */
  inFlight = 0;

  postMessage(msg: WorkerRequest): void {
    this.posted.push(msg);
    this.inFlight++;
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The seed of the job this worker is running (jobs are told apart by seed). */
  get currentSeed(): number {
    const msg = this.posted.at(-1);
    if (msg?.type !== 'job') throw new Error('no job posted');
    return msg.job.config.seed;
  }

  send(data: WorkerResponse): void {
    this.onmessage!({ data } as MessageEvent<WorkerResponse>);
  }

  /** Replies to the current job with a summary whose failedRequests is the job's seed. */
  finish(): void {
    const msg = this.posted.at(-1)!;
    this.inFlight--;
    this.send({ type: 'result', id: msg.id, result: summary(this.currentSeed) });
  }
}

const summary = (n: number): CellSummary => ({ verdict: 'recovered', recoveryMs: 0, failedRequests: n });
/** A config identified by its seed; fake workers never run it. */
const cfg = (seed: number) => ({ seed }) as RunConfig;

function fakePool(size: number) {
  const workers: FakeWorker[] = [];
  const pool = new WorkerPool(size, () => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  /** Workers still in the pool (replaced ones are terminated). */
  const live = () => workers.filter((w) => !w.terminated);
  return { pool, workers, live };
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Records how a promise settled, without leaving rejections unhandled. */
function track<T>(p: Promise<T>) {
  const state: { value?: T; error?: unknown; settled: boolean } = { settled: false };
  p.then(
    (value) => Object.assign(state, { value, settled: true }),
    (error) => Object.assign(state, { error, settled: true }),
  );
  return state;
}

describe('WorkerPool', () => {
  it('creates `size` workers', () => {
    const { pool, workers } = fakePool(3);
    expect(pool.size).toBe(3);
    expect(workers).toHaveLength(3);
  });

  it('never runs more than `size` jobs at once, and starts the next job as soon as a worker is free', async () => {
    const { pool, workers } = fakePool(2);
    const batch = pool.batch();
    const results = [1, 2, 3, 4, 5].map((s) => track(batch.cell(cfg(s))));
    const inFlight = () => workers.reduce((n, w) => n + w.inFlight, 0);

    expect(inFlight()).toBe(2);
    for (let finished = 1; finished <= 5; finished++) {
      workers.find((w) => w.inFlight > 0)!.finish();
      expect(inFlight()).toBe(Math.min(2, 5 - finished));
    }
    await flush();
    expect(results.map((r) => (r.value as CellSummary).failedRequests)).toEqual([1, 2, 3, 4, 5]);
  });

  it('starts jobs in submission order across batches (one FIFO queue)', async () => {
    const { pool, workers } = fakePool(1);
    const a = pool.batch();
    const b = pool.batch();
    void a.cell(cfg(1));
    void b.cell(cfg(2));
    void a.cell(cfg(3));
    void b.analyze(cfg(4), {});
    const started = [workers[0].currentSeed];
    for (let i = 0; i < 3; i++) {
      workers[0].finish();
      started.push(workers[0].currentSeed);
    }
    expect(started).toEqual([1, 2, 3, 4]);
    expect(workers[0].posted.map((m) => m.type === 'job' && m.job.kind)).toEqual(['cell', 'cell', 'cell', 'analyze']);
  });

  it('passes analyze jobs with their labels', () => {
    const { pool, workers } = fakePool(1);
    void pool.batch().analyze(cfg(1), { db: 'DB' });
    expect(workers[0].posted[0]).toEqual({ type: 'job', id: expect.any(Number), job: { kind: 'analyze', config: cfg(1), labels: { db: 'DB' } } });
  });

  it('matches each reply to its job, and rejects a job the worker reports as failed', async () => {
    const { pool, workers } = fakePool(2);
    const batch = pool.batch();
    const first = batch.cell(cfg(1));
    const second = track(batch.cell(cfg(2)));
    workers[1].finish();
    await flush();
    expect(second.value).toEqual(summary(2));
    const id = workers[0].posted[0].id;
    workers[0].send({ type: 'error', id, message: 'Invalid config: boom' });
    await expect(first).rejects.toThrow('Invalid config: boom');
    expect(workers[0].terminated).toBe(false); // the worker itself is fine
  });

  it('ignores messages that are not a reply to the running job', async () => {
    const { pool, workers } = fakePool(1);
    const job = track(pool.batch().cell(cfg(1)));
    const id = workers[0].posted[0].id;
    workers[0].send({ type: 'pong', id, crossOriginIsolated: false });
    workers[0].send({ type: 'result', id: id + 100, result: summary(9) });
    await flush();
    expect(job.settled).toBe(false);
    workers[0].finish();
    await flush();
    expect(job.value).toEqual(summary(1));
    workers[0].send({ type: 'result', id, result: summary(9) }); // idle worker: ignored
  });

  describe('cancellation', () => {
    it('rejects a cancelled batch\'s queued jobs immediately and never starts them; other batches carry on', async () => {
      const { pool, workers } = fakePool(1);
      const a = pool.batch();
      const b = pool.batch();
      const running = track(b.cell(cfg(1)));
      const queuedA = [track(a.cell(cfg(2))), track(a.cell(cfg(3)))];
      const queuedB = track(b.cell(cfg(4)));

      a.cancel();
      expect(a.cancelled).toBe(true);
      expect(b.cancelled).toBe(false);
      await flush();
      for (const q of queuedA) expect(q.error).toBeInstanceOf(CancelledError);

      workers[0].finish();
      expect(workers[0].currentSeed).toBe(4); // skipped a's jobs
      workers[0].finish();
      await flush();
      expect(running.value).toEqual(summary(1));
      expect(queuedB.value).toEqual(summary(4));
    });

    it('rejects a running job of a cancelled batch, discards its result, and keeps its worker busy until it finishes', async () => {
      const { pool, workers } = fakePool(1);
      const a = pool.batch();
      const b = pool.batch();
      const running = track(a.cell(cfg(1)));
      const next = track(b.cell(cfg(2)));

      a.cancel();
      await flush();
      expect(running.error).toBeInstanceOf(CancelledError);
      expect(workers[0].posted).toHaveLength(1); // still busy with the cancelled job

      workers[0].finish(); // the discarded result
      expect(workers[0].currentSeed).toBe(2);
      workers[0].finish();
      await flush();
      expect(running.value).toBeUndefined();
      expect(next.value).toEqual(summary(2));
    });

    it('rejects new jobs on a cancelled batch, and cancelling twice is harmless', async () => {
      const { pool, workers } = fakePool(1);
      const batch = pool.batch();
      batch.cancel();
      batch.cancel();
      await expect(batch.cell(cfg(1))).rejects.toBeInstanceOf(CancelledError);
      await expect(batch.analyze(cfg(1), {})).rejects.toBeInstanceOf(CancelledError);
      expect(workers[0].posted).toHaveLength(0);
    });
  });

  describe('worker failures', () => {
    it('rejects the running job on a worker error, and replaces the worker, which takes the next job', async () => {
      const { pool, workers, live } = fakePool(1);
      const batch = pool.batch();
      const crashed = batch.cell(cfg(1));
      const next = batch.cell(cfg(2));

      workers[0].onerror!({ message: 'out of memory' } as ErrorEvent);
      await expect(crashed).rejects.toThrow('Simulation worker failed: out of memory');
      expect(workers[0].terminated).toBe(true);
      expect(workers).toHaveLength(2);
      expect(pool.size).toBe(1);

      expect(live()[0].currentSeed).toBe(2);
      live()[0].finish();
      await expect(next).resolves.toEqual(summary(2));
    });

    it('treats an unreadable reply (messageerror) the same way', async () => {
      const { pool, workers } = fakePool(1);
      const job = pool.batch().cell(cfg(1));
      workers[0].onmessageerror!({} as MessageEvent);
      await expect(job).rejects.toThrow('could not be read');
      expect(workers[0].terminated).toBe(true);
      expect(pool.size).toBe(1);
    });

    it('describes an error event without a message', async () => {
      const { pool, workers } = fakePool(1);
      const job = pool.batch().cell(cfg(1));
      workers[0].onerror!({ message: '' } as ErrorEvent);
      await expect(job).rejects.toThrow('unknown error');
    });

    it('ignores events from a worker it has already replaced', () => {
      const { pool, workers } = fakePool(1);
      void pool.batch().cell(cfg(1)).catch(() => {});
      const old = workers[0];
      old.onerror!({ message: 'x' } as ErrorEvent);
      old.onerror!({ message: 'x' } as ErrorEvent);
      expect(workers).toHaveLength(2);
      expect(pool.size).toBe(1);
    });

    it('removes a worker that fails while idle (e.g. its script failed to load) instead of respawning it', async () => {
      const { pool, workers } = fakePool(2);
      workers[0].onerror!({ message: 'load failed' } as ErrorEvent);
      expect(pool.size).toBe(1);
      expect(workers).toHaveLength(2);

      const job = pool.batch().cell(cfg(1));
      workers[1].finish();
      await expect(job).resolves.toEqual(summary(1));

      workers[1].onerror!({ message: 'load failed' } as ErrorEvent);
      expect(pool.size).toBe(0);
      await expect(pool.batch().cell(cfg(2))).rejects.toThrow('No simulation workers are running');
    });
  });

  describe('dispose', () => {
    it('terminates every worker and rejects queued and running jobs with CancelledError', async () => {
      const { pool, workers } = fakePool(2);
      const batch = pool.batch();
      const jobs = [1, 2, 3].map((s) => batch.cell(cfg(s)));
      pool.dispose();
      for (const job of jobs) await expect(job).rejects.toThrow(new CancelledError('Simulation pool disposed'));
      expect(workers.every((w) => w.terminated)).toBe(true);
      expect(pool.size).toBe(0);
    });

    it('rejects jobs submitted afterwards, ignores late replies, and can be called twice', async () => {
      const { pool, workers } = fakePool(1);
      const batch = pool.batch();
      void batch.cell(cfg(1)).catch(() => {});
      pool.dispose();
      pool.dispose();
      workers[0].finish(); // a reply already on its way when the worker was terminated
      await expect(batch.cell(cfg(2))).rejects.toBeInstanceOf(CancelledError);
      expect(workers).toHaveLength(1);
    });
  });
});

describe('CancelledError', () => {
  it('is an Error with its own name', () => {
    const e = new CancelledError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('CancelledError');
    expect(e.message).toBe('Simulation job cancelled');
  });
});

describe('InlinePool', () => {
  // A small real run: one tier, slowed down for a second.
  const config: RunConfig = {
    ...singleTier(50, { kind: 'exponential', meanMs: 5 }, 5000, {}, { timeoutMs: 200 }),
    faults: [{ tier: 'svc', kind: 'slow', factor: 4, startMs: 1000, endMs: 2000 }],
  };

  it('runs one job at a time, in-process, with the same results as executeJob', async () => {
    const pool = new InlinePool();
    expect(pool.size).toBe(1);
    const batch = pool.batch();
    await expect(batch.cell(config)).resolves.toEqual(executeJob({ kind: 'cell', config }));
    const full = await batch.analyze(config, { svc: 'Service' });
    expect(full).toEqual(executeJob({ kind: 'analyze', config, labels: { svc: 'Service' } }));
  });

  it('settles asynchronously and in submission order', async () => {
    const batch = new InlinePool().batch();
    const order: number[] = [];
    const jobs = [batch.cell(config).then(() => order.push(1)), batch.cell({ ...config, seed: 8 }).then(() => order.push(2))];
    expect(order).toEqual([]);
    await Promise.all(jobs);
    expect(order).toEqual([1, 2]);
  });

  it('rejects a job whose config is invalid', async () => {
    const batch = new InlinePool().batch();
    await expect(batch.cell({ ...config, durationMs: 0 })).rejects.toThrow('Invalid config: durationMs');
  });

  it('supports cancellation and dispose', async () => {
    const pool = new InlinePool();
    const batch = pool.batch();
    const job = batch.cell(config);
    batch.cancel();
    await expect(job).rejects.toBeInstanceOf(CancelledError);
    const other = pool.batch().cell(config);
    pool.dispose();
    await expect(other).rejects.toBeInstanceOf(CancelledError);
    await flush(); // the terminated in-process worker's timer fires and is ignored
  });
});

describe('createDefaultPool', () => {
  const created: { url: URL; options: WorkerOptions }[] = [];
  class StubWorker extends FakeWorker {
    constructor(url: URL, options: WorkerOptions) {
      super();
      created.push({ url, options });
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    created.length = 0;
  });

  it('falls back to the in-process pool when Web Workers are unavailable', () => {
    vi.stubGlobal('Worker', undefined);
    expect(createDefaultPool()).toBeInstanceOf(InlinePool);
  });

  it.each([
    [16, 8],
    [9, 8],
    [4, 3],
    [2, 1],
    [1, 1],
    [undefined, 1],
  ])('with %s cores, starts %i module workers', (cores, expected) => {
    vi.stubGlobal('Worker', StubWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: cores });
    const pool = createDefaultPool();
    expect(pool).toBeInstanceOf(WorkerPool);
    expect(pool.size).toBe(expected);
    expect(created).toHaveLength(expected);
    expect(created[0].url.pathname).toMatch(/\/src\/worker\/sim\.worker\.ts$/);
    expect(created[0].options).toEqual({ type: 'module' });
  });

  it('falls back to the in-process pool when a worker cannot be created', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('SecurityError');
        }
      },
    );
    expect(createDefaultPool()).toBeInstanceOf(InlinePool);
  });
});
