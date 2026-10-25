import { formatSharePercent, roundedPercents, sharePercentField } from './format';

describe('shares of traffic in percent', () => {
  it('rounds a split to whole percents that add up to 100', () => {
    expect(roundedPercents([1 / 3, 1 / 3, 1 / 3])).toEqual([34, 33, 33]);
    expect(roundedPercents([0.7, 0.2, 0.1])).toEqual([70, 20, 10]);
    expect(roundedPercents([0.99, 0.0033, 0.0033, 0.0034])).toEqual([99, 0, 0, 1]);
    expect(roundedPercents([0.5, NaN])).toEqual([50, 0]);
  });

  it('never shows a share that gets some traffic as 0%, or one that leaves some as 100% (code review 3, finding 6)', () => {
    expect(formatSharePercent(0.5)).toBe('50%');
    expect(formatSharePercent(0.003)).toBe('<1%');
    expect(formatSharePercent(0.998)).toBe('>99%');
    expect(formatSharePercent(1 / 3, 34)).toBe('34%');
    expect(formatSharePercent(0)).toBe('0%');
    expect(formatSharePercent(1)).toBe('100%');
  });

  it("shows a share field's value inside the field's range, so a share nobody typed never shows as invalid", () => {
    expect(sharePercentField(0.5)).toBe(50);
    expect(sharePercentField(1 / 3, 34)).toBe(34);
    expect(sharePercentField(0.0033)).toBe(0.3);
    expect(sharePercentField(0.0002)).toBe(0.1);
    expect(sharePercentField(0.9967)).toBe(99.7);
    expect(sharePercentField(0.99996)).toBe(99.9);
    // Really 0 or all of it: shown as it is, so the field and validation say what's wrong.
    expect(sharePercentField(0)).toBe(0);
    expect(sharePercentField(1)).toBe(100);
  });
});
