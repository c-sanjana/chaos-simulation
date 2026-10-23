/** Retry budget: the token bucket itself, and its effect on whole runs. */
import type { CallPolicy, RunConfig } from './config';
import { runSimulation } from './run';
import { RetryBudget, budgetFor } from './retryBudget';
import type { RunResult } from './result';
import { call, singleTier, tier } from './testConfigs';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const firstAttempts = (r: RunResult, id: string) => sum(r.tiers[id].arrivalsFirst);
const retries = (r: RunResult, id: string) => sum(r.tiers[id].arrivalsRetry);

function expectConservation(r: RunResult) {
  for (const t of Object.values(r.tiers)) {
    const x = t.totals;
    expect(x.arrivals).toBe(x.ok + x.failed + x.rejected + x.dropped + x.inFlightAtEnd);
  }
}

describe('RetryBudget', () => {
  it('starts full, at max(10, 100 × ratio) tokens', () => {
    expect(new RetryBudget(0.1).maxTokens).toBe(10);
    expect(new RetryBudget(0.1).available).toBe(10);
    expect(new RetryBudget(0.5).maxTokens).toBe(50);
  });

  it('allows a retry only while a whole token is available, and spends it', () => {
    const b = new RetryBudget(0.1);
    for (let i = 0; i < 10; i++) expect(b.tryWithdraw()).toBe(true);
    expect(b.tryWithdraw()).toBe(false);
    for (let i = 0; i < 9; i++) b.deposit();
    expect(b.tryWithdraw()).toBe(false); // 0.9 tokens
    b.deposit();
    expect(b.tryWithdraw()).toBe(true);
    expect(b.tryWithdraw()).toBe(false);
  });

  it('never holds more than its cap, however long it goes unused', () => {
    const b = new RetryBudget(0.2);
    for (let i = 0; i < 1000; i++) b.deposit();
    expect(b.available).toBe(20);
  });

  it('is created only for policies that ask for one', () => {
    expect(budgetFor(call('x'))).toBeNull();
    expect(budgetFor(null)).toBeNull();
    expect(budgetFor(undefined)).toBeNull();
    expect(budgetFor(call('x', { retryBudget: 0.3 }))!.ratio).toBe(0.3);
  });
});

describe('retry budget in a run', () => {
  /** The client calls a tier that fails every try: dead (refuses at once) or too slow (times out). */
  const alwaysFailing = (how: 'dead' | 'timeout', clientCall: Partial<CallPolicy>): RunConfig => {
    const durationMs = 60_000;
    if (how === 'dead') {
      return {
        ...singleTier(50, { kind: 'fixed', ms: 1 }, durationMs, {}, { retries: 3, ...clientCall }),
        faults: [{ tier: 'svc', kind: 'dead', startMs: 0, endMs: durationMs }],
      };
    }
    return singleTier(50, { kind: 'fixed', ms: 1000 }, durationMs, { workersPerInstance: 1000, coresPerInstance: 1000 }, { retries: 3, timeoutMs: 10, ...clientCall });
  };

  it.each(['dead', 'timeout'] as const)('when every try fails (%s), retries ≈ ratio × first attempts + the initial bucket', (how) => {
    const r = runSimulation(alwaysFailing(how, { retryBudget: 0.1 }));
    const first = firstAttempts(r, 'svc');
    expect(first).toBeGreaterThan(2500);
    // Full bucket of 10 to start, then 0.1 per first attempt; the very first deposit is lost to the
    // cap, and a few requests at the very end may not have asked yet.
    const allowed = 0.1 * first + 10;
    expect(retries(r, 'svc')).toBeLessThanOrEqual(allowed);
    expect(retries(r, 'svc')).toBeGreaterThanOrEqual(allowed - 3);
    expectConservation(r);
  });

  it.each(['dead', 'timeout'] as const)('without a budget, the same config sends every allowed retry (%s)', (how) => {
    const r = runSimulation(alwaysFailing(how, {}));
    const first = firstAttempts(r, 'svc');
    expect(retries(r, 'svc')).toBeLessThanOrEqual(3 * first);
    expect(retries(r, 'svc')).toBeGreaterThanOrEqual(3 * first - 3 * 2); // the last request or two may still be retrying
  });

  it('a refused retry fails the request at once, as if its retries had run out', () => {
    const r = runSimulation(alwaysFailing('dead', { retryBudget: 0.1, backoffBaseMs: 100 }));
    const { status, latencyMs } = r.client.requests;
    // With 100 ms backoff each granted retry adds ≥ 100 ms; most requests get none, so fail in 0 ms.
    const instant = Array.from(latencyMs).filter((l, i) => status[i] === 0 && l === 0).length;
    expect(instant / status.length).toBeGreaterThan(0.85);
  });

  it('changes nothing when nothing fails', () => {
    const healthy = (retryBudget?: number) =>
      runSimulation(singleTier(80, { kind: 'exponential', meanMs: 5 }, 20_000, { workersPerInstance: 4 }, { retries: 3, timeoutMs: 5_000, retryBudget }));
    expect(healthy(0.1)).toEqual(healthy());
  });

  it("one budget is shared by all of a tier's instances (not one per instance)", () => {
    const config: RunConfig = {
      seed: 4,
      durationMs: 60_000,
      client: { rps: 60, call: call('a') },
      tiers: [
        tier('a', { kind: 'fixed', ms: 1 }, { instances: 4, workersPerInstance: 100, downstream: call('b', { retries: 3, retryBudget: 0.1 }) }),
        tier('b', { kind: 'fixed', ms: 1 }),
      ],
      faults: [{ tier: 'b', kind: 'dead', startMs: 0, endMs: 60_000 }],
    };
    const r = runSimulation(config);
    const first = firstAttempts(r, 'b');
    expect(r.tiers.a.retriesSent.reduce((x, y) => x + y, 0)).toBe(retries(r, 'b'));
    // A bucket per instance would allow 4 × 10 initial retries; one shared bucket allows 10.
    expect(retries(r, 'b')).toBeLessThanOrEqual(0.1 * first + 10);
    expect(retries(r, 'b')).toBeGreaterThanOrEqual(0.1 * first + 10 - 3);
  });

  it("a tier's cache lookups and downstream calls have separate budgets", () => {
    const config: RunConfig = {
      seed: 4,
      durationMs: 60_000,
      client: { rps: 60, call: call('api') },
      tiers: [
        tier('api', { kind: 'fixed', ms: 1 }, {
          workersPerInstance: 100,
          cacheAside: call('cache', { retries: 2, retryBudget: 0.1 }),
          downstream: call('db', { retries: 2, retryBudget: 0.2 }),
        }),
        tier('cache', { kind: 'fixed', ms: 0.2 }, { cache: { capacity: 10, ttlMs: null, keys: 100, skew: 1 } }),
        tier('db', { kind: 'fixed', ms: 1 }),
      ],
      faults: [
        { tier: 'cache', kind: 'dead', startMs: 0, endMs: 60_000 },
        { tier: 'db', kind: 'dead', startMs: 0, endMs: 60_000 },
      ],
    };
    const r = runSimulation(config);
    expect(retries(r, 'cache')).toBeLessThanOrEqual(0.1 * firstAttempts(r, 'cache') + 10);
    expect(retries(r, 'cache')).toBeGreaterThanOrEqual(0.1 * firstAttempts(r, 'cache') + 10 - 3);
    expect(retries(r, 'db')).toBeLessThanOrEqual(0.2 * firstAttempts(r, 'db') + 20);
    expect(retries(r, 'db')).toBeGreaterThanOrEqual(0.2 * firstAttempts(r, 'db') + 20 - 3);
  });

  it('is deterministic', () => {
    const config = alwaysFailing('timeout', { retryBudget: 0.25, backoffBaseMs: 20, jitter: true });
    expect(runSimulation(config)).toEqual(runSimulation(config));
  });
});
