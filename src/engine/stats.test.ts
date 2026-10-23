import { exponential } from './distributions';
import { Stream, uniform } from './rng';
import { LATENCY_BINS, Level, binCenterMs, histogramQuantile, latencyBin } from './stats';

describe('Level', () => {
  it('starts at zero', () => {
    const l = new Level(3, 1000);
    expect(l.value).toBe(0);
    expect(l.peak).toBe(0);
    expect(l.total).toBe(0);
    expect(Array.from(l.area)).toEqual([0, 0, 0]);
  });

  it('integrates within one bucket', () => {
    const l = new Level(3, 1000);
    l.set(100, 2); // 2 from 100..400
    l.set(400, 5); // 5 from 400..600
    l.set(600, 0);
    l.finish(3000);
    expect(Array.from(l.area)).toEqual([2 * 300 + 5 * 200, 0, 0]);
    expect(l.total).toBe(1600);
  });

  it('splits an interval across bucket boundaries', () => {
    const l = new Level(4, 1000);
    l.set(500, 3); // 3 from 500 to 2250: 500 ms in b0, 1000 ms in b1, 250 ms in b2
    l.set(2250, 1); // 1 from 2250 to 4000: 750 ms in b2, 1000 ms in b3
    l.finish(4000);
    expect(Array.from(l.area)).toEqual([1500, 3000, 750 + 750, 1000]);
    expect(l.total).toBe(3 * 1750 + 1 * 1750);
  });

  it('handles changes exactly on bucket boundaries', () => {
    const l = new Level(3, 1000);
    l.set(1000, 4);
    l.set(2000, 1);
    l.finish(3000);
    expect(Array.from(l.area)).toEqual([0, 4000, 1000]);
  });

  it('adds time beyond the last bucket to the last bucket', () => {
    const l = new Level(2, 1000);
    l.set(1500, 2); // 500 ms in b1, then 2500 ms past the end, also counted in b1
    l.finish(4500);
    expect(Array.from(l.area)).toEqual([0, 2 * 3000]);
    // An interval that starts beyond the last bucket.
    l.set(5000, 1);
    l.finish(6000);
    expect(Array.from(l.area)).toEqual([0, 2 * 3500 + 1000]);
    expect(l.total).toBe(2 * 3500 + 1000);
  });

  it('works with a single bucket', () => {
    const l = new Level(1, 1000);
    l.set(0, 1);
    l.finish(2500);
    expect(Array.from(l.area)).toEqual([2500]);
  });

  it('add() changes the value by a delta and tracks the peak', () => {
    const l = new Level(2, 10);
    l.add(0, 1);
    l.add(2, 1);
    l.add(4, 1); // 3 from 4..6
    l.add(6, -2);
    l.add(8, -1);
    expect(l.value).toBe(0);
    expect(l.peak).toBe(3);
    l.finish(20);
    // 1×2 + 2×2 + 3×2 + 1×2 = 14, all in bucket 0.
    expect(Array.from(l.area)).toEqual([14, 0]);
    expect(l.total).toBe(14);
  });

  it('peak is the highest value, not the latest', () => {
    const l = new Level(1, 1000);
    l.set(0, 7);
    l.set(1, 2);
    expect(l.peak).toBe(7);
    expect(l.value).toBe(2);
  });

  it('finish() can be called repeatedly and at the current time', () => {
    const l = new Level(2, 100);
    l.set(50, 2);
    l.finish(150);
    l.finish(150);
    l.finish(200);
    expect(Array.from(l.area)).toEqual([100, 200]);
  });

  it('area sums to total across many random changes, with fractional bucket widths', () => {
    const l = new Level(37, 0.1);
    let t = 0;
    for (let i = 0; i < 5000; i++) {
      t += uniform(3, Stream.Arrival, i) * 0.002;
      l.set(t, Math.floor(uniform(3, Stream.Service, i) * 10));
    }
    l.finish(t + 1); // also runs past the last bucket
    let sum = 0;
    for (const a of l.area) sum += a;
    expect(sum).toBeCloseTo(l.total, 9);
    // Each full bucket's average is within [0, 9].
    for (let b = 0; b < 36; b++) {
      expect(l.area[b] / 0.1).toBeGreaterThanOrEqual(0);
      expect(l.area[b] / 0.1).toBeLessThanOrEqual(9);
    }
  });

  it('rejects time going backwards', () => {
    const l = new Level(2, 1000);
    l.set(500, 1);
    expect(() => l.set(400, 2)).toThrow(/backwards/);
  });

  it('rejects invalid dimensions', () => {
    expect(() => new Level(0, 1000)).toThrow(/buckets/);
    expect(() => new Level(2.5, 1000)).toThrow(/buckets/);
    expect(() => new Level(2, 0)).toThrow(/bucketMs/);
    expect(() => new Level(2, NaN)).toThrow(/bucketMs/);
  });
});

describe('latency histogram bins', () => {
  it('has 128 bins', () => {
    expect(LATENCY_BINS).toBe(128);
  });

  it('bins are monotone in latency and cover the range', () => {
    let prev = 0;
    for (let ms = 0.01; ms < 200_000; ms *= 1.01) {
      const b = latencyBin(ms);
      expect(b).toBeGreaterThanOrEqual(prev);
      expect(b).toBeLessThan(LATENCY_BINS);
      prev = b;
    }
    expect(prev).toBe(LATENCY_BINS - 1);
  });

  it('clamps values outside the range to the end bins', () => {
    expect(latencyBin(0)).toBe(0);
    expect(latencyBin(-5)).toBe(0);
    expect(latencyBin(NaN)).toBe(0);
    expect(latencyBin(0.05)).toBe(0);
    expect(latencyBin(0.0500001)).toBe(0);
    expect(latencyBin(119_999)).toBe(LATENCY_BINS - 1);
    expect(latencyBin(120_000)).toBe(LATENCY_BINS - 1);
    expect(latencyBin(1e9)).toBe(LATENCY_BINS - 1);
    expect(latencyBin(Infinity)).toBe(LATENCY_BINS - 1);
  });

  it('bin centres are geometric centres, increasing by a constant ratio of about 12%', () => {
    const ratio = (120_000 / 0.05) ** (1 / LATENCY_BINS);
    expect(binCenterMs(0)).toBeCloseTo(0.05 * Math.sqrt(ratio), 12);
    expect(binCenterMs(LATENCY_BINS - 1)).toBeCloseTo(120_000 / Math.sqrt(ratio), 6);
    for (let b = 1; b < LATENCY_BINS; b++) expect(binCenterMs(b) / binCenterMs(b - 1)).toBeCloseTo(ratio, 12);
    expect(ratio).toBeGreaterThan(1.1);
    expect(ratio).toBeLessThan(1.13);
  });

  it('every bin centre falls back into its own bin', () => {
    for (let b = 0; b < LATENCY_BINS; b++) expect(latencyBin(binCenterMs(b))).toBe(b);
  });
});

describe('histogramQuantile', () => {
  it('returns NaN for an empty histogram', () => {
    expect(histogramQuantile(new Float64Array(LATENCY_BINS), 0, 0.5)).toBeNaN();
  });

  /** Point a fraction f (0 = bottom edge, 1 = top edge) of the way through a bin, in log-space. */
  const at = (bin: number, f: number) => {
    const logWidth = Math.log(binCenterMs(1) / binCenterMs(0));
    return binCenterMs(bin) * Math.exp((f - 0.5) * logWidth);
  };
  const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 9);

  it('interpolates inside the bin where the cumulative count reaches q·total', () => {
    const h = new Uint32Array(LATENCY_BINS);
    h[10] = 1;
    h[20] = 2;
    h[30] = 1;
    close(histogramQuantile(h, 0, 0), at(10, 0)); // skips leading empty bins
    close(histogramQuantile(h, 0, 0.25), at(10, 1)); // exactly 1 of 4: top of bin 10
    close(histogramQuantile(h, 0, 0.5), at(20, 0.5)); // halfway through bin 20's two values
    close(histogramQuantile(h, 0, 0.75), at(20, 1));
    close(histogramQuantile(h, 0, 1), at(30, 1)); // not a trailing empty bin
    close(histogramQuantile(h, 0, 5), at(30, 1)); // q clamped to [0, 1]
    close(histogramQuantile(h, 0, -1), at(10, 0));
  });

  it('handles the quantile falling in the last bin', () => {
    const h = new Array<number>(LATENCY_BINS).fill(0);
    h[0] = 1;
    h[LATENCY_BINS - 1] = 1;
    close(histogramQuantile(h, 0, 0.5), at(0, 1));
    close(histogramQuantile(h, 0, 0.99), at(LATENCY_BINS - 1, 0.98));
  });

  it('reads histograms at an offset in a shared flat array', () => {
    const flat = new Float64Array(3 * LATENCY_BINS);
    flat[LATENCY_BINS - 1] = 100; // last bin of histogram 0: must not leak into histogram 1
    flat[LATENCY_BINS + 40] = 3;
    flat[2 * LATENCY_BINS] = 100; // first bin of histogram 2: must not leak into histogram 1
    close(histogramQuantile(flat, LATENCY_BINS, 0), at(40, 0));
    close(histogramQuantile(flat, LATENCY_BINS, 1), at(40, 1));
    close(histogramQuantile(flat, 2 * LATENCY_BINS, 0.5), at(0, 0.5));
    close(histogramQuantile(flat, 0, 0.5), at(LATENCY_BINS - 1, 0.5));
  });

  it('quantiles of 200k exponential samples are within 2% of exact', () => {
    const N = 200_000;
    const mean = 40;
    const h = new Uint32Array(LATENCY_BINS);
    for (let i = 0; i < N; i++) h[latencyBin(exponential(uniform(17, Stream.Service, i), mean))]++;
    for (const q of [0.1, 0.25, 0.5, 0.9, 0.99, 0.999]) {
      const exact = -mean * Math.log(1 - q);
      const got = histogramQuantile(h, 0, q);
      expect(Math.abs(got - exact) / exact).toBeLessThan(0.02);
    }
  });
});
