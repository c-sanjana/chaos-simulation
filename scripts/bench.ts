/**
 * Engine throughput benchmark: events processed per second of wall-clock time.
 * Run with: npm run bench
 *
 * The scenario is a 3-tier chain with retries under heavy load, which is the expensive case for
 * tipping-point sweeps (retries multiply the work).
 */
import { runSimulation } from '../src/engine/run';
import type { RunConfig } from '../src/engine/config';
import { call, tier } from '../src/engine/testConfigs';

function chain(rps: number, retries: number): RunConfig {
  return {
    seed: 1,
    durationMs: 120_000,
    client: { rps, call: call('gateway', { timeoutMs: 2000, retries: 1 }) },
    tiers: [
      tier('gateway', { kind: 'lognormal', medianMs: 1, p99Ms: 5 }, { instances: 2, workersPerInstance: 64, coresPerInstance: 4, downstream: call('api', { timeoutMs: 1500, retries }) }),
      tier('api', { kind: 'lognormal', medianMs: 8, p99Ms: 40 }, { instances: 4, workersPerInstance: 16, coresPerInstance: 4, downstream: call('db', { timeoutMs: 1000, retries }) }),
      tier('db', { kind: 'lognormal', medianMs: 5, p99Ms: 25 }, { instances: 1, workersPerInstance: 64, coresPerInstance: 8 }),
    ],
  };
}

for (const [label, config] of [
  ['healthy, 200 rps', chain(200, 3)],
  ['overloaded, 2000 rps, 3 retries', chain(2000, 3)],
] as const) {
  runSimulation(config); // warm up the JIT
  const start = performance.now();
  const r = runSimulation(config);
  const ms = performance.now() - start;
  console.log(`${label}: ${r.eventsProcessed.toLocaleString()} events in ${ms.toFixed(0)} ms = ${((r.eventsProcessed / ms) * 1000 / 1e6).toFixed(2)} M events/s`);
}
