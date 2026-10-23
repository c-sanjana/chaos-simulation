/**
 * Accuracy: the engine must reproduce analytic results for systems where theory gives an exact
 * answer. Long runs (hundreds of thousands of requests) keep sampling error to a few percent;
 * seeds are fixed, so results are deterministic.
 */
import { runSimulation } from './run';
import { singleTier } from './testConfigs';
import {
  lognormalMoments,
  mg1MeanResponseMs,
  mm1MeanResponseMs,
  mmcMeanResponseMs,
  roundRobinMeanResponseMs,
} from './theory';

const LONG = 5_000_000; // 5,000 s of simulated time
const relErr = (actual: number, expected: number) => Math.abs(actual - expected) / expected;
const meanLatency = (r: ReturnType<typeof runSimulation>) => r.tiers.svc.totals.latencySumMs / r.tiers.svc.totals.latencyCount;

describe('engine vs queueing theory', { timeout: 60_000 }, () => {
  it.each([0.5, 0.8])('M/M/1 at utilisation %s: mean response time, utilisation and Little\'s law', (rho) => {
    const meanMs = 10;
    const rps = (rho / meanMs) * 1000;
    const r = runSimulation(singleTier(rps, { kind: 'exponential', meanMs }, LONG));
    const t = r.tiers.svc.totals;
    const W = meanLatency(r);
    expect(relErr(W, mm1MeanResponseMs(rps / 1000, meanMs))).toBeLessThan(0.04);
    expect(relErr(t.busyWorkersArea / LONG, rho)).toBeLessThan(0.02);
    // Little's law: time-average number in system = throughput × mean time in system.
    const L = (t.queueArea + t.busyWorkersArea) / LONG;
    expect(relErr(L, (t.latencyCount / LONG) * W)).toBeLessThan(0.02);
  });

  it('M/M/1 latency percentiles match the exponential response-time distribution', () => {
    // One bucket spanning the whole run, so p50/p99 are over every request. In M/M/1 the response
    // time is exponential with mean W: median = W·ln 2, p99 = W·ln 100. Histogram bins are ~12% wide,
    // but quantiles interpolate within a bin, so the error is mostly sampling error. At 80% utilisation
    // consecutive latencies are strongly correlated, so tail estimates need a longer run (~1.6M requests).
    const VERY_LONG = 4 * LONG;
    const r = runSimulation({ ...singleTier(80, { kind: 'exponential', meanMs: 10 }, VERY_LONG), bucketMs: VERY_LONG });
    const W = mm1MeanResponseMs(0.08, 10);
    expect(relErr(r.tiers.svc.latencyP50Ms[0], W * Math.LN2)).toBeLessThan(0.05);
    expect(relErr(r.tiers.svc.latencyP99Ms[0], W * Math.log(100))).toBeLessThan(0.05);
  });

  it('M/M/c (Erlang C): 4 workers at 75% utilisation', () => {
    const r = runSimulation(singleTier(100, { kind: 'exponential', meanMs: 30 }, LONG, { workersPerInstance: 4, coresPerInstance: 4 }));
    expect(relErr(meanLatency(r), mmcMeanResponseMs(0.1, 30, 4))).toBeLessThan(0.04);
  });

  it('M/G/1 (Pollaczek–Khinchine) with long-tailed lognormal service', () => {
    const m = lognormalMoments(5, 20);
    const rps = 120;
    const r = runSimulation(singleTier(rps, { kind: 'lognormal', medianMs: 5, p99Ms: 20 }, LONG));
    expect(relErr(meanLatency(r), mg1MeanResponseMs(rps / 1000, m.mean, m.secondMoment))).toBeLessThan(0.05);
  });

  it('M/D/1 (Pollaczek–Khinchine) with fixed service', () => {
    const r = runSimulation(singleTier(120, { kind: 'fixed', ms: 6 }, LONG));
    expect(relErr(meanLatency(r), mg1MeanResponseMs(0.12, 6, 36))).toBeLessThan(0.03);
  });

  it('CPU cores bind before workers: 8 workers on 2 cores behaves as M/M/2, CPU busy = λS/2', () => {
    const r = runSimulation(singleTier(150, { kind: 'exponential', meanMs: 10 }, LONG, { workersPerInstance: 8, coresPerInstance: 2 }));
    expect(relErr(meanLatency(r), mmcMeanResponseMs(0.15, 10, 2))).toBeLessThan(0.04);
    expect(relErr(r.tiers.svc.totals.busyCoresArea / LONG / 2, 0.75)).toBeLessThan(0.02);
    expect(r.tiers.svc.peaks.busyCoresPerInstance).toBe(2);
  });

  it('round-robin across 3 single-worker instances matches the E3/M/1 (GI/M/1) result', () => {
    const r = runSimulation(singleTier(240, { kind: 'exponential', meanMs: 10 }, LONG, { instances: 3 }));
    const W = roundRobinMeanResponseMs(0.24, 3, 10);
    expect(relErr(meanLatency(r), W)).toBeLessThan(0.04);
    // Round-robin smooths arrivals, so it must beat three independent M/M/1 queues at the same load.
    expect(meanLatency(r)).toBeLessThan(mm1MeanResponseMs(0.08, 10));
  });
});
