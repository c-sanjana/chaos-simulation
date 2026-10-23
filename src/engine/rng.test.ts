import { Stream, hashPath, mix32, uniform, wordsToUnit } from './rng';

const N = 100_000;

/** Pearson correlation coefficient of two equal-length samples. */
function pearson(xs: Float64Array, ys: Float64Array): number {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** n uniforms from a key function of the index. */
function sample(key: (i: number) => number): Float64Array {
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = key(i);
  return out;
}

/** Chi-square statistic of samples in (0,1) against a uniform distribution over `bins` bins. */
function chiSquare(xs: Float64Array, bins: number): number {
  const counts = new Array<number>(bins).fill(0);
  for (const x of xs) counts[Math.floor(x * bins)]++;
  const expected = xs.length / bins;
  return counts.reduce((acc, c) => acc + ((c - expected) * (c - expected)) / expected, 0);
}

/** 99.9% critical value of chi-square with 19 degrees of freedom. */
const CHI2_19_999 = 43.82;

describe('mix32', () => {
  it('returns unsigned 32-bit integers', () => {
    for (const x of [0, 1, -1, 0x7fffffff, 0x80000000, 0xffffffff, 123456789]) {
      const h = mix32(x);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it('matches reference lowbias32 values', () => {
    // Computed independently with 64-bit BigInt arithmetic.
    const ref = (x: number): number => {
      const M = 0xffffffffn;
      let v = BigInt(x >>> 0);
      v ^= v >> 16n;
      v = (v * 0x7feb352dn) & M;
      v ^= v >> 15n;
      v = (v * 0x846ca68bn) & M;
      v ^= v >> 16n;
      return Number(v);
    };
    for (const x of [1, 2, 3, 42, 0xdeadbeef, 0xffffffff, 2 ** 31]) expect(mix32(x)).toBe(ref(x));
  });

  it('is injective on a sample (it is a bijection)', () => {
    const seen = new Set<number>();
    for (let i = 0; i < N; i++) seen.add(mix32(i));
    expect(seen.size).toBe(N);
  });

  it('avalanches: flipping one input bit flips about half the output bits', () => {
    let flips = 0;
    let trials = 0;
    for (let x = 1; x < 2000; x++) {
      for (let bit = 0; bit < 32; bit++) {
        let d = (mix32(x) ^ mix32(x ^ (1 << bit))) >>> 0;
        while (d) {
          flips += d & 1;
          d >>>= 1;
        }
        trials++;
      }
    }
    expect(flips / trials / 32).toBeCloseTo(0.5, 2);
  });
});

describe('hashPath', () => {
  it('gives distinct hashes for different attempts under one parent', () => {
    const seen = new Set<number>();
    for (let a = 0; a < 10_000; a++) seen.add(hashPath(12345, a));
    expect(seen.size).toBe(10_000);
  });

  it('gives distinct hashes for the same attempt under different parents', () => {
    const seen = new Set<number>();
    for (let p = 0; p < 10_000; p++) seen.add(hashPath(p, 0));
    expect(seen.size).toBe(10_000);
  });

  it('distinguishes paths by order: retry-then-first vs first-then-retry', () => {
    const root = 0;
    expect(hashPath(hashPath(root, 1), 0)).not.toBe(hashPath(hashPath(root, 0), 1));
  });

  it('has no collisions across a tree of attempt paths', () => {
    // 3 layers, 8 attempts each, under 1000 roots: 1000 × (8 + 64 + 512) paths.
    const seen = new Set<number>();
    let count = 0;
    for (let root = 0; root < 1000; root++) {
      for (let a = 0; a < 8; a++) {
        const p1 = hashPath(root, a);
        seen.add(p1);
        count++;
        for (let b = 0; b < 8; b++) {
          const p2 = hashPath(p1, b);
          seen.add(p2);
          count++;
          for (let c = 0; c < 8; c++) {
            seen.add(hashPath(p2, c));
            count++;
          }
        }
      }
    }
    // 584,000 random 32-bit values expect ~40 birthday collisions; allow for that, but no structure.
    expect(count - seen.size).toBeLessThan(100);
  });

  it('is deterministic and unsigned 32-bit', () => {
    const h = hashPath(0xffffffff, 7);
    expect(hashPath(0xffffffff, 7)).toBe(h);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe('wordsToUnit', () => {
  it('maps the extreme words strictly inside (0, 1)', () => {
    expect(wordsToUnit(0, 0)).toBe(2 ** -54);
    expect(wordsToUnit(0xffffffff, 0xffffffff)).toBe(1 - 2 ** -53);
    expect(wordsToUnit(0xffffffff, 0xffffffff)).toBeLessThan(1);
  });

  it('uses 53 bits: the lowest bit of w2 that matters changes the result by 2^-53', () => {
    expect(wordsToUnit(0, 1 << 6)).toBe(2 ** -53);
    expect(wordsToUnit(0, 0x3f)).toBe(2 ** -54); // bits below the top 26 of w2 are dropped
    expect(wordsToUnit(1 << 5, 0)).toBe(2 ** -27);
    expect(wordsToUnit(0x80000000, 0)).toBe(0.5);
  });
});

describe('uniform', () => {
  it('is a pure function of its key', () => {
    expect(uniform(1, Stream.Arrival, 5, 6, 7)).toBe(uniform(1, Stream.Arrival, 5, 6, 7));
    expect(uniform(9, Stream.Service)).toBe(uniform(9, Stream.Service, 0, 0, 0));
    // Order of calls does not matter: no hidden state.
    const before = uniform(3, Stream.Jitter, 100);
    for (let i = 0; i < 1000; i++) uniform(3, Stream.Jitter, i);
    expect(uniform(3, Stream.Jitter, 100)).toBe(before);
  });

  it('returns values strictly in (0, 1)', () => {
    let min = 1;
    let max = 0;
    for (let i = 0; i < N; i++) {
      const u = uniform(42, Stream.Service, i);
      min = Math.min(min, u);
      max = Math.max(max, u);
    }
    expect(min).toBeGreaterThan(0);
    expect(max).toBeLessThan(1);
    // Spread over the whole interval.
    expect(min).toBeLessThan(1e-3);
    expect(max).toBeGreaterThan(1 - 1e-3);
  });

  it('handles large and negative key parts as 32-bit integers', () => {
    const u = uniform(0xffffffff, 4, 2 ** 31 - 1, -1, 2 ** 31);
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThan(1);
    // -1 and 2^32 - 1 are the same 32-bit integer.
    expect(uniform(1, 2, -1)).toBe(uniform(1, 2, 0xffffffff));
  });

  it('is uniform: chi-square over 20 bins is below the 99.9% critical value', () => {
    expect(chiSquare(sample((i) => uniform(1, Stream.Arrival, i)), 20)).toBeLessThan(CHI2_19_999);
    expect(chiSquare(sample((i) => uniform(7, Stream.Service, 1, i, 3)), 20)).toBeLessThan(CHI2_19_999);
    expect(chiSquare(sample((i) => uniform(2, Stream.Jitter, 5, 6, i)), 20)).toBeLessThan(CHI2_19_999);
    // Varying only the seed.
    expect(chiSquare(sample((i) => uniform(i, Stream.CacheKey, 77)), 20)).toBeLessThan(CHI2_19_999);
  });

  it('has mean 1/2 and variance 1/12', () => {
    const xs = sample((i) => uniform(11, Stream.Service, i));
    let mean = 0;
    for (const x of xs) mean += x;
    mean /= N;
    let v = 0;
    for (const x of xs) v += (x - mean) ** 2;
    v /= N - 1;
    expect(mean).toBeCloseTo(0.5, 2);
    expect(v).toBeCloseTo(1 / 12, 3);
  });

  it('gives uncorrelated values across streams, seeds, keys and attempt paths', () => {
    const base = sample((i) => uniform(1, Stream.Arrival, i));
    const others: Array<[string, Float64Array]> = [
      ['other stream', sample((i) => uniform(1, Stream.Service, i))],
      ['other seed', sample((i) => uniform(2, Stream.Arrival, i))],
      ['neighbouring key', sample((i) => uniform(1, Stream.Arrival, i + 1))],
      ['other b', sample((i) => uniform(1, Stream.Arrival, i, 1))],
      ['other c', sample((i) => uniform(1, Stream.Arrival, i, 0, 1))],
      ['key in b instead of a', sample((i) => uniform(1, Stream.Arrival, 0, i))],
      ['retry path', sample((i) => uniform(1, Stream.Arrival, i, hashPath(0, 1)))],
    ];
    for (const [, ys] of others) expect(Math.abs(pearson(base, ys))).toBeLessThan(0.01);
    // And successive keys within one sequence (lag-1 autocorrelation).
    expect(Math.abs(pearson(base.subarray(0, N - 1), base.subarray(1)))).toBeLessThan(0.01);
  });

  it('gives a different value for every key part change', () => {
    const u = uniform(1, 2, 3, 4, 5);
    expect(uniform(0, 2, 3, 4, 5)).not.toBe(u);
    expect(uniform(1, 1, 3, 4, 5)).not.toBe(u);
    expect(uniform(1, 2, 2, 4, 5)).not.toBe(u);
    expect(uniform(1, 2, 3, 3, 5)).not.toBe(u);
    expect(uniform(1, 2, 3, 4, 4)).not.toBe(u);
  });

  it('exposes distinct stream ids', () => {
    const ids = Object.values(Stream);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
