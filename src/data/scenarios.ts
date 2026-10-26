import type { Fault } from '../engine/config';
import { failureAxis, failureTitle } from './failure';
import { webChain } from './topologies';
import type { Axis, ScenarioPreset } from './types';

const TRAFFIC: Axis = { param: 'rps', label: 'traffic (requests/s)', values: [60, 80, 100, 120, 140, 160, 180, 200, 220, 240] };

/*
 * Map axes: traffic × failure length (user decision, 2026-10-24). With retries at several layers,
 * varying one call's retries no longer moves the tipping point (every mix tips at the same traffic),
 * while failure length gives a clear staircase for a failure in any component. Lengths were chosen
 * from measured maps with the default retries (5 / 3 / 1); see PLAN.md.
 */

/**
 * A scenario on the example system, named after its failure and mapped over that failure's
 * lengths, as every scenario is (src/data/failure.ts failureTitle and failureAxis).
 */
function onWebChain(id: string, faults: Fault[]): ScenarioPreset {
  return { id, title: failureTitle(webChain, faults), topology: webChain.id, rps: 200, durationMs: 120_000, faults, map: { x: TRAFFIC, y: failureAxis(webChain, faults) } };
}

/**
 * A short DB slowdown ("DB slows down"); retries at every layer pile up and can keep the system
 * down afterwards.
 * Measured: up to 2 s it always recovers; 3 s tips at 160 req/s, 5 s at 100, 8 s at 80.
 */
export const retryStorm: ScenarioPreset = onWebChain('retry-storm', [{ tier: 'db', kind: 'slow', factor: 8, startMs: 30_000, endMs: 35_000 }]);

/**
 * The cache goes down and comes back empty ("Cache restarts empty"): every lookup misses at once
 * and stampedes the DB.
 * Measured: 1 s recovers everywhere; 3 s tips at 220 req/s, 5 s at 200, 10 s at 180.
 */
export const cacheRestart: ScenarioPreset = onWebChain('cache-restart', [{ tier: 'cache', kind: 'dead', startMs: 30_000, endMs: 35_000, flushAtEnd: true }]);

/**
 * The front door slows down ("Load balancer slows down"). ASSUMPTION: 50× (1 ms → 50 ms per
 * request, e.g. CPU throttling or long GC pauses); the load balancer has so much spare capacity
 * that a smaller slowdown is barely noticed.
 * Measured: up to 5 s it always recovers; 10 s tips at 220 req/s, 20 s at 180.
 */
export const loadBalancerSlow: ScenarioPreset = onWebChain('load-balancer-slow', [{ tier: 'lb', kind: 'slow', factor: 50, startMs: 30_000, endMs: 50_000 }]);

export const scenarios: Record<string, ScenarioPreset> = {
  [retryStorm.id]: retryStorm,
  [cacheRestart.id]: cacheRestart,
  [loadBalancerSlow.id]: loadBalancerSlow,
};
