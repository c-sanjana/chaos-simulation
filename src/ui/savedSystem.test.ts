import { chainGraph } from '../builder/testGraphs';
import { isGraph, loadSaved, SAVED_SYSTEM_KEY, saveState } from './savedSystem';
import { customSystem, PRESET_SYSTEM, systemDraft } from './system';

/** An in-memory storage, optionally broken. */
function memory(broken = false) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => {
      if (broken) throw new Error('blocked');
      return data.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error('blocked');
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('saved system', () => {
  const graph = chainGraph(['client', 'server', 'database'], 1);
  const system = customSystem(graph);

  it('saves a built system with what runs on it, and restores it', () => {
    const store = memory();
    const applied = systemDraft(system, 'custom-cache-restart');
    applied.topology.tiers[0].instances = 9;
    saveState({ system, scenarioId: 'custom-cache-restart', applied, canvas: graph, canvasOpen: false }, store);
    const back = loadSaved(store)!;
    expect(back.system).toEqual(system);
    expect(back.scenarioId).toBe('custom-cache-restart');
    expect(back.applied).toEqual(applied);
    expect(back.canvas).toEqual(graph);
    expect(back.canvasOpen).toBe(false);
  });

  it('forgets everything once the example is in use with no drawing', () => {
    const store = memory();
    saveState({ system, scenarioId: 'x', applied: systemDraft(system, 'x'), canvas: null, canvasOpen: false }, store);
    expect(store.data.has(SAVED_SYSTEM_KEY)).toBe(true);
    saveState({ system: PRESET_SYSTEM, scenarioId: 'retry-storm', applied: systemDraft(PRESET_SYSTEM, 'retry-storm'), canvas: null, canvasOpen: false }, store);
    expect(store.data.has(SAVED_SYSTEM_KEY)).toBe(false);
    expect(loadSaved(store)).toBeNull();
  });

  it('keeps a drawing over the example, open or not, with the example scenario chosen', () => {
    const store = memory();
    saveState({ system: PRESET_SYSTEM, scenarioId: 'cache-restart', applied: systemDraft(PRESET_SYSTEM, 'cache-restart'), canvas: graph, canvasOpen: true }, store);
    const back = loadSaved(store)!;
    expect(back.system).toBe(PRESET_SYSTEM);
    expect(back.applied.scenario.id).toBe('cache-restart');
    expect(back.canvasOpen).toBe(true);
  });

  it('never trusts a damaged or outdated save', () => {
    const store = memory();
    store.data.set(SAVED_SYSTEM_KEY, '{not json');
    expect(loadSaved(store)).toBeNull();
    // A graph that can't run, an unknown scenario, a draft from another system, a broken drawing.
    const lonely = chainGraph(['client']);
    const otherDraft = systemDraft(customSystem(chainGraph(['client', 'server'])), '');
    store.data.set(SAVED_SYSTEM_KEY, JSON.stringify({ system: lonely, scenarioId: 'nope', applied: otherDraft, canvas: { nodes: [{ id: 1 }], edges: [] }, canvasOpen: true }));
    const back = loadSaved(store)!;
    expect(back.system).toBe(PRESET_SYSTEM);
    expect(back.scenarioId).toBe('retry-storm');
    expect(back.canvas).toBeNull();
    expect(back.canvasOpen).toBe(false);
    // A draft for this system whose settings no longer make a valid run is replaced by a fresh one.
    const bad = systemDraft(system, 'custom-db-slow');
    bad.topology.tiers[0].instances = 0;
    store.data.set(SAVED_SYSTEM_KEY, JSON.stringify({ system: graph, scenarioId: 'custom-db-slow', applied: bad, canvas: null, canvasOpen: false }));
    expect(loadSaved(store)!.applied).toEqual(systemDraft(system, 'custom-db-slow'));
    const late = systemDraft(system, 'custom-db-slow');
    late.scenario.durationMs = 30_000;
    store.data.set(SAVED_SYSTEM_KEY, JSON.stringify({ system: graph, scenarioId: 'custom-db-slow', applied: late, canvas: null, canvasOpen: false }));
    expect(loadSaved(store)!.applied.scenario.durationMs).toBe(120_000);
  });

  it('works without storage: nothing restored, nothing thrown', () => {
    const store = memory(true);
    expect(loadSaved(store)).toBeNull();
    expect(() => saveState({ system, scenarioId: '', applied: systemDraft(system, ''), canvas: null, canvasOpen: false }, store)).not.toThrow();
  });

  it('checks the shape of a graph', () => {
    expect(isGraph(graph)).toBe(true);
    expect(isGraph(null)).toBe(false);
    expect(isGraph({ nodes: [], edges: [{ id: 'e', from: 'a', to: 'b', call: null }] })).toBe(false);
    expect(isGraph({ nodes: [{ id: 'a', label: 'A', col: 1, row: 1, settings: { kind: 'robot' } }], edges: [] })).toBe(false);
  });
});
