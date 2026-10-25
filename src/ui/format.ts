import { FIELD_LIMITS } from './fieldLimits';

/**
 * Number formatting that never throws. `toLocaleString()` with the browser's default locale throws
 * a RangeError when that locale is malformed (e.g. "en-US@posix"), which blanked the whole page
 * (REVIEW2 2.7). Everything the page shows is in English, so numbers use 'en-US' explicitly, with
 * a plain fallback in case Intl itself is unusable.
 */
export function formatCount(n: number): string {
  try {
    return Math.round(n).toLocaleString('en-US');
  } catch {
    // ASSUMPTION: thousands separators are a nicety; without Intl, plain digits are still correct.
    return String(Math.round(n));
  }
}

/**
 * A split's shares (fractions adding up to 1) as whole percents that add up to 100: each rounded
 * down, then the points left over go to the largest remainders (ties to the first), so three even
 * shares read 34/33/33, never 33/33/33.
 */
export function roundedPercents(fractions: number[]): number[] {
  const exact = fractions.map((f) => (Number.isFinite(f) ? f * 100 : 0));
  const down = exact.map((x) => Math.floor(x + 1e-9));
  let left = Math.round(exact.reduce((a, b) => a + b, 0)) - down.reduce((a, b) => a + b, 0);
  const order = exact.map((_, i) => i).sort((i, j) => exact[j] - down[j] - (exact[i] - down[i]) || i - j);
  for (const i of order) if (left-- > 0) down[i]++;
  return down;
}

/**
 * A share of traffic for text: its whole percent (`rounded`, from roundedPercents), but "<1%" and
 * ">99%" for shares below 1% or above 99%, so a part that gets a little traffic never reads as
 * getting none (validation looks at the share itself, never at this text). 0 or less reads as it is.
 */
export function formatSharePercent(fraction: number, rounded = Math.round(fraction * 100)): string {
  if (fraction > 0 && fraction < 0.01) return '<1%';
  if (fraction > 0.99 && fraction < 1) return '>99%';
  return `${rounded}%`;
}

/**
 * A share of traffic as a share field shows it: its whole percent (`rounded`), or, for a share below
 * 1% or above 99%, one decimal kept inside the field's range (FIELD_LIMITS.minSharePct to
 * maxSharePct). So a share the viewer never typed (0.3% after another arrow was set to 99%) never
 * shows as an invalid "0". A share of 0 or less, or all of the traffic, shows as it is (the field
 * and validation then say what's wrong).
 */
export function sharePercentField(fraction: number, rounded = Math.round(fraction * 100)): number {
  if (!(fraction > 0 && fraction < 1) || (fraction >= 0.01 && fraction <= 0.99)) return rounded;
  return Math.min(FIELD_LIMITS.maxSharePct, Math.max(FIELD_LIMITS.minSharePct, Math.round(fraction * 1000) / 10));
}
