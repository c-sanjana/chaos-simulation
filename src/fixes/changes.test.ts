import { analyzed, retryStormRun } from '../analysis/testRuns';
import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RunConfig } from '../engine/config';
import { call, tier } from '../engine/testConfigs';
import { candidateFixes } from './candidates';
import { configChanges } from './changes';

const labels = Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label]));

describe('configChanges for each catalogue fix on the retry storm', { timeout: 60_000 }, () => {
  const { config, analysis } = retryStormRun({ retries: 3 });
  const candidates = candidateFixes(config, analysis.signals, labels);
  const db = { from: 'api', to: 'db' };

  it('labels exactly the setting each fix changed, in plain words', () => {
    expect(Object.fromEntries(candidates.map((c) => [c.id, configChanges(config, c.config)]))).toEqual({
      'retry-budget': [{ call: db, text: 'retry budget 10%' }],
      'cap-retries': [{ call: db, text: 'max 1 retry (was 3)' }],
      'jitter-backoff': [{ call: db, text: 'random retry delays' }],
      'bound-queue': [{ tier: 'db', text: 'queue limit 93' }],
      'drop-expired': [{ tier: 'db', text: 'skips abandoned work' }],
      'coalesce-misses': [{ tier: 'api', text: 'shares cache refills' }],
      'longer-timeout': [{ call: db, text: 'timeout 3 s (was 1 s)' }],
      'add-instances': [{ tier: 'api', text: '6 instances (was 4)' }],
    });
  });

  it('finds nothing between a config and itself', () => {
    expect(configChanges(config, structuredClone(config))).toEqual([]);
  });
});

describe('configChanges for the retry fixes on the default retry storm (every layer retrying)', { timeout: 60_000 }, () => {
  const { config, analysis } = analyzed(buildRunConfig(webChain, retryStorm));
  const byId = Object.fromEntries(candidateFixes(config, analysis.signals, labels).map((c) => [c.id, configChanges(config, c.config)]));

  it('labels every call that stops retrying, the client\'s included, for retrying at one layer', () => {
    expect(byId['retry-one-layer']).toEqual([
      { call: { from: 'client', to: 'gateway' }, text: 'no retries (was 5)' },
      { call: { from: 'gateway', to: 'api' }, text: 'no retries (was 3)' },
    ]);
  });

  it('labels the one call each other retry fix changed', () => {
    expect([byId['retry-budget'], byId['cap-retries'], byId['jitter-backoff']]).toEqual([
      [{ call: { from: 'api', to: 'db' }, text: 'retry budget 10%' }],
      [{ call: { from: 'gateway', to: 'api' }, text: 'max 1 retry (was 3)' }],
      [{ call: { from: 'api', to: 'db' }, text: 'random retry delays' }],
    ]);
  });
});

describe('configChanges', () => {
  const base = (): RunConfig => ({
    seed: 1,
    durationMs: 1000,
    client: { rps: 1, call: call('api', { timeoutMs: 2000 }) },
    tiers: [
      tier('api', { kind: 'fixed', ms: 1 }, { cacheAside: call('cache', { timeoutMs: 50 }), downstream: call('db', { timeoutMs: 1000, retries: 1, backoffBaseMs: 50, retryBudget: 0.1 }) }),
      tier('cache', { kind: 'fixed', ms: 1 }, { cache: { capacity: 1, ttlMs: null, keys: 2, skew: 1 } }),
      tier('db', { kind: 'fixed', ms: 1 }, { queueLimit: 20, dropExpired: true, workersPerInstance: 8, coresPerInstance: 4 }),
    ],
  });

  it('words each kind of tier change, both ways', () => {
    const after = base();
    after.tiers[0].coalesceMisses = true;
    after.tiers[2] = { ...after.tiers[2], queueLimit: null, dropExpired: false, instances: 1, workersPerInstance: 1, coresPerInstance: 1 };
    expect(configChanges(base(), after)).toEqual([
      { tier: 'api', text: 'shares cache refills' },
      { tier: 'db', text: 'no queue limit (was 20)' },
      { tier: 'db', text: 'no longer skips abandoned work' },
      { tier: 'db', text: '1 worker each (was 8)' },
      { tier: 'db', text: '1 core each (was 4)' },
    ]);
    after.tiers[2] = { ...after.tiers[2], queueLimit: 5, instances: 2, workersPerInstance: 16, coresPerInstance: 8 };
    expect(configChanges(base(), after).map((c) => c.text)).toEqual(['shares cache refills', 'queue limit 5 (was 20)', 'no longer skips abandoned work', '2 instances (was 1)', '16 workers each (was 8)', '8 cores each (was 4)']);
    expect(configChanges(after, base()).map((c) => c.text)).toContain('no longer shares cache refills');
    expect(configChanges(after, base()).map((c) => c.text)).toContain('skips abandoned work');
  });

  it('words each kind of call change, including the client’s and cache-aside calls', () => {
    const after = base();
    after.client.call = { ...after.client.call, timeoutMs: null, retries: 2 };
    after.tiers[0].cacheAside = { ...after.tiers[0].cacheAside!, timeoutMs: 100 };
    after.tiers[0].downstream = { ...after.tiers[0].downstream!, retries: 0, retryBudget: undefined, jitter: true, backoffBaseMs: 100 };
    expect(configChanges(base(), after)).toEqual([
      { call: { from: 'client', to: 'api' }, text: 'max 2 retries (was 0)' },
      { call: { from: 'client', to: 'api' }, text: 'no timeout (was 2 s)' },
      { call: { from: 'api', to: 'cache' }, text: 'timeout 100 ms (was 50 ms)' },
      { call: { from: 'api', to: 'db' }, text: 'no retries (was 1)' },
      { call: { from: 'api', to: 'db' }, text: 'no retry budget (was 10%)' },
      { call: { from: 'api', to: 'db' }, text: 'random retry delays (first up to 100 ms)' },
    ]);
    expect(configChanges(after, base()).map((c) => c.text)).toEqual(['no retries (was 2)', 'timeout 2 s (was none)', 'timeout 50 ms (was 100 ms)', 'max 1 retry (was 0)', 'retry budget 10%', 'fixed retry delays']);
    const tighter = base();
    tighter.tiers[0].downstream = { ...tighter.tiers[0].downstream!, retryBudget: 0.05, backoffBaseMs: 200 };
    expect(configChanges(base(), tighter).map((c) => c.text)).toEqual(['retry budget 5% (was 10%)', 'retry delay 200 ms (was 50 ms)']);
  });

  it('ignores tiers and calls present in only one config', () => {
    const fewer = { ...base(), tiers: base().tiers.filter((t) => t.id !== 'db') };
    expect(configChanges(base(), fewer)).toEqual([]);
    const noCache = base();
    noCache.tiers[0].cacheAside = undefined;
    expect(configChanges(base(), noCache)).toEqual([]);
  });
});
