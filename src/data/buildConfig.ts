import type { RunConfig } from '../engine/config';
import type { ScenarioPreset, TopologyPreset } from './types';

/** Values that override a scenario's defaults, e.g. one cell of a tipping-point map. */
export interface ScenarioOverrides {
  rps?: number;
  retries?: number;
  /** Changes how long every fault in the scenario lasts. */
  outageMs?: number;
  seed?: number;
}

/**
 * Turns a topology + scenario (+ overrides) into a runnable config.
 * `retries` applies to the downstream call of the scenario's `retryCall` tier only; every other
 * call keeps the topology's setting.
 */
export function buildRunConfig(topology: TopologyPreset, scenario: ScenarioPreset, overrides: ScenarioOverrides = {}): RunConfig {
  const retries = overrides.retries ?? scenario.retries;
  return {
    seed: overrides.seed ?? 42,
    durationMs: scenario.durationMs,
    client: { rps: overrides.rps ?? scenario.rps, call: { ...topology.clientCall } },
    tiers: topology.tiers.map((t) => ({
      ...t,
      downstream: t.downstream && t.id === scenario.retryCall ? { ...t.downstream, retries } : t.downstream && { ...t.downstream },
    })),
    faults: scenario.faults.map((f) => (overrides.outageMs === undefined ? { ...f } : { ...f, endMs: f.startMs + overrides.outageMs })),
  };
}
