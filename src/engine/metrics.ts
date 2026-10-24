import type { Attempt, FinalState } from './attempt';
import type { CallStats } from './caller';
import type { ClientSeries, TierSeries } from './result';
import { STATUS_FAILED, STATUS_OK, STATUS_UNFINISHED } from './result';
import { histogramQuantile, LATENCY_BINS, latencyBin, Level } from './stats';

/** Bucket layout shared by all recorders in a run. */
export class Buckets {
  readonly count: number;

  constructor(readonly durationMs: number, readonly bucketMs: number) {
    this.count = Math.max(1, Math.ceil(durationMs / bucketMs));
  }

  of(timeMs: number): number {
    return Math.min(this.count - 1, Math.floor(timeMs / this.bucketMs));
  }

  /** Width of bucket i (the last one may be partial). */
  width(i: number): number {
    return Math.min(this.bucketMs, this.durationMs - i * this.bucketMs);
  }

  zeros(): number[] {
    return new Array<number>(this.count).fill(0);
  }
}

/** Per-tier counters, levels and latency histograms. Totals are summed across the tier's instances. */
export class TierMetrics implements CallStats {
  readonly queue: Level;
  readonly busyWorkers: Level;
  readonly busyCores: Level;
  /** Queue tiers: messages waiting, and consumers handling a message. */
  readonly backlog: Level;
  readonly busyConsumers: Level;
  private readonly arrivalsFirst: number[];
  private readonly arrivalsRetry: number[];
  private readonly ok: number[];
  private readonly failed: number[];
  private readonly rejected: number[];
  private readonly dropped: number[];
  private readonly timeouts: number[];
  private readonly retriesSent: number[];
  private readonly latencySum: number[];
  private readonly wasted: number[];
  private readonly hits: number[];
  private readonly hist: Uint32Array;
  private readonly delivered: number[];
  private readonly deadLettered: number[];
  private readonly ageSum: number[];
  private readonly ageHist: Uint32Array;
  private inFlight = 0;
  private computeTotal = 0;

  constructor(private readonly buckets: Buckets) {
    const n = buckets.count;
    this.queue = new Level(n, buckets.bucketMs);
    this.busyWorkers = new Level(n, buckets.bucketMs);
    this.busyCores = new Level(n, buckets.bucketMs);
    this.backlog = new Level(n, buckets.bucketMs);
    this.busyConsumers = new Level(n, buckets.bucketMs);
    this.arrivalsFirst = buckets.zeros();
    this.arrivalsRetry = buckets.zeros();
    this.ok = buckets.zeros();
    this.failed = buckets.zeros();
    this.rejected = buckets.zeros();
    this.dropped = buckets.zeros();
    this.timeouts = buckets.zeros();
    this.retriesSent = buckets.zeros();
    this.latencySum = buckets.zeros();
    this.wasted = buckets.zeros();
    this.hits = buckets.zeros();
    this.hist = new Uint32Array(n * LATENCY_BINS);
    this.delivered = buckets.zeros();
    this.deadLettered = buckets.zeros();
    this.ageSum = buckets.zeros();
    this.ageHist = new Uint32Array(n * LATENCY_BINS);
  }

  /** Queue tiers: a consumer finished with a message stored at `enqueuedAtMs`. */
  messageDone(timeMs: number, enqueuedAtMs: number, delivered: boolean): void {
    const b = this.buckets.of(timeMs);
    if (!delivered) {
      this.deadLettered[b]++;
      return;
    }
    const age = timeMs - enqueuedAtMs;
    this.delivered[b]++;
    this.ageSum[b] += age;
    this.ageHist[b * LATENCY_BINS + latencyBin(age)]++;
  }

  cacheHit(timeMs: number): void {
    this.hits[this.buckets.of(timeMs)]++;
  }

  arrival(timeMs: number, isRetry: boolean): void {
    this.inFlight++;
    const b = this.buckets.of(timeMs);
    if (isRetry) this.arrivalsRetry[b]++;
    else this.arrivalsFirst[b]++;
  }

  compute(ms: number): void {
    this.computeTotal += ms;
  }

  /** Records the tier's final answer for an attempt. */
  response(timeMs: number, attempt: Attempt, state: FinalState): void {
    this.inFlight--;
    const b = this.buckets.of(timeMs);
    this[state][b]++;
    if (state === 'ok') {
      const latency = timeMs - attempt.arrivedAtMs;
      this.latencySum[b] += latency;
      this.hist[b * LATENCY_BINS + latencyBin(latency)]++;
    }
    if (attempt.abandoned) this.wasted[b] += attempt.computeMs;
  }

  timeout(timeMs: number): void {
    this.timeouts[this.buckets.of(timeMs)]++;
  }

  retry(timeMs: number): void {
    this.retriesSent[this.buckets.of(timeMs)]++;
  }

  toSeries(
    id: string,
    capacity: { workers: number; cores: number; consumers: number },
    peaks: Omit<TierSeries['peaks'], 'backlog'>,
  ): TierSeries {
    const end = this.buckets.durationMs;
    for (const level of [this.queue, this.busyWorkers, this.busyCores, this.backlog, this.busyConsumers]) level.finish(end);
    const n = this.buckets.count;
    const avg = (level: Level) => Array.from(level.area, (a, i) => a / this.buckets.width(i));
    const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
    const latencyCount = sum(this.ok);
    return {
      id,
      ...capacity,
      arrivalsFirst: this.arrivalsFirst,
      arrivalsRetry: this.arrivalsRetry,
      ok: this.ok,
      failed: this.failed,
      rejected: this.rejected,
      dropped: this.dropped,
      timeouts: this.timeouts,
      retriesSent: this.retriesSent,
      latencyMeanMs: this.latencySum.map((s, i) => (this.ok[i] > 0 ? s / this.ok[i] : NaN)),
      latencyP50Ms: Array.from({ length: n }, (_, i) => histogramQuantile(this.hist, i * LATENCY_BINS, 0.5)),
      latencyP99Ms: Array.from({ length: n }, (_, i) => histogramQuantile(this.hist, i * LATENCY_BINS, 0.99)),
      queueAvg: avg(this.queue),
      busyWorkersAvg: avg(this.busyWorkers),
      busyCoresAvg: avg(this.busyCores),
      wastedMs: this.wasted,
      hits: this.hits,
      backlogAvg: avg(this.backlog),
      busyConsumersAvg: avg(this.busyConsumers),
      delivered: this.delivered,
      deadLettered: this.deadLettered,
      messageAgeMeanMs: this.ageSum.map((s, i) => (this.delivered[i] > 0 ? s / this.delivered[i] : NaN)),
      messageAgeP99Ms: Array.from({ length: n }, (_, i) => histogramQuantile(this.ageHist, i * LATENCY_BINS, 0.99)),
      totals: {
        arrivals: sum(this.arrivalsFirst) + sum(this.arrivalsRetry),
        ok: latencyCount,
        failed: sum(this.failed),
        rejected: sum(this.rejected),
        dropped: sum(this.dropped),
        inFlightAtEnd: this.inFlight,
        latencySumMs: sum(this.latencySum),
        latencyCount,
        queueArea: this.queue.total,
        busyWorkersArea: this.busyWorkers.total,
        busyCoresArea: this.busyCores.total,
        computeMs: this.computeTotal,
        wastedMs: sum(this.wasted),
        delivered: sum(this.delivered),
        deadLettered: sum(this.deadLettered),
        backlogArea: this.backlog.total,
        busyConsumersArea: this.busyConsumers.total,
        backlogAtEnd: this.backlog.value,
        inProcessingAtEnd: this.busyConsumers.value,
      },
      peaks: { ...peaks, backlog: this.backlog.peak },
    };
  }
}

/** End-to-end metrics as users see them, plus each request's outcome. */
export class ClientMetrics {
  private readonly sent: number[];
  private readonly ok: number[];
  private readonly failed: number[];
  private readonly hist: Uint32Array;
  private readonly arrival: number[] = [];
  private readonly latency: number[] = [];
  private readonly status: number[] = [];

  constructor(private readonly buckets: Buckets) {
    this.sent = buckets.zeros();
    this.ok = buckets.zeros();
    this.failed = buckets.zeros();
    this.hist = new Uint32Array(buckets.count * LATENCY_BINS);
  }

  /** Request ids are dense and increasing, so they index the outcome arrays directly. */
  requestSent(requestId: number, timeMs: number): void {
    this.sent[this.buckets.of(timeMs)]++;
    this.arrival[requestId] = timeMs;
    this.latency[requestId] = NaN;
    this.status[requestId] = STATUS_UNFINISHED;
  }

  requestDone(requestId: number, timeMs: number, ok: boolean): void {
    const b = this.buckets.of(timeMs);
    const latency = timeMs - this.arrival[requestId];
    this.latency[requestId] = latency;
    this.status[requestId] = ok ? STATUS_OK : STATUS_FAILED;
    if (ok) {
      this.ok[b]++;
      this.hist[b * LATENCY_BINS + latencyBin(latency)]++;
    } else {
      this.failed[b]++;
    }
  }

  toSeries(): ClientSeries {
    const n = this.buckets.count;
    return {
      sent: this.sent,
      ok: this.ok,
      failed: this.failed,
      latencyP50Ms: Array.from({ length: n }, (_, i) => histogramQuantile(this.hist, i * LATENCY_BINS, 0.5)),
      latencyP99Ms: Array.from({ length: n }, (_, i) => histogramQuantile(this.hist, i * LATENCY_BINS, 0.99)),
      requests: {
        arrivalMs: Float64Array.from(this.arrival),
        latencyMs: Float64Array.from(this.latency),
        status: Uint8Array.from(this.status),
      },
    };
  }
}
