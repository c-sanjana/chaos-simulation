import { branchedGraph, chainGraph } from '../builder/testGraphs';
import { updateCallAt, updateTier } from './draft';
import { loadSaved, SAVED_SYSTEM_KEY, saveState } from './savedSystem';
import { customSystem, systemDraft } from './system';

function memory() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

describe('saved branched systems', () => {
  it('saves and restores a branched system with its shares, how a server calls its parts and edits to any call', () => {
    const graph = branchedGraph();
    graph.edges = graph.edges.map((e) => (e.id === 'lb--s3' ? { ...e, call: { ...e.call, share: 2 } } : e));
    const system = customSystem(graph);
    let applied = systemDraft(system, 'custom-db-slow-db1');
    applied = updateTier(applied, 'lb', (t) => updateCallAt(t, 2, { retries: 4 }));
    const store = memory();
    saveState({ system, scenarioId: 'custom-db-slow-db1', applied, canvas: graph, canvasOpen: true }, store);
    const restored = loadSaved(store)!;
    expect(restored.system).toEqual(system);
    expect(restored.scenarioId).toBe('custom-db-slow-db1');
    expect(restored.applied.topology.tiers[0].moreDownstream![1]).toMatchObject({ target: 's3', share: 2, retries: 4 });
    expect(restored.canvas).toEqual(graph);
    expect(restored.canvasOpen).toBe(true);
  });

  it('loads a save from before branching (a chain, no shares or call settings)', () => {
    const graph = chainGraph(['client', 'server', 'database'], 1);
    const old = { system: graph, scenarioId: 'custom-db-slow', applied: systemDraft(customSystem(graph), 'custom-db-slow'), canvas: null, canvasOpen: false };
    const store = memory();
    store.setItem(SAVED_SYSTEM_KEY, JSON.stringify(old));
    const restored = loadSaved(store)!;
    expect(restored.system.kind).toBe('custom');
    expect(restored.applied).toEqual(old.applied);
  });
});
