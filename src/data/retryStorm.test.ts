/**
 * Known failure patterns on the bundled retry-storm preset. These are the behaviours the product
 * exists to show, so they must emerge from the engine rather than being scripted.
 *
 * The mechanism tests here retry at one layer only (the API retries the DB; nothing else retries),
 * which gives the clearest stuck/recovered contrast. presets.test.ts covers the default retries.
 */
import { runSimulation } from '../engine/run';
import type { RunResult } from '../engine/result';
import { buildRunConfig } from './buildConfig';
import { retryStorm } from './scenarios';
import { webChain } from './topologies';

/** Only the API retries the DB, `n` times. */
const apiOnly = (n: number) => ({ client: 0, gateway: 0, api: n });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
/** Share of requests sent in the last 20 s that succeeded (the failure ended at 35 s). */
const tailSuccess = (r: RunResult) => {
  const n = r.client.sent.length;
  return sum(r.client.ok.slice(n - 20)) / sum(r.client.sent.slice(n - 20));
};

describe('retry storm (bundled preset)', { timeout: 60_000 }, () => {
  const stuck = runSimulation(buildRunConfig(webChain, retryStorm, { retries: apiOnly(3) }));
  const recovered = runSimulation(buildRunConfig(webChain, retryStorm, { retries: apiOnly(0) }));

  it('is healthy before the failure in both runs', () => {
    for (const r of [stuck, recovered]) expect(sum(r.client.ok.slice(5, 30)) / sum(r.client.sent.slice(5, 30))).toBeGreaterThan(0.99);
  });

  it('with 3 API → DB retries, a 5-second DB slowdown leaves the system stuck long after it ends', () => {
    expect(tailSuccess(stuck)).toBeLessThan(0.05);
  });

  it('with no retries, the same slowdown is absorbed and the system recovers', () => {
    expect(tailSuccess(recovered)).toBeGreaterThan(0.99);
  });

  it('both runs saw identical traffic, so retries are the only difference', () => {
    expect(stuck.client.requests.arrivalMs).toEqual(recovered.client.requests.arrivalMs);
  });

  it('while stuck, retries dominate DB load and most DB work is for abandoned requests', () => {
    const db = stuck.tiers.db;
    const late = (xs: number[]) => sum(xs.slice(60, 120));
    expect(late(db.arrivalsRetry) / (late(db.arrivalsRetry) + late(db.arrivalsFirst))).toBeGreaterThan(0.5);
    expect(late(db.wastedMs) / (late(db.busyCoresAvg) * 1000)).toBeGreaterThan(0.9);
  });

  it('while stuck, some tier\'s workers are all occupied but mostly not computing (waiting downstream)', () => {
    const b = 100;
    const saturatedIdle = Object.values(stuck.tiers).filter(
      (t) => t.busyWorkersAvg[b] / t.workers > 0.95 && t.busyCoresAvg[b] / t.cores < 0.5,
    );
    expect(saturatedIdle.length).toBeGreaterThan(0);
  });

  it('each extra API → DB retry lowers the traffic at which the system tips (the staircase)', () => {
    const tips = (retries: number) => runSimulation(buildRunConfig(webChain, retryStorm, { retries: apiOnly(retries), rps: 160 }));
    expect(tailSuccess(tips(1))).toBeGreaterThan(0.99); // 1 retry: still absorbs it at 160 rps
    expect(tailSuccess(tips(2))).toBeLessThan(0.05); // 2 retries: tips at the same traffic
  });
});
