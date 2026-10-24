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
