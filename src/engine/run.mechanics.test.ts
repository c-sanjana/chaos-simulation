/** Mechanisms and invariants: timeouts, retries, backoff, abandoned work, queue limits, determinism. */
import type { RunConfig } from './config';
import { runSimulation } from './run';
import { STATUS_FAILED, STATUS_OK, STATUS_UNFINISHED, type RunResult } from './result';
import { call, singleTier, tier } from './testConfigs';

function expectConservation(r: RunResult) {
  for (const t of Object.values(r.tiers)) {
    const x = t.totals;
    expect(x.arrivals).toBe(x.ok + x.failed + x.rejected + x.dropped + x.inFlightAtEnd);
    expect(x.inFlightAtEnd).toBeGreaterThanOrEqual(0);
  }
  const s = r.client.requests.status;
  const count = (v: number) => s.filter((x) => x === v).length;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  expect(sum(r.client.sent)).toBe(s.length);
  expect(sum(r.client.ok)).toBe(count(STATUS_OK));
  expect(sum(r.client.failed)).toBe(count(STATUS_FAILED));
}

/** Client → A → B → C, with C so slow every call to it times out. */
function amplificationChain(retriesAB: number, retriesBC: number): RunConfig {
  return {
    seed: 3,
    durationMs: 20_000,
    client: { rps: 5, call: call('a') },
    tiers: [
      tier('a', { kind: 'fixed', ms: 1 }, { workersPerInstance: 1000, downstream: call('b', { timeoutMs: 500, retries: retriesAB }) }),
      tier('b', { kind: 'fixed', ms: 1 }, { workersPerInstance: 1000, downstream: call('c', { timeoutMs: 10, retries: retriesBC }) }),
      tier('c', { kind: 'fixed', ms: 5000 }, { workersPerInstance: 100_000 }),
    ],
  };
}

describe('engine mechanics', () => {
  it('conserves attempts at every tier and requests at the client', () => {
    expectConservation(runSimulation(singleTier(150, { kind: 'exponential', meanMs: 10 }, 60_000)));
    expectConservation(runSimulation(amplificationChain(2, 2)));
  });

  it('never exceeds worker or core limits', () => {
    const r = runSimulation(singleTier(400, { kind: 'exponential', meanMs: 10 }, 30_000, { instances: 2, workersPerInstance: 3, coresPerInstance: 2 }));
    expect(r.tiers.svc.peaks.busyWorkersPerInstance).toBe(3);
    expect(r.tiers.svc.peaks.busyCoresPerInstance).toBe(2);
    expect(Math.max(...r.tiers.svc.busyWorkersAvg)).toBeLessThanOrEqual(6);
  });

  it('is deterministic: the same config gives an identical result', () => {
    const config = amplificationChain(1, 2);
    expect(runSimulation(config)).toEqual(runSimulation(config));
  });

  it('sends identical traffic whatever the downstream settings (same seed)', () => {
    const a = runSimulation(singleTier(100, { kind: 'exponential', meanMs: 5 }, 20_000));
    const b = runSimulation(singleTier(100, { kind: 'fixed', ms: 50 }, 20_000, { workersPerInstance: 3 }, { timeoutMs: 20, retries: 3 }));
    expect(b.client.requests.arrivalMs).toEqual(a.client.requests.arrivalMs);
  });

  it('a healthy system with retries enabled sends no retries (multiplier exactly 1)', () => {
    const r = runSimulation(singleTier(50, { kind: 'exponential', meanMs: 5 }, 30_000, {}, { timeoutMs: 10_000, retries: 3 }));
    expect(r.tiers.svc.totals.arrivals).toBe(r.client.sent.reduce((a, b) => a + b, 0));
    expect(r.tiers.svc.arrivalsRetry.every((x) => x === 0)).toBe(true);
  });

  it.each([
    [0, 0, 1],
    [2, 0, 3],
    [0, 2, 3],
    [2, 2, 9],
    [1, 3, 8],
  ])('retries multiply: %i retries A→B and %i retries B→C give %i calls to C per request', (ab, bc, expected) => {
    const r = runSimulation(amplificationChain(ab, bc));
    const finished = Array.from(r.client.requests.status).filter((s) => s !== STATUS_UNFINISHED).length;
    const sent = r.client.requests.status.length;
    const cCalls = r.tiers.c.totals.arrivals;
    expect(cCalls).toBeGreaterThanOrEqual(expected * finished);
    expect(cCalls).toBeLessThanOrEqual(expected * sent);
    expect(r.tiers.c.arrivalsRetry.reduce((a, b) => a + b, 0)).toBe(cCalls - r.tiers.c.arrivalsFirst.reduce((a, b) => a + b, 0));
    expectConservation(r);
  });

  it('times out, backs off exponentially, and reports the exact failure latency', () => {
    // Every try takes 1 s but the client gives up after 10 ms: 10 + 100 + 10 + 200 + 10 = 330 ms.
    const r = runSimulation(singleTier(2, { kind: 'fixed', ms: 1000 }, 30_000, { workersPerInstance: 100 }, { timeoutMs: 10, retries: 2, backoffBaseMs: 100 }));
    const { status, latencyMs } = r.client.requests;
    status.forEach((s, i) => {
      if (s === STATUS_FAILED) expect(latencyMs[i]).toBeCloseTo(330, 9);
    });
    expect(Array.from(status).filter((s) => s === STATUS_OK)).toHaveLength(0);
    expect(r.tiers.svc.totals.arrivals).toBeGreaterThan(0);
  });

  it('full jitter keeps each retry delay within [0, base × 2^(n−1)]', () => {
    const r = runSimulation(singleTier(2, { kind: 'fixed', ms: 1000 }, 30_000, { workersPerInstance: 100 }, { timeoutMs: 10, retries: 2, backoffBaseMs: 100, jitter: true }));
    const { status, latencyMs } = r.client.requests;
    const failedLatencies = Array.from(latencyMs).filter((_, i) => status[i] === STATUS_FAILED);
    expect(failedLatencies.length).toBeGreaterThan(20);
    for (const l of failedLatencies) {
      expect(l).toBeGreaterThanOrEqual(30);
      expect(l).toBeLessThanOrEqual(330);
    }
    expect(new Set(failedLatencies.map((l) => l.toFixed(6))).size).toBeGreaterThan(20);
  });

  it('keeps working on abandoned attempts and counts that work as wasted', () => {
    const r = runSimulation(singleTier(2, { kind: 'fixed', ms: 100 }, 60_000, { workersPerInstance: 100 }, { timeoutMs: 50 }));
    const t = r.tiers.svc;
    expect(t.totals.ok).toBeGreaterThan(50); // the tier finished the work…
    expect(r.client.ok.reduce((a, b) => a + b, 0)).toBe(0); // …but nobody was waiting for it
    expect(t.totals.wastedMs).toBeCloseTo(100 * t.totals.ok, 6);
    expect(t.timeouts.every((x) => x === 0)).toBe(true); // timeouts are counted by the caller, not the callee
  });

  it('dropping expired requests turns an overload that serves nobody into one that serves many', () => {
    const base = (dropExpired: boolean) =>
      runSimulation(singleTier(20, { kind: 'fixed', ms: 100 }, 60_000, { dropExpired }, { timeoutMs: 150 }));
    const keep = base(false);
    const drop = base(true);
    const okCount = (r: RunResult) => r.client.ok.reduce((a, b) => a + b, 0);
    expect(drop.tiers.svc.totals.dropped).toBeGreaterThan(0);
    expect(keep.tiers.svc.totals.dropped).toBe(0);
    expect(okCount(drop)).toBeGreaterThan(5 * Math.max(1, okCount(keep)));
    expect(drop.tiers.svc.totals.wastedMs).toBeLessThan(keep.tiers.svc.totals.wastedMs);
    expectConservation(drop);
  });

  describe('dropping requests that expired while waiting for a core (more workers than cores)', () => {
    // 1000 workers on 1 core, so nothing ever queues for a worker: every wait is for the core. A 2 s
    // slowdown backs requests up behind the core, and many outlive their caller's 100 ms timeout.
    const run = (dropExpired: boolean) => {
      const config = singleTier(50, { kind: 'fixed', ms: 10 }, 30_000, { workersPerInstance: 1000, coresPerInstance: 1, dropExpired }, { timeoutMs: 100 });
      return runSimulation({ ...config, faults: [{ tier: 'svc', kind: 'slow', factor: 10, startMs: 5_000, endMs: 7_000 }] });
    };
    const keep = run(false);
    const drop = run(true);
    const okCount = (r: RunResult) => r.client.ok.reduce((a, b) => a + b, 0);

    it('without it, expired requests are still computed, and that work is wasted', () => {
      const t = keep.tiers.svc.totals;
      expect(t.dropped).toBe(0);
      expect(t.ok).toBe(t.arrivals); // every attempt was computed in the end…
      expect(t.wastedMs).toBeGreaterThan(0); // …including ones nobody was waiting for any more
      expectConservation(keep);
    });

    it('with it, they are dropped when they get the core, without computing', () => {
      const t = drop.tiers.svc;
      expect(t.totals.dropped).toBeGreaterThan(0);
      expect(t.peaks.queuePerInstance).toBe(0); // so every drop happened at the core, not the queue
      expect(t.totals.ok + t.totals.dropped).toBe(t.totals.arrivals);
      // Each dropped attempt did no work: the CPU time saved is exactly their 10 ms each, and the
      // core was held only while computing.
      expect(t.totals.computeMs).toBeCloseTo(keep.tiers.svc.totals.computeMs - 10 * t.totals.dropped, 6);
      expect(t.totals.busyCoresArea).toBeCloseTo(t.totals.computeMs, 6);
      expect(t.totals.wastedMs).toBeLessThan(keep.tiers.svc.totals.wastedMs);
      expect(okCount(drop)).toBeGreaterThan(okCount(keep));
      expectConservation(drop);
    });

    it('keeps worker and core accounting consistent when attempts are dropped at both checks', () => {
      // 4 workers on 1 core at 2× overload: attempts expire both in the queue and waiting for the core.
      const r = runSimulation(singleTier(200, { kind: 'fixed', ms: 10 }, 30_000, { workersPerInstance: 4, coresPerInstance: 1, dropExpired: true }, { timeoutMs: 50 }));
      const t = r.tiers.svc;
      expect(t.totals.dropped).toBeGreaterThan(0);
      expect(t.peaks.busyWorkersPerInstance).toBe(4);
      expect(t.peaks.busyCoresPerInstance).toBe(1);
      expect(Math.max(...t.busyCoresAvg)).toBeLessThanOrEqual(1 + 1e-9);
      expect(t.totals.busyCoresArea).toBeLessThanOrEqual(t.totals.computeMs + 1e-6);
      // Fixed 10 ms service: the computes started are the successes plus at most one still running.
      const computes = t.totals.computeMs / 10;
      expect(computes).toBeGreaterThanOrEqual(t.totals.ok);
      expect(computes).toBeLessThanOrEqual(t.totals.ok + 1);
      expectConservation(r);
    });

    it('hands the core on without recursion when thousands of waiters have expired in a row', () => {
      // ~40,000 attempts wait behind one 2 s compute with a 10 ms timeout, then are all skipped at once.
      const r = runSimulation(singleTier(20_000, { kind: 'fixed', ms: 2000 }, 3_000, { workersPerInstance: 100_000, coresPerInstance: 1, dropExpired: true }, { timeoutMs: 10 }));
      expect(r.tiers.svc.totals.dropped).toBeGreaterThan(30_000);
      expectConservation(r);
    });
  });

  it('rejects immediately when the queue is full', () => {
    const r = runSimulation(singleTier(200, { kind: 'fixed', ms: 10 }, 20_000, { queueLimit: 0 }));
    const t = r.tiers.svc.totals;
    expect(t.rejected).toBeGreaterThan(0);
    expect(r.tiers.svc.peaks.queuePerInstance).toBe(0);
    expectConservation(r);
  });

  it('client retries arrive at the entry tier marked as retries', () => {
    const r = runSimulation(singleTier(50, { kind: 'fixed', ms: 10 }, 20_000, { queueLimit: 0 }, { retries: 1, backoffBaseMs: 5 }));
    expect(r.tiers.svc.arrivalsRetry.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('reports per-bucket series of the right length, with NaN latency when nothing succeeded', () => {
    const r = runSimulation({ ...singleTier(1, { kind: 'fixed', ms: 1 }, 2_500), bucketMs: 1000 });
    expect(r.bucketMs).toBe(1000);
    expect(r.tiers.svc.ok).toHaveLength(3);
    expect(r.client.sent).toHaveLength(3);
    const quiet = runSimulation(singleTier(0.001, { kind: 'fixed', ms: 1 }, 1_000));
    expect(Number.isNaN(quiet.tiers.svc.latencyMeanMs[0])).toBe(true);
  });
});
