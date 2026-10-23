import type { CallPolicy, RunConfig } from '../engine/config';
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
 * `retries` applies to every call policy (client included) except cache lookups, which are
 * conventionally not retried.
 */
export function buildRunConfig(topology: TopologyPreset, scenario: ScenarioPreset, overrides: ScenarioOverrides = {}): RunConfig {
  const retries = overrides.retries ?? scenario.retries;
  const withRetries = (p: CallPolicy): CallPolicy => ({ ...p, retries });
  return {
    seed: overrides.seed ?? 42,
    durationMs: scenario.durationMs,
    client: { rps: overrides.rps ?? scenario.rps, call: withRetries(topology.clientCall) },
    tiers: topology.tiers.map((t) => ({
      ...t,
      downstream: t.downstream ? withRetries(t.downstream) : null,
    })),
    faults: scenario.faults.map((f) => (overrides.outageMs === undefined ? { ...f } : { ...f, endMs: f.startMs + overrides.outageMs })),
  };
}
