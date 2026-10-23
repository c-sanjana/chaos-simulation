import type { ServiceTime } from './config';
import { exponential, inverseNormalCdf, sampleServiceTime, serviceTimeMoments } from './distributions';
import { Stream, uniform } from './rng';

const N = 200_000;

/** N service-time samples from fixed keys, so the statistical checks are deterministic. */
function samples(dist: ServiceTime, seed = 1): Float64Array {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = sampleServiceTime(dist, uniform(seed, Stream.Service, i));
  return out;
}

function meanAndVariance(xs: Float64Array): { mean: number; variance: number } {
  let mean = 0;
  for (const x of xs) mean += x;
  mean /= xs.length;
  let variance = 0;
  for (const x of xs) variance += (x - mean) ** 2;
  return { mean, variance: variance / (xs.length - 1) };
}

/** Empirical quantile of a sample (nearest rank). */
function quantile(xs: Float64Array, q: number): number {
  const sorted = Float64Array.from(xs).sort();
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

describe('exponential', () => {
  it('is −mean·ln(u)', () => {
    expect(exponential(1, 5)).toBeCloseTo(0, 15);
    expect(exponential(Math.exp(-1), 5)).toBeCloseTo(5, 12);
    expect(exponential(0.5, 2)).toBeCloseTo(2 * Math.LN2, 12);
  });
});

describe('inverseNormalCdf', () => {
  // Reference values from Python's statistics.NormalDist.inv_cdf (Wichura's AS241, ~1e-16 accurate).
  const known: Array<[number, number]> = [
    [0.5, 0],
    [0.975, 1.959963984540054],
    [0.025, -1.959963984540054],
    [0.01, -2.326347874040841],
    [0.99, 2.326347874040841],
    [0.8413447460685429, 1], // Φ(1)
    [0.02425, -1.9729610513118845], // the region break-point
    [0.9, 1.2815515655446004],
    [1e-10, -6.361340902404056],
    [1 - 1e-10, 6.361340889697421], // 1 − 1e-10 is not exact in binary, hence not exactly 6.3613409024
    [1e-300, -37.0470962993612],
  ];

  it.each(known)('Φ⁻¹(%s) ≈ %s', (p, z) => {
    const got = inverseNormalCdf(p);
    if (z === 0) expect(Math.abs(got)).toBeLessThan(1e-15);
    else expect(relErr(got, z)).toBeLessThan(1.2e-9);
  });

  it('is antisymmetric about 0.5 and increasing', () => {
    let prev = -Infinity;
    for (let i = 1; i < 1000; i++) {
      const p = i / 1000;
      const z = inverseNormalCdf(p);
      expect(z).toBeGreaterThan(prev);
      expect(z).toBeCloseTo(-inverseNormalCdf(1 - p), 8);
      prev = z;
    }
  });

  it('handles the boundaries', () => {
    expect(inverseNormalCdf(0)).toBe(-Infinity);
    expect(inverseNormalCdf(-0.1)).toBe(-Infinity);
    expect(inverseNormalCdf(1)).toBe(Infinity);
    expect(inverseNormalCdf(1.5)).toBe(Infinity);
    expect(inverseNormalCdf(NaN)).toBeNaN();
  });
});

describe('sampleServiceTime', () => {
  it('exponential: sample mean and variance within 1–2% of theory', () => {
    const { mean, variance } = meanAndVariance(samples({ kind: 'exponential', meanMs: 20 }));
    expect(relErr(mean, 20)).toBeLessThan(0.01);
    expect(relErr(variance, 400)).toBeLessThan(0.02);
  });

  it('exponential: median is mean·ln 2', () => {
    const xs = samples({ kind: 'exponential', meanMs: 20 });
    expect(relErr(quantile(xs, 0.5), 20 * Math.LN2)).toBeLessThan(0.02);
  });

  it('lognormal: median and p99 within 2% of configured', () => {
    const xs = samples({ kind: 'lognormal', medianMs: 10, p99Ms: 80 });
    expect(relErr(quantile(xs, 0.5), 10)).toBeLessThan(0.02);
    expect(relErr(quantile(xs, 0.99), 80)).toBeLessThan(0.02);
  });

  it('lognormal: sample mean and variance within 1–2% of theory', () => {
    // A modest tail (p99 = 3 × median, sigma ≈ 0.47) so the sample variance converges at N = 200k.
    const dist: ServiceTime = { kind: 'lognormal', medianMs: 10, p99Ms: 30 };
    const { mean: m, secondMoment } = serviceTimeMoments(dist);
    const { mean, variance } = meanAndVariance(samples(dist, 3));
    expect(relErr(mean, m)).toBeLessThan(0.01);
    expect(relErr(variance, secondMoment - m * m)).toBeLessThan(0.02);
  });

  it('lognormal: mean within 2% of theory for a heavy tail', () => {
    const dist: ServiceTime = { kind: 'lognormal', medianMs: 10, p99Ms: 80 };
    const { mean } = meanAndVariance(samples(dist, 5));
    expect(relErr(mean, serviceTimeMoments(dist).mean)).toBeLessThan(0.02);
  });

  it('lognormal with p99 = median is constant', () => {
    expect(sampleServiceTime({ kind: 'lognormal', medianMs: 7, p99Ms: 7 }, 0.123)).toBeCloseTo(7, 12);
  });

  it('maps u monotonically, so the same uniform gives the same rank in every distribution', () => {
    const dist: ServiceTime = { kind: 'lognormal', medianMs: 10, p99Ms: 80 };
    expect(sampleServiceTime(dist, 0.5)).toBeCloseTo(10, 9);
    expect(sampleServiceTime(dist, 0.99)).toBeCloseTo(80, 6);
    expect(sampleServiceTime(dist, 0.2)).toBeLessThan(sampleServiceTime(dist, 0.3));
  });

  it('fixed returns ms and ignores u', () => {
    expect(sampleServiceTime({ kind: 'fixed', ms: 12.5 }, 0.001)).toBe(12.5);
    expect(sampleServiceTime({ kind: 'fixed', ms: 12.5 }, 0.999)).toBe(12.5);
  });
});

describe('serviceTimeMoments', () => {
  it('exponential: E[S] = m, E[S²] = 2m²', () => {
    expect(serviceTimeMoments({ kind: 'exponential', meanMs: 4 })).toEqual({ mean: 4, secondMoment: 32 });
  });

  it('fixed: E[S] = d, E[S²] = d²', () => {
    expect(serviceTimeMoments({ kind: 'fixed', ms: 3 })).toEqual({ mean: 3, secondMoment: 9 });
  });

  it('lognormal: exp(mu + sigma²/2) and exp(2mu + 2sigma²)', () => {
    const median = 10;
    const p99 = 80;
    const mu = Math.log(median);
    const sigma = Math.log(p99 / median) / 2.3263478740408408;
    const { mean, secondMoment } = serviceTimeMoments({ kind: 'lognormal', medianMs: median, p99Ms: p99 });
    expect(mean).toBeCloseTo(Math.exp(mu + (sigma * sigma) / 2), 10);
    expect(secondMoment).toBeCloseTo(Math.exp(2 * mu + 2 * sigma * sigma), 8);
    // Sanity: a long tail pulls the mean above the median.
    expect(mean).toBeGreaterThan(median);
  });

  it('lognormal second moment matches the sample second moment', () => {
    const dist: ServiceTime = { kind: 'lognormal', medianMs: 10, p99Ms: 30 };
    const xs = samples(dist, 9);
    let m2 = 0;
    for (const x of xs) m2 += x * x;
    expect(relErr(m2 / N, serviceTimeMoments(dist).secondMoment)).toBeLessThan(0.02);
  });
});
