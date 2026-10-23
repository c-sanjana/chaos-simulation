import { call, tier } from '../engine/testConfigs';
import type { RunConfig } from '../engine/config';
import { callerOf, formatMs, formatSeconds, leafCapacityRps, nameOf, percent, sumRange } from './helpers';

const config: RunConfig = {
  seed: 1,
  durationMs: 1000,
  client: { rps: 1, call: call('api', { timeoutMs: 3000 }) },
  tiers: [
    tier('api', { kind: 'fixed', ms: 1 }, { cacheAside: call('cache', { timeoutMs: 50 }), downstream: call('db', { timeoutMs: 1000 }) }),
    tier('cache', { kind: 'fixed', ms: 1 }, { cache: { capacity: 1, ttlMs: null, keys: 2, skew: 1 } }),
    tier('db', { kind: 'exponential', meanMs: 20 }, { instances: 2, workersPerInstance: 8, coresPerInstance: 4 }),
  ],
};

describe('analysis helpers', () => {
  it('finds each tier\'s caller and timeout', () => {
    expect(callerOf(config, 'api')).toEqual({ id: 'client', timeoutMs: 3000 });
    expect(callerOf(config, 'cache')).toEqual({ id: 'api', timeoutMs: 50 });
    expect(callerOf(config, 'db')).toEqual({ id: 'api', timeoutMs: 1000 });
    expect(callerOf(config, 'nobody')).toBeNull();
  });

  it('computes leaf capacity from the binding resource', () => {
    expect(leafCapacityRps(config.tiers[2])).toBe((2 * 4 * 1000) / 20);
    expect(leafCapacityRps(config.tiers[0])).toBeNull();
  });

  it('formats and sums', () => {
    expect(formatMs(850.4)).toBe('850 ms');
    expect(formatMs(1300)).toBe('1.3 s');
    expect(formatMs(2000)).toBe('2 s');
    expect(formatMs(12_345)).toBe('12 s');
    expect(formatSeconds(12_400)).toBe('12 s');
    expect(percent(0.756)).toBe('76%');
    expect(sumRange([1, 2, 3, 4], -1, 10)).toBe(10);
    expect(sumRange([1, 2, 3, 4], 1, 3)).toBe(5);
    expect(nameOf('client', {})).toBe('Client');
    expect(nameOf('db', { db: 'DB' })).toBe('DB');
    expect(nameOf('db', {})).toBe('db');
  });
});
