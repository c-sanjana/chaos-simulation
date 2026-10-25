import { call, tier } from '../engine/testConfigs';
import type { RunConfig } from '../engine/config';
import { KIND_LABELS } from '../builder/graph';
import { formatMs, formatSeconds, leafCapacityRps, nameOf, percent, spokenName, sumRange } from './helpers';

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
  it('says names the way a newcomer would', () => {
    const labels = { db: 'DB', api: 'API', lb: 'Load balancer', cache: 'Cache', client: 'Client' };
    expect(spokenName('db', labels)).toBe('the database');
    expect(spokenName('api', labels)).toBe('the API');
    expect(spokenName('lb', labels)).toBe('the load balancer');
    expect(spokenName('cache', labels)).toBe('the cache');
    expect(spokenName('client', labels)).toBe('the client');
    expect(spokenName('svc', {})).toBe('the svc');
    // The builder's kind names are common nouns; numbered copies and typed names keep their spelling (review 3).
    for (const kind of Object.values(KIND_LABELS)) expect(spokenName('x', { x: kind })).toBe(`the ${kind.toLowerCase()}`);
    expect(spokenName('x', { x: 'App server 2' })).toBe('App server 2');
    expect(spokenName('x', { x: 'Database 12' })).toBe('Database 12');
    expect(spokenName('x', { x: 'Ledger DB' })).toBe('the Ledger DB');
    expect(spokenName('x', { x: 'redis' })).toBe('the redis');
    expect(spokenName('x', { x: 'Orders service' })).toBe('the Orders service');
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
