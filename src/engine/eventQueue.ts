/**
 * The simulation's event queue: a binary min-heap of scheduled callbacks.
 *
 * Ordered by time; events at the same time fire in the order they were pushed (FIFO), using a
 * monotonically increasing sequence number as the tie-breaker. Because ordering never depends on
 * anything else (object identity, sort stability), a run is bit-for-bit repeatable.
 *
 * Entries are stored in three parallel arrays rather than as objects, so push and pop allocate
 * nothing beyond occasional array growth.
 */
export class EventQueue {
  private readonly times: number[] = [];
  private readonly seqs: number[] = [];
  private readonly fires: ((() => void) | undefined)[] = [];
  private nextSeq = 0;
  private count = 0;

  /** Number of scheduled events. */
  get size(): number {
    return this.count;
  }

  /** Schedules `fire` to run at `timeMs`. Throws on NaN, which would silently corrupt the order. */
  push(timeMs: number, fire: () => void): void {
    if (timeMs !== timeMs) throw new Error('EventQueue.push: time is NaN');
    const seq = this.nextSeq++;
    const { times, seqs, fires } = this;
    // Sift up: move parents down into the hole until the new entry's place is found.
    let i = this.count++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pt = times[parent];
      if (pt < timeMs || (pt === timeMs && seqs[parent] < seq)) break;
      times[i] = pt;
      seqs[i] = seqs[parent];
      fires[i] = fires[parent];
      i = parent;
    }
    times[i] = timeMs;
    seqs[i] = seq;
    fires[i] = fire;
  }

  /** Time of the earliest event, or Infinity when the queue is empty. */
  peekTime(): number {
    return this.count > 0 ? this.times[0] : Infinity;
  }

  /** Removes and returns the earliest event's callback (FIFO among equal times), or undefined if empty. */
  pop(): (() => void) | undefined {
    if (this.count === 0) return undefined;
    const { times, seqs, fires } = this;
    const top = fires[0];
    const n = --this.count;
    // Take the last entry out and sift it down from the root.
    const t = times[n];
    const s = seqs[n];
    const f = fires[n];
    fires[n] = undefined; // release the closure for garbage collection
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      const right = child + 1;
      if (right < n && (times[right] < times[child] || (times[right] === times[child] && seqs[right] < seqs[child]))) {
        child = right;
      }
      const ct = times[child];
      if (t < ct || (t === ct && s < seqs[child])) break;
      times[i] = ct;
      seqs[i] = seqs[child];
      fires[i] = fires[child];
      i = child;
    }
    if (n > 0) {
      times[i] = t;
      seqs[i] = s;
      fires[i] = f;
    }
    return top;
  }
}
