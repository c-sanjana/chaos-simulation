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

/**
 * Input limits. ASSUMPTION: 5,000 req/s for up to 600 s keeps one run to a few seconds in a
 * browser tab; far larger values can run for minutes and exhaust memory.
 */
export const LIMITS = { maxRps: 5000, minDurationS: 30, maxDurationS: 600 } as const;

/** Recovery needs time after the failure to be judged; the run must last this long past its end. */
export const JUDGE_AFTER_FAILURE_S = 20;

/**
 * Problems that involve more than one setting, in plain words (each field checks its own range).
 * Running is blocked while there are any.
 */
export function draftProblems(d: Draft): string[] {
  const problems: string[] = [];
  const s = d.scenario;
  const durationS = s.durationMs / 1000;
  const label = (id: string) => d.topology.layout[id]?.label ?? id;
  for (const f of s.faults) {
    const endS = f.endMs / 1000;
    if (endS > durationS - JUDGE_AFTER_FAILURE_S) {
      problems.push(
        `The failure must end at least ${JUDGE_AFTER_FAILURE_S} s before the run ends, so there is time to see whether the system recovers. It ends at ${endS} s; the run lasts ${durationS} s.`,
      );
    }
  }
  for (const t of d.topology.tiers) {
    if (t.service.kind === 'lognormal' && !(t.service.p99Ms > t.service.medianMs)) {
      problems.push(`${label(t.id)}: the slowest 1% of requests (p99) must take longer than a typical one (median).`);
    }
  }
  return problems;
}

/** The map cell closest to `cell` (the current settings may fall between or beyond the map's values). */
export function nearestCell(s: ScenarioPreset, cell: { x: number; y: number } = currentCell(s)): { x: number; y: number } {
  const near = (values: number[], v: number) => values.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), values[0]);
  return { x: near(s.map.x.values, cell.x), y: near(s.map.y.values, cell.y) };
}

/** Whether the current settings are one of the map's cells. */
export function onMap(s: ScenarioPreset): boolean {
  const c = currentCell(s);
  return s.map.x.values.includes(c.x) && s.map.y.values.includes(c.y);
}
