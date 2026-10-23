import type { Fault, TierConfig } from '../engine/config';
import { scenarios } from '../data/scenarios';
import { topologies } from '../data/topologies';
import type { ScenarioPreset, TopologyPreset } from '../data/types';

/** What the viewer can edit: a topology and a scenario, starting from the presets. Plain data. */
export interface Draft {
  topology: TopologyPreset;
  scenario: ScenarioPreset;
}

export function presetDraft(scenarioId: string): Draft {
  const scenario = scenarios[scenarioId];
  return { scenario: structuredClone(scenario), topology: structuredClone(topologies[scenario.topology]) };
}

export function updateTier(d: Draft, id: string, change: (t: TierConfig) => TierConfig): Draft {
  return { ...d, topology: { ...d.topology, tiers: d.topology.tiers.map((t) => (t.id === id ? change(t) : t)) } };
}

export function updateScenario(d: Draft, change: Partial<ScenarioPreset>): Draft {
  return { ...d, scenario: { ...d.scenario, ...change } };
}

/** Edits the scenario's first fault (presets have exactly one). */
export function updateFault(d: Draft, change: Partial<Fault>): Draft {
  const [first, ...rest] = d.scenario.faults;
  return updateScenario(d, { faults: [{ ...first, ...change }, ...rest] });
}

/** The map cell matching the current settings. */
export function currentCell(s: ScenarioPreset): { x: number; y: number } {
  const f = s.faults[0];
  const y = s.map.y.param === 'retries' ? s.retries : s.map.y.param === 'outageMs' ? f.endMs - f.startMs : s.rps;
  return { x: s.rps, y };
}
