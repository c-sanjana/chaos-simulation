/**
 * Per-bucket metric accumulators: time-integrated levels and log-binned latency histograms.
 *
 * Bucket i covers simulated time [i × bucketMs, (i+1) × bucketMs). Time starts at 0.
 */

/**
 * A piecewise-constant quantity (queue length, busy workers, busy cores) and its time integral.
 *
 * `area[i]` is value × ms accumulated within bucket i, so `area[i] / bucketMs` is the time-averaged
 * value in that bucket. Time beyond the last bucket is added to the last bucket.
 * Call `set`/`add` at each change and `finish` at the end of the run; times must not decrease.
 */
export class Level {
  /** value × ms accumulated in each bucket. */
  readonly area: Float64Array;
  /** Highest value ever set. Starts at 0, the initial value. */
  peak = 0;
  /** value × ms over the whole run (equal to the sum of `area` up to rounding). */
  total = 0;

  private current = 0;
  /** Time up to which `area` and `total` have been accumulated. */
  private lastMs = 0;

  constructor(
    buckets: number,
    private readonly bucketMs: number,
  ) {
    if (!(Number.isInteger(buckets) && buckets >= 1)) throw new Error(`Level: buckets must be a positive integer, got ${buckets}`);
    if (!(bucketMs > 0)) throw new Error(`Level: bucketMs must be positive, got ${bucketMs}`);
    this.area = new Float64Array(buckets);
  }

  /** The current value. */
  get value(): number {
    return this.current;
  }

  /** Changes the value at `timeMs`, accumulating the old value up to then. */
  set(timeMs: number, value: number): void {
    this.finish(timeMs);
    this.current = value;
    if (value > this.peak) this.peak = value;
  }

  /** Adds `delta` to the value at `timeMs`. */
  add(timeMs: number, delta: number): void {
    this.set(timeMs, this.current + delta);
  }

  /** Accumulates the current value up to `timeMs`, splitting the integral across bucket boundaries. */
  finish(timeMs: number): void {
    let from = this.lastMs;
    if (timeMs < from) throw new Error(`Level: time went backwards (${timeMs} < ${from})`);
    const v = this.current;
    this.lastMs = timeMs;
    if (v === 0) return; // nothing to accumulate; the common case for idle resources
    this.total += v * (timeMs - from);

    const { area, bucketMs } = this;
    const lastBucket = area.length - 1;
    // Walk bucket by bucket with an explicit index (not recomputing floor(from / bucketMs)), so a
    // rounding error at a boundary can never stall the loop.
    let b = Math.floor(from / bucketMs);
    while (b < lastBucket) {
      const edge = (b + 1) * bucketMs;
      if (timeMs <= edge) break;
      area[b] += v * (edge - from);
      from = edge;
      b++;
    }
    area[Math.min(b, lastBucket)] += v * (timeMs - from);
  }
}

/** Number of bins in a latency histogram. */
export const LATENCY_BINS = 128;
/** Lower edge of bin 0 and upper edge of the last bin, in ms. Values outside go to the end bins. */
const LATENCY_MIN_MS = 0.05;
const LATENCY_MAX_MS = 120_000;
/** Natural-log width of one bin: ln(max/min)/128 ≈ 0.115, so each bin is about 12% wide. */
const LOG_BIN_WIDTH = Math.log(LATENCY_MAX_MS / LATENCY_MIN_MS) / LATENCY_BINS;
const INV_LOG_BIN_WIDTH = 1 / LOG_BIN_WIDTH;

/**
 * Histogram bin of a latency. Bins are log-spaced: bin i covers [min·w^i, min·w^(i+1)) with
 * w = (max/min)^(1/128). Values below 0.05 ms (including 0) go to bin 0, values at or above
 * 120,000 ms to the last bin.
 */
export function latencyBin(ms: number): number {
  if (!(ms > LATENCY_MIN_MS)) return 0; // also catches NaN
  const bin = Math.floor(Math.log(ms / LATENCY_MIN_MS) * INV_LOG_BIN_WIDTH);
  return bin < LATENCY_BINS ? bin : LATENCY_BINS - 1;
}

/** Geometric centre of a bin, in ms: the value reported for any latency in that bin. */
export function binCenterMs(bin: number): number {
  return LATENCY_MIN_MS * Math.exp((bin + 0.5) * LOG_BIN_WIDTH);
}

/**
 * Quantile q of the LATENCY_BINS counts starting at `offset`. NaN if the histogram is empty.
 *
 * Interpolates inside the bin that contains the quantile, assuming values are spread evenly in
 * log-space across that bin. This keeps error well below the ~12% bin width (rounding to the bin
 * centre alone can be off by up to ~6%, which shows up clearly at p99).
 * q = 0 returns the bottom edge of the lowest non-empty bin.
 */
export function histogramQuantile(hist: ArrayLike<number>, offset: number, q: number): number {
  const end = offset + LATENCY_BINS - 1;
  let total = 0;
  for (let i = offset; i <= end; i++) total += hist[i];
  if (total === 0) return NaN;

  const target = Math.min(Math.max(q, 0), 1) * total;
  let before = 0;
  let i = offset;
  // The first non-empty bin whose cumulative count reaches the target (or the last bin).
  for (; i < end; i++) {
    const c = hist[i];
    if (c > 0 && before + c >= target) break;
    before += c;
  }
  // hist[i] > 0 here: the loop stops at a non-empty bin, and q·total ≤ total guarantees one is reached.
  const fraction = Math.min(1, Math.max(0, (target - before) / hist[i]));
  return LATENCY_MIN_MS * Math.exp((i - offset + fraction) * LOG_BIN_WIDTH);
}
