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
  ];

  it.each(cases)('rejects %s', (_, mutate, message) => {
    const c = ok();
    mutate(c);
    expect(() => validateConfig(c)).toThrow(message);
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
