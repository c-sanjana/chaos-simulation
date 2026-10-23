import type { Attempt } from './attempt';
import type { Tier } from './tier';

/**
 * One instance of a tier: its own FIFO queue, a pool of workers, and CPU cores.
 *
 * A worker is held from the moment an attempt starts until the tier responds, including while it
 * waits on a downstream call. Computing additionally needs a core; if all cores are busy the worker
 * waits for one (FIFO). With cores >= workers, cores never constrain anything.
 */
export class Instance {
  busyWorkers = 0;
  busyCores = 0;
  peakBusyWorkers = 0;
  peakBusyCores = 0;
  peakQueue = 0;
  private readonly queue: Attempt[] = [];
  private queueHead = 0;
  private readonly coreWaiters: Array<() => void> = [];
  private coreWaitersHead = 0;

  constructor(
    private readonly tier: Tier,
    /** Position within the tier, used to target instance-level faults. */
    readonly index: number,
    readonly workers: number,
    readonly cores: number,
    readonly queueLimit: number | null,
  ) {}

  get queueLength(): number {
    return this.queue.length - this.queueHead;
  }

  /** An attempt arrives: start it, queue it, or reject it if the queue is full. */
  accept(attempt: Attempt): void {
    if (this.busyWorkers < this.workers) {
      this.start(attempt);
    } else if (this.queueLimit !== null && this.queueLength >= this.queueLimit) {
      this.tier.respondUnstarted(attempt, 'rejected');
    } else {
      this.queue.push(attempt);
      this.tier.metrics.queue.add(this.tier.now, 1);
      this.peakQueue = Math.max(this.peakQueue, this.queueLength);
    }
  }

  /** Called by the tier once it has responded for an attempt: frees the worker and starts queued work. */
  freeWorker(): void {
    this.busyWorkers--;
    this.tier.metrics.busyWorkers.add(this.tier.now, -1);
    while (this.queueLength > 0 && this.busyWorkers < this.workers) {
      const next = this.queue[this.queueHead++];
      this.tier.metrics.queue.add(this.tier.now, -1);
      if (this.tier.dropExpired && next.deadlineMs <= this.tier.now) {
        this.tier.respondUnstarted(next, 'dropped');
      } else {
        this.start(next);
      }
    }
    this.compact();
  }

  /** Runs `compute` once a core is free. */
  withCore(compute: () => void): void {
    if (this.busyCores < this.cores) {
      this.busyCores++;
      this.peakBusyCores = Math.max(this.peakBusyCores, this.busyCores);
      this.tier.metrics.busyCores.add(this.tier.now, 1);
      compute();
    } else {
      this.coreWaiters.push(compute);
    }
  }

  /** Hands the core straight to the next waiting worker, if any. */
  releaseCore(): void {
    if (this.coreWaitersHead < this.coreWaiters.length) {
      const next = this.coreWaiters[this.coreWaitersHead++];
      next();
    } else {
      this.busyCores--;
      this.tier.metrics.busyCores.add(this.tier.now, -1);
    }
  }

  private start(attempt: Attempt): void {
    this.busyWorkers++;
    this.peakBusyWorkers = Math.max(this.peakBusyWorkers, this.busyWorkers);
    this.tier.metrics.busyWorkers.add(this.tier.now, 1);
    attempt.state = 'running';
    this.tier.process(attempt, this);
  }

  /** Drops consumed entries from the front of the arrays once they dominate. */
  private compact(): void {
    if (this.queueHead > 1024 && this.queueHead * 2 > this.queue.length) {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
    }
    if (this.coreWaitersHead > 1024 && this.coreWaitersHead * 2 > this.coreWaiters.length) {
      this.coreWaiters.splice(0, this.coreWaitersHead);
      this.coreWaitersHead = 0;
    }
  }
}
