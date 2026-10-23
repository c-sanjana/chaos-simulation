import { describe, expect, it } from 'vitest';
import {
  cheLruHitRate,
  erlangC,
  lognormalMoments,
  mg1MeanResponseMs,
  mm1MeanResponseMs,
  mmcMeanResponseMs,
  roundRobinMeanResponseMs,
  ttlCacheHitRate,
  zipfProbabilities,
} from './theory';

/** M/D/1 mean time in system, written out independently of the P-K implementation. */
function md1(lambda: number, s: number): number {
  const rho = lambda * s;
  return s + (rho * s) / (2 * (1 - rho));
}

/**
 * D/M/1 mean time in system: σ = e^{−(1−σ)/ρ}, W = S/(1−σ). Solved here by plain fixed-point
 * iteration (a different method from the bisection in theory.ts). It is the k → ∞ limit of the
 * round-robin E_k/M/1 queue.
 */
function dm1(rho: number, s: number): number {
  let sigma = 0;
  for (let i = 0; i < 10_000; i++) sigma = Math.exp(-(1 - sigma) / rho);
  return s / (1 - sigma);
}

describe('mm1MeanResponseMs', () => {
  it('matches the textbook example λ=0.08/ms, S=10ms (ρ=0.8) → W=50ms', () => {
    expect(mm1MeanResponseMs(0.08, 10)).toBeCloseTo(50, 10);
  });

  it('is just the service time with no traffic', () => {
    expect(mm1MeanResponseMs(0, 10)).toBe(10);
  });

  it('throws when unstable or inputs are invalid', () => {
    expect(() => mm1MeanResponseMs(0.1, 10)).toThrow(RangeError); // ρ = 1
    expect(() => mm1MeanResponseMs(0.2, 10)).toThrow(RangeError); // ρ = 2
    expect(() => mm1MeanResponseMs(-0.01, 10)).toThrow(RangeError);
    expect(() => mm1MeanResponseMs(0.01, 0)).toThrow(RangeError);
    expect(() => mm1MeanResponseMs(0.01, -1)).toThrow(RangeError);
    expect(() => mm1MeanResponseMs(NaN, 10)).toThrow(RangeError);
    expect(() => mm1MeanResponseMs(0.01, Infinity)).toThrow(RangeError);
  });
});

describe('erlangC', () => {
  it('C(2, 1) = 1/3', () => {
    expect(erlangC(2, 1)).toBeCloseTo(1 / 3, 12);
  });

  it('C(5, 4) ≈ 0.55411', () => {
    expect(erlangC(5, 4)).toBeCloseTo(0.55411, 4);
  });

  it('matches the closed form for a range of c and a', () => {
    const closedForm = (c: number, a: number) => {
      let sum = 0;
      let term = 1; // a^k / k!
      for (let k = 0; k < c; k++) {
        sum += term;
        term *= a / (k + 1);
      }
      const top = (term * c) / (c - a); // a^c / c! · c/(c−a)
      return top / (sum + top);
    };
    for (const c of [1, 2, 3, 8, 20]) {
      for (const fraction of [0.1, 0.5, 0.9, 0.99]) {
        const a = c * fraction;
        expect(erlangC(c, a)).toBeCloseTo(closedForm(c, a), 12);
      }
    }
  });

  it('C(1, a) = a', () => {
    for (const a of [0, 0.25, 0.5, 0.9]) expect(erlangC(1, a)).toBeCloseTo(a, 14);
  });

  it('stays finite and in [0, 1] for many servers', () => {
    const c = erlangC(1000, 950);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(1);
  });

  it('throws when a >= c or inputs are invalid', () => {
    expect(() => erlangC(2, 2)).toThrow(RangeError);
    expect(() => erlangC(2, 3)).toThrow(RangeError);
    expect(() => erlangC(0, 0.5)).toThrow(RangeError);
    expect(() => erlangC(2.5, 1)).toThrow(RangeError);
    expect(() => erlangC(2, -1)).toThrow(RangeError);
  });
});

describe('mmcMeanResponseMs', () => {
  it('with one server equals M/M/1', () => {
    expect(mmcMeanResponseMs(0.08, 10, 1)).toBeCloseTo(mm1MeanResponseMs(0.08, 10), 10);
  });

  it('matches W = C·S/(c−a) + S for c=2, a=1 (C = 1/3)', () => {
    // λ = 0.1/ms, S = 10ms → a = 1. W = (1/3)·10/(2−1) + 10 = 13.333…
    expect(mmcMeanResponseMs(0.1, 10, 2)).toBeCloseTo(10 + 10 / 3, 10);
  });

  it('pooling beats splitting: M/M/2 < M/M/1 at the same per-server load', () => {
    expect(mmcMeanResponseMs(0.16, 10, 2)).toBeLessThan(mm1MeanResponseMs(0.08, 10));
  });

  it('throws when unstable or inputs are invalid', () => {
    expect(() => mmcMeanResponseMs(0.2, 10, 2)).toThrow(RangeError);
    expect(() => mmcMeanResponseMs(-1, 10, 2)).toThrow(RangeError);
    expect(() => mmcMeanResponseMs(0.1, 0, 2)).toThrow(RangeError);
    expect(() => mmcMeanResponseMs(0.1, 10, 0)).toThrow(RangeError);
  });
});

describe('mg1MeanResponseMs', () => {
  it('with exponential service (E[S²] = 2S²) equals M/M/1', () => {
    expect(mg1MeanResponseMs(0.08, 10, 200)).toBeCloseTo(mm1MeanResponseMs(0.08, 10), 10);
  });

  it('with deterministic service (E[S²] = S²) gives M/D/1', () => {
    // ρ = 0.8: W = 10 + 0.8·10 / (2·0.2) = 30ms.
    expect(mg1MeanResponseMs(0.08, 10, 100)).toBeCloseTo(30, 10);
    expect(mg1MeanResponseMs(0.05, 4, 16)).toBeCloseTo(md1(0.05, 4), 12);
  });

  it('throws when unstable, E[S²] < E[S]², or inputs are invalid', () => {
    expect(() => mg1MeanResponseMs(0.1, 10, 200)).toThrow(RangeError);
    expect(() => mg1MeanResponseMs(0.05, 10, 99)).toThrow(RangeError);
    expect(() => mg1MeanResponseMs(0.05, 10, NaN)).toThrow(RangeError);
    expect(() => mg1MeanResponseMs(-0.05, 10, 200)).toThrow(RangeError);
    expect(() => mg1MeanResponseMs(0.05, 0, 200)).toThrow(RangeError);
  });
});

describe('roundRobinMeanResponseMs', () => {
  it('with one instance equals M/M/1', () => {
    for (const lambda of [0.01, 0.05, 0.08, 0.099]) {
      const expected = mm1MeanResponseMs(lambda, 10);
      expect(Math.abs(roundRobinMeanResponseMs(lambda, 1, 10) - expected)).toBeLessThan(1e-6 * expected);
    }
  });

  it('with two instances matches the E_2/M/1 closed form σ = ((2r+1) − √(4r+1))/2, r = λS', () => {
    // Dividing σ(r + 1 − σ)² = r² by (σ − 1) leaves σ² − (2r+1)σ + r² = 0.
    for (const lambda of [0.02, 0.1, 0.16, 0.19]) {
      const r = lambda * 10;
      const sigma = (2 * r + 1 - Math.sqrt(4 * r + 1)) / 2;
      expect(roundRobinMeanResponseMs(lambda, 2, 10)).toBeCloseTo(10 / (1 - sigma), 8);
    }
  });

  it('for k=2 lies strictly between M/D/1 and M/M/1 at the same per-instance load', () => {
    // λ total 0.16/ms over 2 instances, S = 10ms: per-instance ρ = 0.8.
    const w = roundRobinMeanResponseMs(0.16, 2, 10);
    expect(w).toBeCloseTo(38.4398, 3);
    expect(w).toBeGreaterThan(md1(0.08, 10)); // 30ms
    expect(w).toBeGreaterThan(dm1(0.8, 10));
    expect(w).toBeLessThan(mm1MeanResponseMs(0.08, 10)); // 50ms
  });

  it('decreases with more instances at fixed per-instance load and approaches D/M/1', () => {
    const rho = 0.8;
    const s = 10;
    let previous = Infinity;
    for (const k of [1, 2, 4, 8, 16]) {
      const w = roundRobinMeanResponseMs((k * rho) / s, k, s);
      expect(w).toBeLessThan(previous);
      previous = w;
    }
    const limit = dm1(rho, s);
    const wLarge = roundRobinMeanResponseMs((1000 * rho) / s, 1000, s);
    expect(wLarge).toBeGreaterThan(limit);
    expect(wLarge / limit - 1).toBeLessThan(0.01);
  });

  it('its root satisfies σ = (λ/(λ + μ(1−σ)))^k to 1e-9', () => {
    for (const [lambda, k, s] of [
      [0.16, 2, 10],
      [0.5, 7, 12],
      [2.9, 3, 1],
    ]) {
      const w = roundRobinMeanResponseMs(lambda, k, s);
      const mu = 1 / s;
      const sigma = 1 - 1 / (mu * w);
      expect(sigma).toBeGreaterThan(0);
      expect(sigma).toBeLessThan(1);
      expect(Math.abs((lambda / (lambda + mu * (1 - sigma))) ** k - sigma)).toBeLessThan(1e-9);
    }
  });

  it('is just the service time with no traffic', () => {
    expect(roundRobinMeanResponseMs(0, 3, 10)).toBe(10);
  });

  it('throws when an instance is unstable or inputs are invalid', () => {
    expect(() => roundRobinMeanResponseMs(0.2, 2, 10)).toThrow(RangeError); // ρ = 1
    expect(() => roundRobinMeanResponseMs(-0.1, 2, 10)).toThrow(RangeError);
    expect(() => roundRobinMeanResponseMs(0.1, 0, 10)).toThrow(RangeError);
    expect(() => roundRobinMeanResponseMs(0.1, 1.5, 10)).toThrow(RangeError);
    expect(() => roundRobinMeanResponseMs(0.1, 2, 0)).toThrow(RangeError);
  });
});

describe('lognormalMoments', () => {
  const z99 = 2.3263478740408408;

  it('median 5, p99 20 → σ ≈ 0.59591, mean ≈ 5.97147', () => {
    const m = lognormalMoments(5, 20);
    const sigma = Math.log(4) / z99;
    expect(m.mu).toBeCloseTo(Math.log(5), 14);
    expect(m.sigma).toBeCloseTo(sigma, 14);
    expect(m.sigma).toBeCloseTo(0.59591, 5);
    expect(m.mean).toBeCloseTo(5 * Math.exp((sigma * sigma) / 2), 12);
    expect(m.mean).toBeCloseTo(5.97147, 5);
    expect(m.secondMoment).toBeCloseTo(25 * Math.exp(2 * sigma * sigma), 10);
  });

  it('has the right quantiles and moment relations', () => {
    const m = lognormalMoments(5, 20);
    expect(Math.exp(m.mu)).toBeCloseTo(5, 12); // median
    expect(Math.exp(m.mu + z99 * m.sigma)).toBeCloseTo(20, 12); // p99
    expect(m.mean).toBeGreaterThan(5); // right-skewed: mean > median
    // Variance = mean²(e^{σ²} − 1).
    const variance = m.secondMoment - m.mean ** 2;
    expect(variance).toBeCloseTo(m.mean ** 2 * Math.expm1(m.sigma ** 2), 10);
  });

  it('is deterministic when p99 equals the median', () => {
    const m = lognormalMoments(7, 7);
    expect(m.sigma).toBe(0);
    expect(m.mean).toBeCloseTo(7, 12);
    expect(m.secondMoment).toBeCloseTo(49, 10);
  });

  it('throws for invalid inputs', () => {
    expect(() => lognormalMoments(0, 20)).toThrow(RangeError);
    expect(() => lognormalMoments(5, 0)).toThrow(RangeError);
    expect(() => lognormalMoments(5, 4)).toThrow(RangeError);
    expect(() => lognormalMoments(Infinity, 20)).toThrow(RangeError);
  });
});

describe('zipfProbabilities', () => {
  it('sums to 1 and is strictly decreasing for skew > 0', () => {
    const p = zipfProbabilities(1000, 0.9);
    expect(p).toHaveLength(1000);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeLessThan(p[i - 1]);
  });

  it('follows p_i ∝ 1/i^s', () => {
    const p = zipfProbabilities(3, 1);
    // Harmonic number H_3 = 11/6.
    expect(p[0]).toBeCloseTo(6 / 11, 14);
    expect(p[1]).toBeCloseTo(3 / 11, 14);
    expect(p[2]).toBeCloseTo(2 / 11, 14);
  });

  it('is uniform for skew 0', () => {
    const p = zipfProbabilities(4, 0);
    for (const x of p) expect(x).toBe(0.25);
  });

  it('throws for invalid inputs', () => {
    expect(() => zipfProbabilities(0, 1)).toThrow(RangeError);
    expect(() => zipfProbabilities(2.5, 1)).toThrow(RangeError);
    expect(() => zipfProbabilities(10, -0.5)).toThrow(RangeError);
  });
});

describe('cheLruHitRate', () => {
  it('for uniform popularity gives C/N (Che is exact here)', () => {
    // N(1 − e^{−T/N}) = C ⇒ hit rate = 1 − e^{−T/N} = C/N.
    const n = 1000;
    const p = zipfProbabilities(n, 0);
    for (const c of [1, 100, 500, 999]) {
      const hit = cheLruHitRate(p, c);
      expect(Math.abs(hit - c / n)).toBeLessThan(1e-6);
      expect(Math.abs(hit - c / n)).toBeLessThan(0.02);
    }
  });

  it('matches a direct evaluation of the Che formula for Zipf popularity', () => {
    const p = zipfProbabilities(500, 0.8);
    const c = 50;
    const hit = cheLruHitRate(p, c);
    // Recover T from the hit rate's defining equation independently: solve by Newton's method.
    let t = c;
    for (let i = 0; i < 100; i++) {
      let g = -c;
      let dg = 0;
      for (const pi of p) {
        g += 1 - Math.exp(-pi * t);
        dg += pi * Math.exp(-pi * t);
      }
      t -= g / dg;
    }
    let expected = 0;
    for (const pi of p) expected += pi * (1 - Math.exp(-pi * t));
    expect(hit).toBeCloseTo(expected, 9);
    // A cache holding the 10% most popular keys beats C/N by far under skew.
    expect(hit).toBeGreaterThan(0.3);
  });

  it('returns 1 when the cache holds every key and 0 when it has no room', () => {
    const p = zipfProbabilities(10, 1);
    expect(cheLruHitRate(p, 10)).toBe(1);
    expect(cheLruHitRate(p, 25)).toBe(1);
    expect(cheLruHitRate(p, 0)).toBe(0);
  });

  it('ignores keys that are never requested', () => {
    expect(cheLruHitRate([0.5, 0.5, 0], 2)).toBe(1);
    expect(cheLruHitRate([0.5, 0.5, 0], 1)).toBeCloseTo(cheLruHitRate([0.5, 0.5], 1), 12);
  });

  it('increases with capacity and with skew', () => {
    const p = zipfProbabilities(1000, 0.8);
    let previous = 0;
    for (const c of [10, 50, 100, 300, 900]) {
      const hit = cheLruHitRate(p, c);
      expect(hit).toBeGreaterThan(previous);
      previous = hit;
    }
    previous = 0;
    for (const skew of [0, 0.5, 0.8, 1, 1.2]) {
      const hit = cheLruHitRate(zipfProbabilities(1000, skew), 100);
      expect(hit).toBeGreaterThan(previous);
      previous = hit;
    }
  });

  it('throws for invalid inputs', () => {
    expect(() => cheLruHitRate([], 1)).toThrow(RangeError);
    expect(() => cheLruHitRate([0.5, 0.4], 1)).toThrow(RangeError); // sums to 0.9
    expect(() => cheLruHitRate([1.5, -0.5], 1)).toThrow(RangeError);
    expect(() => cheLruHitRate([0.5, NaN], 1)).toThrow(RangeError);
    expect(() => cheLruHitRate([0.5, 0.5], -1)).toThrow(RangeError);
  });
});

describe('ttlCacheHitRate', () => {
  it('single key, λ=1/ms, TTL=9ms → 0.9', () => {
    expect(ttlCacheHitRate([1], 1, 9)).toBeCloseTo(0.9, 14);
  });

  it('weights each key by its popularity', () => {
    // λ = 2/ms; key A: λ_A = 1, TTL 1 → h = 1/2; key B: same → overall 1/2.
    expect(ttlCacheHitRate([0.5, 0.5], 2, 1)).toBeCloseTo(0.5, 14);
    // Key A: λ_A = 3 → h = 3/4; key B: λ_B = 1 → h = 1/2. Overall 0.75·0.75 + 0.25·0.5.
    expect(ttlCacheHitRate([0.75, 0.25], 4, 1)).toBeCloseTo(0.75 * 0.75 + 0.25 * 0.5, 14);
  });

  it('is 0 with no TTL and approaches 1 for a long TTL', () => {
    const p = zipfProbabilities(100, 1);
    expect(ttlCacheHitRate(p, 1, 0)).toBe(0);
    expect(ttlCacheHitRate(p, 1, 1e9)).toBeGreaterThan(0.9999);
  });

  it('throws for invalid inputs', () => {
    expect(() => ttlCacheHitRate([1], 0, 9)).toThrow(RangeError);
    expect(() => ttlCacheHitRate([1], 1, -1)).toThrow(RangeError);
    expect(() => ttlCacheHitRate([0.3], 1, 9)).toThrow(RangeError);
  });
});
