import type { RunConfig } from '../engine/config';
import type { ScenarioPreset, TopologyPreset } from './types';

/** Values that override a scenario's defaults, e.g. one cell of a tipping-point map. */
export interface ScenarioOverrides {
  rps?: number;
  /**
   * Retries on some callers' outgoing calls, by caller ('client' or a tier id); others keep the
   * topology's. A tier with several downstream calls (branching) gets the count on every one of
   * them; its cache lookups keep their own.
   */
  retries?: Record<string, number>;
  /** Changes how long every fault in the scenario lasts. */
  outageMs?: number;
  seed?: number;
}

/**
 * Turns a topology + scenario (+ overrides) into a runnable config. Every call keeps the
 * topology's own retry count unless `overrides.retries` names its caller; then all of that
 * caller's downstream calls (`downstream` and each of `moreDownstream`) take the override.
 * ASSUMPTION: a per-layer retry setting means the layer's retry habit, so it applies to every
 * call the layer makes (cache lookups excepted, as before).
 */
export function buildRunConfig(topology: TopologyPreset, scenario: ScenarioPreset, overrides: ScenarioOverrides = {}): RunConfig {
  const retriesOf = (caller: string, own: number) => overrides.retries?.[caller] ?? own;
  return {
    seed: overrides.seed ?? 42,
    durationMs: scenario.durationMs,
    client: { rps: overrides.rps ?? scenario.rps, call: { ...topology.clientCall, retries: retriesOf('client', topology.clientCall.retries) } },
    tiers: topology.tiers.map((t) => ({
      ...t,
      downstream: t.downstream && { ...t.downstream, retries: retriesOf(t.id, t.downstream.retries) },
      ...(t.moreDownstream ? { moreDownstream: t.moreDownstream.map((c) => ({ ...c, retries: retriesOf(t.id, c.retries) })) } : {}),
    })),
    faults: scenario.faults.map((f) => (overrides.outageMs === undefined ? { ...f } : { ...f, endMs: f.startMs + overrides.outageMs })),
  };
}
