import type { RunConfig } from './config';
import { validateConfig } from './validate';
import { call, singleTier, tier } from './testConfigs';

const ok = () => singleTier(10, { kind: 'exponential', meanMs: 5 }, 1000);

describe('validateConfig', () => {
  it('accepts a valid config', () => {
    expect(() => validateConfig(ok())).not.toThrow();
    expect(() => validateConfig({ ...ok(), bucketMs: 500 })).not.toThrow();
    expect(() => validateConfig(singleTier(10, { kind: 'lognormal', medianMs: 5, p99Ms: 20 }, 1000, { queueLimit: 3 }, { timeoutMs: 100 }))).not.toThrow();
  });

  const cases: Array<[string, (c: RunConfig) => void, RegExp]> = [
    ['non-integer seed', (c) => (c.seed = 1.5), /seed/],
    ['zero duration', (c) => (c.durationMs = 0), /durationMs/],
    ['bad bucket', (c) => (c.bucketMs = -1), /bucketMs/],
    ['zero rps', (c) => (c.client.rps = 0), /rps/],
    ['no tiers', (c) => (c.tiers = []), /at least one tier/],
    ['duplicate ids', (c) => c.tiers.push({ ...c.tiers[0] }), /duplicate/],
    ['unknown target', (c) => (c.client.call.target = 'nope'), /unknown tier/],
    ['bad timeout', (c) => (c.client.call.timeoutMs = 0), /timeoutMs/],
    ['negative retries', (c) => (c.client.call.retries = -1), /retries/],
    ['negative backoff', (c) => (c.client.call.backoffBaseMs = -5), /backoff/],
    ['zero instances', (c) => (c.tiers[0].instances = 0), /instances/],
    ['fractional workers', (c) => (c.tiers[0].workersPerInstance = 1.5), /workersPerInstance/],
    ['zero cores', (c) => (c.tiers[0].coresPerInstance = 0), /coresPerInstance/],
    ['negative queue limit', (c) => (c.tiers[0].queueLimit = -1), /queueLimit/],
    ['bad exponential', (c) => (c.tiers[0].service = { kind: 'exponential', meanMs: 0 }), /meanMs/],
    ['bad fixed', (c) => (c.tiers[0].service = { kind: 'fixed', ms: -1 }), /service ms/],
    ['bad lognormal median', (c) => (c.tiers[0].service = { kind: 'lognormal', medianMs: 0, p99Ms: 5 }), /medianMs/],
    ['p99 below median', (c) => (c.tiers[0].service = { kind: 'lognormal', medianMs: 5, p99Ms: 4 }), /p99Ms/],
    ['bad downstream', (c) => (c.tiers[0].downstream = call('missing')), /unknown tier/],
    ['zero retry budget', (c) => (c.client.call.retryBudget = 0), /retryBudget/],
    ['non-finite retry budget', (c) => (c.client.call.retryBudget = Infinity), /retryBudget/],
    ['coalesceMisses without cacheAside', (c) => (c.tiers[0].coalesceMisses = true), /coalesceMisses needs cacheAside/],
  ];

  it.each(cases)('rejects %s', (_, mutate, message) => {
    const c = ok();
    mutate(c);
    expect(() => validateConfig(c)).toThrow(message);
  });

  describe('caches and faults', () => {
    const withCache = (): RunConfig => ({
      ...ok(),
      tiers: [
        tier('svc', { kind: 'fixed', ms: 1 }, { cacheAside: call('cache'), downstream: call('db') }),
        tier('cache', { kind: 'fixed', ms: 1 }, { cache: { capacity: 10, ttlMs: 1000, keys: 100, skew: 1 } }),
        tier('db', { kind: 'fixed', ms: 1 }),
      ],
      faults: [{ tier: 'db', kind: 'slow', factor: 2, startMs: 10, endMs: 20, instance: 0 }],
    });

    it('accepts a valid cache-aside setup with faults', () => {
      expect(() => validateConfig(withCache())).not.toThrow();
      const c = withCache();
      c.tiers[0].coalesceMisses = true;
      c.tiers[0].downstream!.retryBudget = 0.1;
      expect(() => validateConfig(c)).not.toThrow();
    });

    const cacheCases: Array<[string, (c: RunConfig) => void, RegExp]> = [
      ['client calling a cache', (c) => (c.client.call.target = 'cache'), /client cannot call a cache/],
      ['cache with a downstream', (c) => (c.tiers[1].downstream = call('db')), /cannot call other tiers/],
      ['zero capacity', (c) => (c.tiers[1].cache!.capacity = 0), /capacity/],
      ['zero keys', (c) => (c.tiers[1].cache!.keys = 0), /keys/],
      ['negative skew', (c) => (c.tiers[1].cache!.skew = -1), /skew/],
      ['bad ttl', (c) => (c.tiers[1].cache!.ttlMs = 0), /ttlMs/],
      ['cacheAside to a non-cache', (c) => (c.tiers[0].cacheAside = call('db')), /not a cache tier/],
      ['cacheAside without downstream', (c) => (c.tiers[0].downstream = null), /no downstream/],
      ['cache as a downstream', (c) => ((c.tiers[0].cacheAside = undefined), (c.tiers[0].downstream = call('cache'))), /use cacheAside/],
      ['fault on unknown tier', (c) => (c.faults![0].tier = 'x'), /unknown tier/],
      ['fault with bad window', (c) => (c.faults![0].endMs = 5), /startMs < endMs/],
      ['slow without factor', (c) => (c.faults![0].factor = undefined), /factor/],
      ['fault on missing instance', (c) => (c.faults![0].instance = 3), /does not exist/],
    ];

    it.each(cacheCases)('rejects %s', (_, mutate, message) => {
      const c = withCache();
      mutate(c);
      expect(() => validateConfig(c)).toThrow(message);
    });
  });

  describe('queues', () => {
    const withQueue = (): RunConfig => ({
      ...ok(),
      client: { rps: 10, call: call('q') },
      tiers: [
        tier('q', { kind: 'fixed', ms: 1 }, { queue: { maxDepth: 100, consumers: 2 }, downstream: call('q2', { timeoutMs: 50, retries: 1 }) }),
        tier('q2', { kind: 'fixed', ms: 1 }, { queue: { maxDepth: 5, consumers: 1 }, downstream: call('svc') }),
        tier('svc', { kind: 'fixed', ms: 1 }, { downstream: call('db') }),
        tier('db', { kind: 'fixed', ms: 1 }),
        tier('cache', { kind: 'fixed', ms: 1 }, { cache: { capacity: 10, ttlMs: null, keys: 100, skew: 1 } }),
      ],
    });

    it('accepts the client calling a queue that calls another queue, a server and a database', () => {
      expect(() => validateConfig(withQueue())).not.toThrow();
      const c = withQueue();
      c.client.call.target = 'svc';
      c.tiers[2].downstream = call('q');
      c.tiers[1].downstream = call('db');
      expect(() => validateConfig(c)).not.toThrow();
    });

    const queueCases: Array<[string, (c: RunConfig) => void, RegExp]> = [
      ['a queue without downstream', (c) => (c.tiers[0].downstream = null), /needs a downstream/],
      ['a queue using cacheAside', (c) => (c.tiers[0].cacheAside = call('cache')), /cannot be a cache or use cacheAside/],
      ['a queue that is also a cache', (c) => ((c.tiers[4].queue = { maxDepth: 1, consumers: 1 })), /cannot be a cache or use cacheAside/],
      ['a queue handing messages to a cache', (c) => (c.tiers[1].downstream = call('cache')), /cannot hand messages to cache tier/],
      ['zero maxDepth', (c) => (c.tiers[0].queue!.maxDepth = 0), /maxDepth/],
      ['fractional consumers', (c) => (c.tiers[0].queue!.consumers = 1.5), /consumers/],
      ['a cycle through queues', (c) => (c.tiers[3].downstream = call('q')), /cycle/],
    ];

    it.each(queueCases)('rejects %s', (_, mutate, message) => {
      const c = withQueue();
      mutate(c);
      expect(() => validateConfig(c)).toThrow(message);
    });
  });

  it('rejects call cycles', () => {
    const c: RunConfig = {
      ...ok(),
      tiers: [
        tier('svc', { kind: 'fixed', ms: 1 }, { downstream: call('b') }),
        tier('b', { kind: 'fixed', ms: 1 }, { downstream: call('svc') }),
      ],
    };
    expect(() => validateConfig(c)).toThrow(/cycle/);
  });
});
