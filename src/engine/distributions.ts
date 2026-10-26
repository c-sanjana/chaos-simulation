/**
 * Inverse-CDF sampling of the service-time distributions.
 *
 * Every sampler takes a uniform u in (0, 1) (from rng.ts `uniform`) rather than drawing its own,
 * so one uniform maps to one sample: the same request gets the same service time in every run.
 */
import type { ServiceTime } from './config';

/** Exponential with the given mean, by inversion: −mean·ln(u). u must be in (0, 1]. */
export function exponential(u: number, mean: number): number {
  return -mean * Math.log(u);
}

// Coefficients of Peter J. Acklam's rational approximation to the inverse normal CDF.
const A1 = -3.969683028665376e1;
const A2 = 2.209460984245205e2;
const A3 = -2.759285104469687e2;
const A4 = 1.38357751867269e2;
const A5 = -3.066479806614716e1;
const A6 = 2.506628277459239;
const B1 = -5.447609879822406e1;
const B2 = 1.615858368580409e2;
const B3 = -1.556989798598866e2;
const B4 = 6.680131188771972e1;
const B5 = -1.328068155288572e1;
const C1 = -7.784894002430293e-3;
const C2 = -3.223964580411365e-1;
const C3 = -2.400758277161838;
const C4 = -2.549732539343734;
const C5 = 4.374664141464968;
const C6 = 2.938163982698783;
const D1 = 7.784695709041462e-3;
const D2 = 3.224671290700398e-1;
const D3 = 2.445134137142996;
const D4 = 3.754408661907416;
/** Break-point between the central region and the tails. */
const P_LOW = 0.02425;

/**
 * Inverse of the standard normal CDF (the probit function), by Acklam's algorithm.
 * Relative error below 1.15e-9 over the whole of (0, 1).
 *
 * Judgement call: no Halley refinement step. It would need an erfc accurate to ~1e-16, which
 * JavaScript lacks and would roughly double the cost of every lognormal sample, while 1e-9 is far
 * below anything the simulation can resolve.
 *
 * Returns −Infinity for p <= 0, +Infinity for p >= 1, and NaN for NaN.
 */
export function inverseNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((C1 * q + C2) * q + C3) * q + C4) * q + C5) * q + C6) /
      ((((D1 * q + D2) * q + D3) * q + D4) * q + 1)
    );
  }
  if (p > 1 - P_LOW) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((C1 * q + C2) * q + C3) * q + C4) * q + C5) * q + C6) /
      ((((D1 * q + D2) * q + D3) * q + D4) * q + 1)
    );
  }
  // Central region (also reached by NaN, which propagates through the arithmetic).
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((A1 * r + A2) * r + A3) * r + A4) * r + A5) * r + A6) * q) /
    (((((B1 * r + B2) * r + B3) * r + B4) * r + B5) * r + 1)
  );
}

/** Φ⁻¹(0.99): the number of standard deviations from the median to the 99th percentile. */
const Z99 = 2.3263478740408408;

/**
 * One service time (ms) for uniform u in (0, 1), by inverting the distribution's CDF.
 *
 * Lognormal: mu = ln(median), sigma = (ln(p99) − ln(median)) / Φ⁻¹(0.99), so the configured
 * median and p99 are exact. validateConfig requires p99 > median (equal would give a constant).
 * `fixed` ignores u.
 */
export function sampleServiceTime(dist: ServiceTime, u: number): number {
  switch (dist.kind) {
    case 'exponential':
      return exponential(u, dist.meanMs);
    case 'lognormal': {
      const mu = Math.log(dist.medianMs);
      const sigma = (Math.log(dist.p99Ms) - mu) / Z99;
      return Math.exp(mu + sigma * inverseNormalCdf(u));
    }
    case 'fixed':
      return dist.ms;
  }
}

/**
 * Mean E[S] and second moment E[S²] of a service-time distribution (ms and ms²), as used by
 * queueing formulas such as Pollaczek–Khinchine.
 */
export function serviceTimeMoments(dist: ServiceTime): { mean: number; secondMoment: number } {
  switch (dist.kind) {
    case 'exponential':
      return { mean: dist.meanMs, secondMoment: 2 * dist.meanMs * dist.meanMs };
    case 'lognormal': {
      // E[S^k] = exp(k·mu + k²·sigma²/2).
      const mu = Math.log(dist.medianMs);
      const sigma = (Math.log(dist.p99Ms) - mu) / Z99;
      const s2 = sigma * sigma;
      return { mean: Math.exp(mu + s2 / 2), secondMoment: Math.exp(2 * mu + 2 * s2) };
    }
    case 'fixed':
      return { mean: dist.ms, secondMoment: dist.ms * dist.ms };
  }
}
