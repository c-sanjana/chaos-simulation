import { callWithRetries, type CallTarget } from './caller';
import type { CallPolicy, QueueConfig } from './config';
import type { TierMetrics } from './metrics';
import type { RetryBudget } from './retryBudget';
import { hashPath } from './rng';
import type { Simulation } from './simulation';

/** A stored message: the request it carries and when it was stored. */
export interface Message {
  requestId: number;
  /** Path of the producer attempt that stored it; keys the random values of its consumer call. */
  pathHash: number;
  enqueuedAtMs: number;
}

/**
 * Path branch for a message's consumer call: its tries get paths hashPath(hashPath(message path, 0), n).
 * callWithRetries numbers tries from 1, so branch 0 never coincides with a retry of the producer
 * attempt. The path depends only on the message, so a run and its control draw the same random
 * values (downstream service times, jitter) for the same message.
 */
const CONSUME_BRANCH = 0;

/**
 * The message store and consumer pool of a queue tier (see QueueConfig).
 *
 * Producer side: `offer` stores a message unless `maxDepth` messages are already waiting.
 * Consumer side: whenever a consumer is free and messages are waiting, the oldest message (FIFO) is
 * taken and handed to the tier's downstream with `callWithRetries`. When that call finishes the
 * message is delivered (success) or dead-lettered (failed after its retries: dropped), and the
 * consumer takes the next message.
 *
 * ASSUMPTION: messages being handled by a consumer no longer count towards `maxDepth`; only waiting
 * messages do.
 * ASSUMPTION: a consumer only waits on its downstream call: it needs no worker or core of the tier,
 * and handing a message over takes no time. The tier's compute is the producer-side store.
 * ASSUMPTION: delivery is at least once in effect: a producer that timed out and retried stores
 * the request twice, and both messages are processed (no de-duplication).
 * ASSUMPTION: a dead-lettered message is simply dropped (counted); nothing reprocesses it.
 */
export class MessageQueue {
  private readonly backlog: Message[] = [];
  private head = 0;
  private busy = 0;
  private paused = false;
  private pumpScheduled = false;

  constructor(
    private readonly sim: Simulation,
    private readonly config: QueueConfig,
    /** The tier's downstream call policy: timeout, retries, backoff, jitter. */
    private readonly policy: CallPolicy,
    private readonly target: CallTarget,
    /** The tier's retry budget for that policy, shared by all consumers. */
    private readonly budget: RetryBudget | null,
    /** The tier's metrics: it also counts the consumer calls' timeouts and retries. */
    private readonly metrics: TierMetrics,
  ) {}

  /** Messages waiting for a consumer. */
  get length(): number {
    return this.backlog.length - this.head;
  }

  /** Producer side: stores a message, or returns false if the queue is full. */
  offer(requestId: number, pathHash: number): boolean {
    if (this.length >= this.config.maxDepth) return false;
    this.backlog.push({ requestId, pathHash, enqueuedAtMs: this.sim.now });
    this.metrics.backlog.add(this.sim.now, 1);
    this.schedulePump();
    return true;
  }

  /**
   * Pauses or resumes the consumers (the tier is entirely dead / back). Messages being handled
   * carry on; stored messages are kept.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.schedulePump();
  }

  /**
   * Schedules a pump as a new event at the current time, if one could start work and none is
   * pending. Never starting calls directly keeps the queue free of re-entrant calls: a consumer
   * call can finish synchronously (e.g. refused by a dead downstream) inside another tier's code.
   */
  private schedulePump(): void {
    if (this.pumpScheduled || this.paused || this.length === 0 || this.busy >= this.config.consumers) return;
    this.pumpScheduled = true;
    this.sim.schedule(this.sim.now, () => this.pump());
  }

  /** Hands waiting messages, oldest first, to the consumers that are free when it runs. */
  private pump(): void {
    this.pumpScheduled = false;
    // Only the consumers free now: one freed during this loop (a call that failed synchronously)
    // asks for a new pump instead.
    let free = this.paused ? 0 : this.config.consumers - this.busy;
    while (free > 0 && this.length > 0) {
      free--;
      this.consume(this.backlog[this.head++]);
    }
    this.compact();
  }

  private consume(message: Message): void {
    const { sim, metrics } = this;
    metrics.backlog.add(sim.now, -1);
    this.busy++;
    metrics.busyConsumers.add(sim.now, 1);
    callWithRetries(
      sim,
      this.policy,
      this.target,
      message.requestId,
      hashPath(message.pathHash, CONSUME_BRANCH),
      { stats: metrics, budget: this.budget },
      (ok) => {
        this.busy--;
        metrics.busyConsumers.add(sim.now, -1);
        metrics.messageDone(sim.now, message.enqueuedAtMs, ok);
        this.schedulePump();
      },
    );
  }

  /** Drops taken messages from the front of the array once they dominate. */
  private compact(): void {
    if (this.head > 1024 && this.head * 2 > this.backlog.length) {
      this.backlog.splice(0, this.head);
      this.head = 0;
    }
  }
}
