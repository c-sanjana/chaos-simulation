import { buildRunConfig } from '../data/buildConfig';
import { cacheRestart, retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import { call, singleTier, tier } from '../engine/testConfigs';
import type { Fault, RunConfig } from '../engine/config';
import { binCenterMs, latencyBin } from '../engine/stats';
import { runSimulation } from '../engine/run';
import { assessRecovery, controlConfig, maxRequestMs } from './recovery';
import { analyzed, retryStormRun } from './testRuns';

describe('assessRecovery', { timeout: 60_000 }, () => {
  it('a retry storm with 3 API → DB retries is stuck', () => {
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

  it('compares p99 with the control at the latency histogram\'s resolution', () => {
    const { config, run, control, analysis } = retryStormRun({ retries: 0 });
    const ceilingBin = latencyBin(Math.max(...control.client.latencyP99Ms.filter((p) => !Number.isNaN(p))));
    const withP99 = (ms: number) => {
      const tweaked = structuredClone(run);
      tweaked.client.latencyP99Ms[80] = ms;
      return assessRecovery(tweaked, control, config);
    };
    // Higher than the control's highest, but in the same bin: as healthy as before.
    expect(withP99(binCenterMs(ceilingBin + 0.49))).toEqual(analysis.recovery);
    // A bin higher: that second is not healthy, so recovery comes after it.
    expect(withP99(binCenterMs(ceilingBin + 1))).toMatchObject({ verdict: 'recovered', recoveredAtMs: 81_000 });
  });

  it('a 1 s cache outage at 160 req/s recovers within seconds (a p99 a hair above the control\'s once read as 62 s)', () => {
    const { analysis } = analyzed(buildRunConfig(webChain, cacheRestart, { rps: 160, outageMs: 1000 }));
    expect(analysis.recovery).toMatchObject({ verdict: 'recovered', failedRequests: 0 });
    expect(analysis.recovery.recoveryMs!).toBeLessThanOrEqual(2000);
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

describe('assessRecovery with a message queue', () => {
  /**
   * Users → queue → worker service. 30 messages/s against 4 consumers × 100 ms = 40/s. The service
   * slows 4× from 10 s to 30 s, so ~400 messages pile up, then drain at 40 − 30 = 10/s: ~40 s.
   * Users are answered as soon as their message is stored, so they never notice.
   */
  const queued = (durationMs: number): RunConfig => ({
    seed: 4,
    durationMs,
    client: { rps: 30, call: call('q') },
    tiers: [
      tier('q', { kind: 'fixed', ms: 1 }, { workersPerInstance: 20, queue: { maxDepth: 100_000, consumers: 4 }, downstream: call('svc') }),
      tier('svc', { kind: 'fixed', ms: 100 }, { workersPerInstance: 50 }),
    ],
    faults: [{ tier: 'svc', kind: 'slow', factor: 4, startMs: 10_000, endMs: 30_000 }],
  });
  const assess = (config: RunConfig) => {
    const run = runSimulation(config);
    const control = runSimulation(controlConfig(config));
    return { run, control, recovery: assessRecovery(run, control, config) };
  };

  it('a backlog that has not drained by the end is stuck, even though every user succeeded', () => {
    const { run, control, recovery } = assess(queued(60_000));
    // Users saw exactly what they saw without the failure…
    expect(run.client.requests).toEqual(control.client.requests);
    expect(recovery.failedRequests).toBe(0);
    // …but the work behind the queue was still piling up or draining when the run ended.
    expect(run.tiers.q.backlogAvg[59]).toBeGreaterThan(50);
    expect(recovery).toMatchObject({ verdict: 'stuck', recoveredAtMs: null });
  });

  it('recovers once the backlog has drained', () => {
    const { run, control, recovery } = assess(queued(120_000));
    expect(recovery.verdict).toBe('recovered');
    const ceiling = Math.max(...control.tiers.q.backlogAvg);
    const s = recovery.recoveredAtMs! / 1000;
    expect(run.tiers.q.backlogAvg[s - 1]).toBeGreaterThan(ceiling);
    expect(run.tiers.q.backlogAvg.slice(s).every((b) => b <= ceiling)).toBe(true);
    // ~400 messages draining at 10/s: about 40 s after the slowdown ends.
    expect(recovery.recoveryMs!).toBeGreaterThan(30_000);
    expect(recovery.recoveryMs!).toBeLessThan(50_000);
  });
});

describe('assessRecovery judges only what happened inside the run', { timeout: 60_000 }, () => {
  /**
   * The retry storm (DB 8× slower) retrying at one layer (3 API → DB retries), with a different
   * length and failure. Users' apps don't retry, so their longest request (3 s) fits these short runs.
   */
  const storm = (durationMs: number, fault: Partial<Fault>): RunConfig => {
    const config = buildRunConfig(webChain, retryStorm, { retries: { client: 0, gateway: 0, api: 3 } });
    return { ...config, durationMs, faults: [{ ...config.faults![0], ...fault }] };
  };

  it('a failure starting after the run ends leaves the run unaffected', () => {
    const { analysis } = analyzed(storm(30_000, { startMs: 40_000, endMs: 45_000 }));
    expect(analysis.recovery).toMatchObject({ verdict: 'unaffected', recoveredAtMs: null, recoveryMs: null, failedRequests: 0, judgedUntilMs: 30_000, lastFaultEndMs: 45_000 });
    // Nothing on the timeline after the run, and no failure that never happened.
    expect(analysis.timeline).toEqual([{ tMs: 30_000, text: 'Stayed within the normal range throughout', kind: 'good' }]);
  });

  it('a 30 s run with the failure at 30–35 s is unaffected: the failure starts as the run ends', () => {
    const { analysis } = analyzed(storm(30_000, { startMs: 30_000, endMs: 35_000 }));
    expect(analysis.recovery).toMatchObject({ verdict: 'unaffected', failedRequests: 0, judgedUntilMs: 30_000 });
    expect(analysis.timeline.every((e) => e.tMs <= 30_000)).toBe(true);
    expect(analysis.timeline.map((e) => e.text)).not.toContain('DB slows 8× (injected failure)');
  });

  it('a failure ending at the very end is judged up to the end, and its control is not overloaded', () => {
    // Requests arriving in the last 3 s may still be running when the run ends, in the control too:
    // they must not count as the control failing.
    const { analysis } = analyzed(storm(40_000, { startMs: 30_000, endMs: 40_000 }));
    const r = analysis.recovery;
    expect(r).toMatchObject({ verdict: 'stuck', judgedUntilMs: 40_000, lastFaultEndMs: 40_000, recoveredAtMs: null });
    expect(r.failedRequests).toBeGreaterThan(0);
    expect(analysis.timeline.at(-1)).toEqual({ tMs: 40_000, text: 'The failure was still going on when the run ended, so there was no time to recover', kind: 'bad' });
    expect(analysis.timeline.some((e) => e.text.startsWith('Failure ends'))).toBe(false);
  });

  it('a failure lasting past the end is judged only up to the end', () => {
    const { analysis } = analyzed(storm(40_000, { startMs: 30_000, endMs: 50_000 }));
    expect(analysis.recovery).toMatchObject({ verdict: 'stuck', judgedUntilMs: 40_000, lastFaultEndMs: 50_000 });
    expect(analysis.timeline.every((e) => e.tMs <= 40_000 && (e.endMs ?? 0) <= 40_000)).toBe(true);
  });

  it('a harmless failure ending at the very end leaves the run unaffected, not overloaded', () => {
    const config: RunConfig = {
      ...singleTier(100, { kind: 'fixed', ms: 50 }, 30_000, { workersPerInstance: 20 }, { timeoutMs: 1000 }),
      faults: [{ tier: 'svc', kind: 'slow', factor: 1.01, startMs: 25_000, endMs: 30_000 }],
    };
    const { analysis, control } = analyzed(config);
    expect(control.client.requests.status).toContain(2); // a request cut off by the end of the control run
    expect(analysis.recovery).toMatchObject({ verdict: 'unaffected', judgedUntilMs: 30_000, failedRequests: 0 });
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
