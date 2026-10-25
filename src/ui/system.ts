import { compileGraph, CUSTOM_TOPOLOGY_ID } from '../builder/compile';
import { graphFromPreset, syncGraph } from '../builder/fromPreset';
import type { BuilderGraph } from '../builder/graph';
import { builtScenarios, builtTrafficAxis, findScenario } from '../builder/scenarios';
import { scenarios as presetScenarios } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { ScenarioPreset, TopologyPreset } from '../data/types';
import { faultKindOf, type Draft } from './draft';

/** The system being simulated: the example preset, or one built on the canvas (compiled, with its scenarios). */
export type System = { kind: 'preset' } | { kind: 'custom'; graph: BuilderGraph; topology: TopologyPreset; scenarios: ScenarioPreset[] };

export const PRESET_SYSTEM: System = { kind: 'preset' };

/** A built system: compiled, with the scenarios that apply to it. Call only on a graph without problems. */
export function customSystem(graph: BuilderGraph): System {
  const topology = compileGraph(graph);
  const kinds = Object.fromEntries(graph.nodes.map((n) => [n.id, n.settings.kind]));
  const client = graph.nodes.find((n) => n.settings.kind === 'client')!.settings;
  return { kind: 'custom', graph, topology, scenarios: builtScenarios(topology, kinds, client.kind === 'client' ? client.rps : 100) };
}

/** The scenarios on offer for a system. */
export function scenarioCatalog(system: System): ScenarioPreset[] {
  return system.kind === 'preset' ? Object.values(presetScenarios) : system.scenarios;
}

/**
 * The id of the system's scenario that `scenarioId` names (an older save's id gives today's, see
 * `findScenario`), or its first scenario's when it names none of them.
 */
export function resolveScenarioId(system: System, scenarioId: string): string {
  const list = scenarioCatalog(system);
  return (findScenario(list, scenarioId) ?? list[0]).id;
}

/** A fresh draft for one of the system's scenarios (its first if the id isn't one of them). */
export function systemDraft(system: System, scenarioId: string): Draft {
  const list = scenarioCatalog(system);
  const scenario = findScenario(list, scenarioId) ?? list[0];
  const topology = system.kind === 'preset' ? webChain : system.topology;
  return { scenario: structuredClone(scenario), topology: structuredClone(topology) };
}

/** The example system drawn on the canvas, exactly as the example preset runs it (its traffic, retries, sizes). */
export function exampleGraph(): BuilderGraph {
  return graphFromPreset(webChain, presetScenarios['retry-storm'].rps);
}

/** The graph the canvas opens with: the built system as drawn, or the example drawn on the canvas. */
export function graphForCanvas(system: System, rps: number): BuilderGraph {
  return system.kind === 'custom' ? system.graph : graphFromPreset(webChain, rps);
}

/**
 * A built system's scenario `scenarioId` on the system as it is now: with the settings changed
 * since it was built (the drawer, the failure editor's traffic and retries, all in `current`), so
 * choosing another failure never throws those edits away. Its scenarios are sized afresh for them.
 * Scenario ids name their part, so the failure picked is the one the picker showed. When the
 * changed shares drop that part from the scenarios offered (only the busiest few of a kind are),
 * the scenario as offered runs on the changed system, with the map's traffic range for it.
 */
export function editedDraft(system: Extract<System, { kind: 'custom' }>, scenarioId: string, current: Draft): Draft {
  const now = customSystem(syncGraph(system.graph, current.topology, current.scenario.rps)) as Extract<System, { kind: 'custom' }>;
  const offered = findScenario(system.scenarios, scenarioId);
  if (findScenario(now.scenarios, scenarioId) || !offered) return systemDraft(now, scenarioId);
  const rps = current.scenario.rps;
  const scenario = { ...structuredClone(offered), rps, map: { x: builtTrafficAxis(now.topology, rps), y: structuredClone(offered.map.y) } };
  return { scenario, topology: structuredClone(now.topology) };
}

/**
 * For a built system, the map's traffic levels around the draft's own traffic (its topology's
 * capacity may have changed too), so the users' traffic stays on the map after a re-run.
 * A preset's map is fixed, so a preset draft is returned as it is.
 */
export function withTrafficAxis(d: Draft): Draft {
  if (d.scenario.topology !== CUSTOM_TOPOLOGY_ID || d.scenario.map.x.param !== 'rps') return d;
  const x = builtTrafficAxis(d.topology, d.scenario.rps);
  if (x.values.join() === d.scenario.map.x.values.join()) return d;
  return { ...d, scenario: { ...d.scenario, map: { ...d.scenario.map, x } } };
}

/** What a new built system starts with: the current failure when it still applies there, else why not. */
export interface CarriedOver {
  draft: Draft;
  scenarioId: string;
  /** Why the failure had to be reset, in plain words; absent when it was kept. */
  reset?: string;
}

/**
 * "Use this topology": keeps the current failure (parts, kinds, timings, the run's length and the
 * failure-length axis) when every part it names still exists, matched by id, and can still fail
 * that way; the traffic and every setting come from the canvas. It is filed under the new system's
 * scenario of the same id (the same failure on the same part), or its first. Otherwise that
 * scenario is used as offered, and `reset` says why.
 */
export function carryOver(applied: Draft, scenarioId: string, next: Extract<System, { kind: 'custom' }>): CarriedOver {
  const catalog = next.scenarios;
  // Ids name their part, so this is the same part's scenario on the new system; an id that isn't
  // one of them (an older save's) falls back to the scenario failing the same parts the same way.
  const shape = (faults: ScenarioPreset['faults']) => JSON.stringify(faults.map((f) => [f.tier, faultKindOf(f)]));
  const base = catalog.find((s) => s.id === scenarioId) ?? catalog.find((s) => shape(s.faults) === shape(applied.scenario.faults)) ?? findScenario(catalog, scenarioId) ?? catalog[0];
  const label = (id: string) => applied.topology.layout[id]?.label ?? id;
  // A failure from the example names the example's part, not one of yours that may share its name.
  const fromExample = applied.scenario.topology !== CUSTOM_TOPOLOGY_ID;
  let why: string | undefined;
  for (const f of applied.scenario.faults) {
    const tier = next.topology.tiers.find((t) => t.id === f.tier);
    if (!tier) why ??= fromExample ? `the example's ${label(f.tier)}, where it happened, is not in your system` : `${label(f.tier)}, where it happened, is no longer in your system`;
    else if (faultKindOf(f) === 'restart-empty' && !tier.cache) why ??= `${label(f.tier)} is no longer a cache, so it can't restart empty`;
    else if (f.instance !== undefined && (tier.instances < 2 || f.instance >= tier.instances)) why ??= tier.instances < 2 ? `${label(f.tier)} has only one copy now, so losing one would take it down completely` : `${label(f.tier)} has only ${tier.instances} copies now`;
  }
  if (why) {
    const draft = systemDraft(next, base.id);
    return { draft, scenarioId: base.id, reset: `The failure was reset to "${draft.scenario.title}": ${why}.` };
  }
  const same = JSON.stringify(applied.scenario.faults) === JSON.stringify(base.faults);
  const scenario = {
    ...structuredClone(base),
    // Its own words when it is the scenario as offered; the viewer's own title once changed.
    ...(same ? {} : { title: applied.scenario.title, blurb: applied.scenario.blurb }),
    faults: structuredClone(applied.scenario.faults),
    durationMs: applied.scenario.durationMs,
    map: { x: base.map.x, y: structuredClone(applied.scenario.map.y) },
  };
  // In systemDraft's key order, so the app's comparison (by JSON) sees an unchanged draft as unchanged.
  return { draft: { scenario, topology: structuredClone(next.topology) }, scenarioId: base.id };
}
