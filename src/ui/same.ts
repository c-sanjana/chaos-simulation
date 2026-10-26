/**
 * Whether two pieces of plain data (drafts, faults, drawings) hold the same values, whatever order
 * their keys were written in. Comparing JSON text made key order matter (code review 4: a failure
 * rebuilt by the editor, with its keys in another order, read as "(edited)" and listed "slows 8× for
 * 5 s at 30 s → slows 8× for 5 s at 30 s" as a change).
 * As JSON sees it otherwise: a key set to undefined counts as missing, arrays keep their order, and
 * numbers compare by value (NaN equals NaN, as both would be written null).
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameData(x, b[i]));
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
  const [kx, ky] = [keys(x), keys(y)];
  return kx.length === ky.length && kx.every((k) => Object.prototype.hasOwnProperty.call(y, k) && sameData(x[k], y[k]));
}
