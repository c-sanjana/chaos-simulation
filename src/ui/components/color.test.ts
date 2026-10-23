import { withAlpha } from './color';

describe('withAlpha', () => {
  it('converts #RRGGBB to rgba and leaves other colours alone', () => {
    expect(withAlpha('#1F6FEB', 0.55)).toBe('rgba(31,111,235,0.55)');
    expect(withAlpha('rgba(1,2,3,0.5)', 0.55)).toBe('rgba(1,2,3,0.5)');
    expect(withAlpha('#abc', 0.5)).toBe('#abc');
  });
});
