import { backoffDelayMs } from './caller';
import { call } from './testConfigs';

describe('backoffDelayMs', () => {
  it('doubles from the base delay without jitter', () => {
    const p = call('x', { backoffBaseMs: 50 });
    expect([1, 2, 3, 4].map((n) => backoffDelayMs(p, n, 0.5))).toEqual([50, 100, 200, 400]);
  });

  it('scales the ceiling by the uniform draw with full jitter', () => {
    const p = call('x', { backoffBaseMs: 50, jitter: true });
    expect(backoffDelayMs(p, 3, 0.25)).toBe(50);
  });

  it('is zero when there is no backoff', () => {
    expect(backoffDelayMs(call('x'), 5, 0.9)).toBe(0);
  });
});
