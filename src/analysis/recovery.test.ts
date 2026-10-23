import { call, singleTier, tier } from '../engine/testConfigs';
import type { RunConfig } from '../engine/config';
import { controlConfig, maxRequestMs } from './recovery';
import { analyzed, retryStormRun } from './testRuns';

describe('assessRecovery', { timeout: 60_000 }, () => {
  it('a retry storm with 3 retries per layer is stuck', () => {
    const { analysis } = retryStormRun({ retries: 3 });
    expect(analysis.recovery.verdict).toBe('stuck');
    expect(analysis.recovery.recoveredAtMs).toBeNull();
    expect(analysis.recovery.failedRequests).toBeGreaterThan(10_000);
  });

  it('the same failure with no retries recovers within seconds of the failure ending', () => {
    const { analysis, run, control } = retryStormRun({ retries: 0 });
    const r = analysis.recovery;
    expect(r.verdict).toBe('recovered');
    expect(r.recoveredAtMs).toBeGreaterThanOrEqual(r.lastFaultEndMs);
    expect(r.recoveryMs).toBe(r.recoveredAtMs! - r.lastFaultEndMs);
    expect(r.recoveryMs!).toBeLessThan(10_000);
    // After recovery, every request succeeds exactly when it did without the failure.
    const { status, arrivalMs } = run.client.requests;
    for (let i = 0; i < status.length; i++) {
      if (arrivalMs[i] >= r.recoveredAtMs! && arrivalMs[i] < r.judgedUntilMs) expect(status[i]).toBe(control.client.requests.status[i]);
    }
  });

  it('a failure too small to matter leaves the run unaffected', () => {
    const config: RunConfig = {
      ...singleTier(20, { kind: 'fixed', ms: 5 }, 60_000, { workersPerInstance: 20 }, { timeoutMs: 1000 }),
      faults: [{ tier: 'svc', kind: 'slow', factor: 1.01, startMs: 20_000, endMs: 21_000 }],
    };
    expect(analyzed(config).analysis.recovery.verdict).toBe('unaffected');
  });

  it('a system failing requests even without the failure is overloaded, not recovered', () => {
    const config: RunConfig = {
      ...singleTier(500, { kind: 'fixed', ms: 10 }, 30_000, {}, { timeoutMs: 100 }),
      faults: [{ tier: 'svc', kind: 'slow', factor: 2, startMs: 10_000, endMs: 12_000 }],
    };
    expect(analyzed(config).analysis.recovery.verdict).toBe('overloaded');
  });

  it('a run without faults is identical to its control, so unaffected', () => {
    const config = singleTier(50, { kind: 'exponential', meanMs: 5 }, 20_000, { workersPerInstance: 4 }, { timeoutMs: 500 });
    const r = analyzed(config).analysis.recovery;
    expect(r.verdict).toBe('unaffected');
    expect(r.failedRequests).toBe(0);
    expect(r.lastFaultEndMs).toBe(0);
  });

  it('judges everything when the client waits forever', () => {
    const config: RunConfig = {
      seed: 1,
      durationMs: 20_000,
      client: { rps: 10, call: call('svc') },
      tiers: [tier('svc', { kind: 'fixed', ms: 5 }, { workersPerInstance: 4 })],
      faults: [{ tier: 'svc', kind: 'dead', startMs: 5_000, endMs: 6_000 }],
    };
    const r = analyzed(config).analysis.recovery;
    expect(r.judgedUntilMs).toBe(20_000);
    expect(r.verdict).toBe('recovered');
  });
});

describe('maxRequestMs and controlConfig', () => {
  it('adds every try and every backoff', () => {
    const c = singleTier(1, { kind: 'fixed', ms: 1 }, 1000, {}, { timeoutMs: 1000, retries: 2, backoffBaseMs: 100 });
    expect(maxRequestMs(c)).toBe(3 * 1000 + 100 + 200);
    expect(maxRequestMs(singleTier(1, { kind: 'fixed', ms: 1 }, 1000))).toBe(0);
  });

  it('removes faults without touching the original', () => {
    const c: RunConfig = { ...singleTier(1, { kind: 'fixed', ms: 1 }, 1000), faults: [{ tier: 'svc', kind: 'dead', startMs: 1, endMs: 2 }] };
    expect(controlConfig(c).faults).toEqual([]);
    expect(c.faults).toHaveLength(1);
  });
});
