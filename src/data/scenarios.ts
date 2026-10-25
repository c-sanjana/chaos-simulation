import type { Axis, ScenarioPreset } from './types';

const TRAFFIC: Axis = { param: 'rps', label: 'traffic (requests/s)', values: [60, 80, 100, 120, 140, 160, 180, 200, 220, 240] };

/** The map's second axis: how long the failure lasts (s), longest at the top. */
const failureLength = (seconds: number[]): Axis => ({ param: 'outageMs', label: 'failure length', values: seconds.map((s) => s * 1000) });

/*
 * Map axes: traffic × failure length (user decision, 2026-10-24). With retries at several layers,
 * varying one call's retries no longer moves the tipping point (every mix tips at the same traffic),
 * while failure length gives a clear staircase for a failure in any component. Lengths were chosen
 * from measured maps with the default retries (5 / 3 / 1); see PLAN.md.
 */

/** A short DB slowdown; retries at every layer pile up and can keep the system down afterwards. */
export const retryStorm: ScenarioPreset = {
  id: 'retry-storm',
  title: 'Retry storm',
  blurb: 'A short DB slowdown; every layer retries, and the retries pile up.',
  topology: 'web-chain',
  rps: 200,
  durationMs: 120_000,
  faults: [{ tier: 'db', kind: 'slow', factor: 8, startMs: 30_000, endMs: 35_000 }],
  // Measured: up to 2 s it always recovers; 3 s tips at 160 req/s, 5 s at 100, 8 s at 80.
  map: { x: TRAFFIC, y: failureLength([12, 8, 5, 3, 2, 1]) },
};

/** The cache goes down and comes back empty: every lookup misses at once and stampedes the DB. */
export const cacheRestart: ScenarioPreset = {
  id: 'cache-restart',
  title: 'Cache restarts empty',
  blurb: 'The cache goes down for a few seconds and comes back empty; every request falls through to the DB.',
  topology: 'web-chain',
  rps: 200,
  durationMs: 120_000,
  faults: [{ tier: 'cache', kind: 'dead', startMs: 30_000, endMs: 35_000, flushAtEnd: true }],
  // Measured: 1 s recovers everywhere; 3 s tips at 220 req/s, 5 s at 200, 10 s at 180.
  map: { x: TRAFFIC, y: failureLength([20, 10, 5, 3, 1]) },
};

/**
 * The front door slows down. ASSUMPTION: 50× (1 ms → 50 ms per request, e.g. CPU throttling or long
 * GC pauses); the load balancer has so much spare capacity that a smaller slowdown is barely noticed.
 */
export const gatewaySlow: ScenarioPreset = {
  id: 'gateway-slow',
  title: 'Load balancer slows down',
  blurb: "The load balancer slows down; users' clients retry, and the repeats pile onto it.",
  topology: 'web-chain',
  rps: 200,
  durationMs: 120_000,
  faults: [{ tier: 'gateway', kind: 'slow', factor: 50, startMs: 30_000, endMs: 50_000 }],
  // Measured: up to 5 s it always recovers; 10 s tips at 220 req/s, 20 s at 180.
  map: { x: TRAFFIC, y: failureLength([30, 20, 10, 5, 2]) },
};

export const scenarios: Record<string, ScenarioPreset> = {
  [retryStorm.id]: retryStorm,
  [cacheRestart.id]: cacheRestart,
  [gatewaySlow.id]: gatewaySlow,
};
