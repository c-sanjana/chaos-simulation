import { retryStormRun } from './testRuns';

describe('computeSignals', { timeout: 60_000 }, () => {
  it('finds retries, wasted work, idle saturation and a cache drop in the stuck retry storm', () => {
    const s = retryStormRun({ retries: 3 }).analysis.signals;
    expect(s.retryShare).toMatchObject({ tier: 'db' });
    expect(s.retryShare!.value).toBeGreaterThan(0.5);
    expect(s.wastedShare).toMatchObject({ tier: 'db' });
    expect(s.wastedShare!.value).toBeGreaterThan(0.9);
    expect(s.idleSaturation!.value).toBeGreaterThan(10); // seconds with workers saturated and CPU idle
    expect(s.queueWaitOverTimeout!.value).toBeGreaterThan(1);
    expect(s.cacheHitDrop!.value.during).toBeLessThan(s.cacheHitDrop!.value.before);
  });

  it('finds no retries when there are none', () => {
    const s = retryStormRun({ retries: 0 }).analysis.signals;
    expect(s.retryShare).toBeNull();
    expect(s.idleSaturation).toBeNull();
  });
});
