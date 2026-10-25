import { analyzed } from '../analysis/testRuns';
import { fanIn, graphLabels } from '../analysis/testGraphs';
import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import { acrossTheStack, callFactor, formatFactor, retryAmplification } from './amplification';
import { candidateFixes } from './candidates';
import { call } from '../engine/testConfigs';

const labels = Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label]));

describe('retry amplification', () => {
  it('counts a call as 1 + its retries, or 1 + its budget when that is smaller', () => {
    expect(callFactor(call('db', { retries: 0 }))).toBe(1);
    expect(callFactor(call('db', { retries: 3 }))).toBe(4);
    expect(callFactor(call('db', { retries: 3, retryBudget: 0.1 }))).toBeCloseTo(1.1);
    expect(callFactor(call('db', { retries: 0, retryBudget: 0.1 }))).toBe(1);
  });

  it('multiplies the factors along the way to a tier: the default retry storm can send 6 × 4 × 2 = 48 calls to the DB', () => {
    const config = buildRunConfig(webChain, retryStorm);
    const a = retryAmplification(config, 'db')!;
    expect(a.factor).toBe(48);
    expect(a.layers).toEqual([
      { owner: 'client', factor: 6 },
      { owner: 'gateway', factor: 4 },
      { owner: 'api', factor: 2 },
    ]);
    expect(retryAmplification(config, 'client')).toBeNull(); // nothing calls the users
  });

  it('with several ways in, takes the one that multiplies most', () => {
    const config = fanIn({ reportsRetries: 3 });
    const a = retryAmplification(config, 'db')!;
    expect(a.factor).toBe(4);
    expect(a.layers.map((l) => l.owner)).toEqual(['client', 'gateway', 'reports']);
  });

  it('formats factors as whole numbers, or one decimal below 10', () => {
    expect([formatFactor(6), formatFactor(1.1), formatFactor(1.331), formatFactor(26.4)]).toEqual(['6', '1.1', '1.3', '26']);
  });

  it('says nothing when no call on the way retries, before or after', () => {
    const config = fanIn({ reportsRetries: 0 });
    const none = { ...config, tiers: config.tiers.map((t) => (t.downstream ? { ...t, downstream: { ...t.downstream, retries: 0 } } : t)) };
    expect(acrossTheStack(none, none, 'db', 'layer', graphLabels)).toBeNull();
  });
});

describe('the fix panel\'s "across the stack" line on the default retry storm', { timeout: 60_000 }, () => {
  const { config, analysis } = analyzed(buildRunConfig(webChain, retryStorm));
  const byId = Object.fromEntries(candidateFixes(config, analysis.signals, labels).map((c) => [c.id, c]));
  const whole = "If every call fails, retries can multiply the calls reaching the database up to 48× (users' apps 6 × the load balancer 4 × the app server 2).";

  it('labels each retry fix one layer or whole stack, and no other fix', () => {
    expect(Object.fromEntries(Object.values(byId).map((c) => [c.id, c.scope ?? null]))).toEqual({
      'retry-budget': 'layer',
      'retry-budget-every-layer': 'stack',
      'cap-retries': 'layer',
      'jitter-backoff': 'layer',
      'retry-one-layer': 'stack',
      'bound-queue': null,
      'drop-expired': null,
      'coalesce-misses': null,
      'longer-timeout': null,
      'add-instances': null,
    });
    expect(byId['bound-queue'].acrossStack).toBeUndefined();
  });

  it('shows how much each retry fix changes the end-to-end multiplication', () => {
    expect(byId['retry-budget'].acrossStack).toBe(`Only one layer changes. ${whole} With this fix: up to 26× (6 × 4 × 1.1).`);
    expect(byId['cap-retries'].acrossStack).toBe(`Only one layer changes. ${whole} With this fix: up to 24× (6 × 2 × 2).`);
    expect(byId['jitter-backoff'].acrossStack).toBe(`Only one layer changes. ${whole} This fix leaves that at 48×.`);
    expect(byId['retry-one-layer'].acrossStack).toBe(`Every layer that retries changes together. ${whole} With this fix: up to 2×.`);
    expect(byId['retry-budget-every-layer'].acrossStack).toBe(`Every layer that retries changes together. ${whole} With this fix: up to 1.3× (1.1 × 1.1 × 1.1).`);
  });

  it('puts a 10% budget on every call that retries, and says who', () => {
    const c = byId['retry-budget-every-layer'];
    expect(c.what).toBe("Users' apps, the Load balancer and the App server each stop retrying once retries reach 10% of their first attempts.");
    expect(c.title).toBe('Retry budget of 10% at every layer: every layer that retries');
    const budgets = [c.config.client.call, ...c.config.tiers.flatMap((t) => (t.downstream ? [t.downstream] : []))].map((p) => (p.retries > 0 ? p.retryBudget : null));
    expect(budgets).toEqual([0.1, 0.1, 0.1]); // users' apps, gateway → app server, app server → DB
    expect(c.config.tiers.find((t) => t.id === 'api')!.cacheAside!.retryBudget).toBeUndefined(); // cache lookups don't retry
  });
});
