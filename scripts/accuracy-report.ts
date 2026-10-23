/** Prints simulated vs analytic results for the README's accuracy table. Run: npx vite-node scripts/accuracy-report.ts */
import { runSimulation } from '../src/engine/run';
import { singleTier } from '../src/engine/testConfigs';
import { lognormalMoments, mg1MeanResponseMs, mm1MeanResponseMs, mmcMeanResponseMs, roundRobinMeanResponseMs } from '../src/engine/theory';
import type { RunConfig } from '../src/engine/config';

const LONG = 5_000_000;
const W = (c: RunConfig) => {
  const t = runSimulation(c).tiers.svc.totals;
  return t.latencySumMs / t.latencyCount;
};
const m = lognormalMoments(5, 20);
const rows: Array<[string, number, number]> = [
  ['M/M/1, 50% utilisation', W(singleTier(50, { kind: 'exponential', meanMs: 10 }, LONG)), mm1MeanResponseMs(0.05, 10)],
  ['M/M/1, 80% utilisation', W(singleTier(80, { kind: 'exponential', meanMs: 10 }, LONG)), mm1MeanResponseMs(0.08, 10)],
  ['M/M/4 (Erlang C), 75%', W(singleTier(100, { kind: 'exponential', meanMs: 30 }, LONG, { workersPerInstance: 4, coresPerInstance: 4 })), mmcMeanResponseMs(0.1, 30, 4)],
  ['M/G/1 lognormal (P-K), 72%', W(singleTier(120, { kind: 'lognormal', medianMs: 5, p99Ms: 20 }, LONG)), mg1MeanResponseMs(0.12, m.mean, m.secondMoment)],
  ['M/D/1 (P-K), 72%', W(singleTier(120, { kind: 'fixed', ms: 6 }, LONG)), mg1MeanResponseMs(0.12, 6, 36)],
  ['8 workers on 2 cores = M/M/2, 75%', W(singleTier(150, { kind: 'exponential', meanMs: 10 }, LONG, { workersPerInstance: 8, coresPerInstance: 2 })), mmcMeanResponseMs(0.15, 10, 2)],
  ['Round-robin over 3 queues (E3/M/1), 80%', W(singleTier(240, { kind: 'exponential', meanMs: 10 }, LONG, { instances: 3 })), roundRobinMeanResponseMs(0.24, 3, 10)],
];
for (const [name, sim, theory] of rows) console.log(`| ${name} | ${theory.toFixed(2)} ms | ${sim.toFixed(2)} ms | ${(((sim - theory) / theory) * 100).toFixed(1)}% |`);
