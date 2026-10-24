/**
 * Failure windows as drawn: overlapping or touching windows merged into one, so two failures at
 * the same time are tinted once at the usual strength instead of stacking into a darker block
 * (REVIEW2 6.3). Sorted by start; the input is not changed.
 */
export function mergeWindows(windows: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [from, to] of sorted) {
    const last = out[out.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else out.push([from, to]);
  }
  return out;
}
