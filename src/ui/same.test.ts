import { sameData } from './same';
import { PRESET_SYSTEM, systemDraft } from './system';

describe('sameData', () => {
  it('compares plain data by value, whatever order its keys were written in', () => {
    expect(sameData({ tier: 'db', kind: 'slow', factor: 8 }, { factor: 8, kind: 'slow', tier: 'db' })).toBe(true);
    expect(sameData({ a: [1, { b: 2, c: 3 }] }, { a: [1, { c: 3, b: 2 }] })).toBe(true);
    const d = systemDraft(PRESET_SYSTEM, 'retry-storm');
    expect(sameData(d, structuredClone(d))).toBe(true);
  });

  it('tells different values apart: arrays keep their order, null is not missing', () => {
    expect(sameData([1, 2], [2, 1])).toBe(false);
    expect(sameData({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameData({ a: null }, {})).toBe(false);
    expect(sameData({ a: 1 }, { a: '1' })).toBe(false);
    expect(sameData([], {})).toBe(false);
    expect(sameData(null, {})).toBe(false);
  });

  it('reads like JSON otherwise: a key set to undefined counts as missing, NaN equals NaN', () => {
    expect(sameData({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameData({ x: NaN }, { x: NaN })).toBe(true);
    expect(sameData(undefined, undefined)).toBe(true);
  });
});
