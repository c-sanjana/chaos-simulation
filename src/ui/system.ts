import { compileGraph } from '../builder/compile';
import { graphFromPreset } from '../builder/fromPreset';
import type { BuilderGraph } from '../builder/graph';
import { builtScenarios } from '../builder/scenarios';
import { scenarios as presetScenarios } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { ScenarioPreset, TopologyPreset } from '../data/types';
import type { Draft } from './draft';

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

/** A fresh draft for one of the system's scenarios (its first if the id isn't one of them). */
export function systemDraft(system: System, scenarioId: string): Draft {
  const list = scenarioCatalog(system);
  const scenario = list.find((s) => s.id === scenarioId) ?? list[0];
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
