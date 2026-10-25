import { chainGraph } from '../builder/testGraphs';
import { forgetSaved, isGraph, loadSaved, SAVED_SYSTEM_KEY, saveState } from './savedSystem';
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

const SYSTEM_LOST = "Your saved system couldn't be restored (the save is damaged or from another version of this page), so the example system is shown.";

describe('saved system', () => {
  const graph = chainGraph(['client', 'server', 'database'], 1);
  const system = customSystem(graph);

  it('saves a built system with what runs on it, and restores it', () => {
    const store = memory();
    const applied = systemDraft(system, 'custom-cache-restart:c');
    applied.topology.tiers[0].instances = 9;
    saveState({ system, scenarioId: 'custom-cache-restart:c', applied, canvas: graph, canvasOpen: false }, store);
    const back = loadSaved(store)!;
    expect(back.system).toEqual(system);
    expect(back.scenarioId).toBe('custom-cache-restart:c');
    expect(back.notice).toBeUndefined();
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
    for (const raw of ['{not json', '42', 'null']) {
      store.data.set(SAVED_SYSTEM_KEY, raw);
      expect(loadSaved(store)).toMatchObject({ system: PRESET_SYSTEM, scenarioId: 'retry-storm', canvas: null, canvasOpen: false, notice: SYSTEM_LOST });
    }
    // A graph that can't run, an unknown scenario, a draft from another system, a broken drawing.
    const lonely = chainGraph(['client']);
    const otherDraft = systemDraft(customSystem(chainGraph(['client', 'server'])), '');
    store.data.set(SAVED_SYSTEM_KEY, JSON.stringify({ system: lonely, scenarioId: 'nope', applied: otherDraft, canvas: { nodes: [{ id: 1 }], edges: [] }, canvasOpen: true }));
    const back = loadSaved(store)!;
    expect(back.system).toBe(PRESET_SYSTEM);
    expect(back.scenarioId).toBe('retry-storm');
    expect(back.canvas).toBeNull();
    expect(back.canvasOpen).toBe(false);
    expect(back.notice).toBe("Your saved system and drawing couldn't be restored (the save is damaged or from another version of this page), so the example system is shown.");
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

  it("restores an older save's scenario id as the same failure, under today's id", () => {
    const store = memory();
    const old = systemDraft(system, 'custom-cache-restart:c');
    old.scenario.id = 'custom-cache-restart';
    store.data.set(SAVED_SYSTEM_KEY, JSON.stringify({ system: graph, scenarioId: 'custom-cache-restart', applied: old, canvas: null, canvasOpen: false }));
    const back = loadSaved(store)!;
    expect(back.scenarioId).toBe('custom-cache-restart:c');
    expect(back.applied).toEqual(systemDraft(system, 'custom-cache-restart:c'));
  });

  it('leaves out a drawing the page could not show, with a notice, and keeps the rest', () => {
    const store = memory();
    const broken = structuredClone(graph);
    delete (broken.nodes[1].settings as Partial<{ service: unknown }>).service; // a damaged save (code review 3, finding 4)
    store.data.set(SAVED_SYSTEM_KEY, JSON.stringify({ system: graph, scenarioId: '', applied: null, canvas: broken, canvasOpen: true }));
    const back = loadSaved(store)!;
    expect(back.system).toEqual(system);
    expect(back.canvas).toBeNull();
    expect(back.canvasOpen).toBe(false);
    expect(back.notice).toBe("Your saved drawing couldn't be restored (the save is damaged or from another version of this page), so it was left out.");
    // A drawing with problems the builder can list is kept: the viewer fixes them there.
    const unfinished = chainGraph(['client', 'server']);
    unfinished.edges[0].call.retries = -1;
    store.data.set(SAVED_SYSTEM_KEY, JSON.stringify({ system: null, scenarioId: '', applied: null, canvas: unfinished, canvasOpen: true }));
    expect(loadSaved(store)).toMatchObject({ system: PRESET_SYSTEM, canvas: unfinished, canvasOpen: true });
    expect(loadSaved(store)!.notice).toBeUndefined();
  });

  it('never restores a built system whose settings the engine would refuse (code review 3, finding 5)', () => {
    const store = memory();
    const bad = structuredClone(graph);
    bad.edges[0].call.retries = -1;
    store.data.set(SAVED_SYSTEM_KEY, JSON.stringify({ system: bad, scenarioId: '', applied: null, canvas: null, canvasOpen: false }));
    expect(loadSaved(store)).toMatchObject({ system: PRESET_SYSTEM, notice: SYSTEM_LOST });
  });

  it('forgets the save ("Start again" after the page broke)', () => {
    const store = memory();
    store.data.set(SAVED_SYSTEM_KEY, '{}');
    forgetSaved(store);
    expect(store.data.has(SAVED_SYSTEM_KEY)).toBe(false);
    expect(() => forgetSaved({ ...memory(), removeItem: () => { throw new Error('blocked'); } })).not.toThrow();
  });

  it('checks the shape of a graph', () => {
    expect(isGraph(graph)).toBe(true);
    expect(isGraph(null)).toBe(false);
    expect(isGraph({ nodes: [], edges: [{ id: 'e', from: 'a', to: 'b', call: null }] })).toBe(false);
    expect(isGraph({ nodes: [{ id: 'a', label: 'A', col: 1, row: 1, settings: { kind: 'robot' } }], edges: [] })).toBe(false);
    // Every field the page reads, of the right type, on the grid, with unique ids.
    const changed = (change: (g: ReturnType<typeof structuredClone<typeof graph>>) => void) => {
      const g = structuredClone(graph);
      change(g);
      return isGraph(g);
    };
    const settings = (g: typeof graph, i: number) => g.nodes[i].settings as unknown as Record<string, unknown>;
    expect(changed(() => {})).toBe(true);
    expect(changed((g) => (g.nodes[0].col = 10))).toBe(false);
    expect(changed((g) => (g.nodes[1].row = 1.5))).toBe(false);
    expect(changed((g) => (g.nodes[1].id = g.nodes[0].id))).toBe(false);
    expect(changed((g) => (g.edges[1].id = g.edges[0].id))).toBe(false);
    expect(changed((g) => (settings(g, 0).rps = '100'))).toBe(false);
    expect(changed((g) => delete settings(g, 1).service)).toBe(false);
    expect(changed((g) => (settings(g, 1).service = { medianMs: 4 }))).toBe(false);
    expect(changed((g) => delete settings(g, 1).instances)).toBe(false);
    expect(changed((g) => (settings(g, 1).queueLimit = '5'))).toBe(false);
    expect(changed((g) => delete settings(g, 1).dropExpired)).toBe(false);
    expect(changed((g) => (settings(g, 1).fanOut = 3))).toBe(false);
    expect(changed((g) => (settings(g, 3).ttlMs = 'never'))).toBe(false);
    expect(changed((g) => delete settings(g, 3).skew)).toBe(false);
    expect(changed((g) => (g.edges[0].call = {} as never))).toBe(false);
    expect(changed((g) => (g.edges[0].call.share = '2' as never))).toBe(false);
    expect(changed((g) => (g.edges[0].call.jitter = 1 as never))).toBe(false);
    const queue = chainGraph(['client', 'queue', 'server']);
    expect(isGraph(queue)).toBe(true);
    delete (queue.nodes[1].settings as Partial<{ consumers: number }>).consumers;
    expect(isGraph(queue)).toBe(false);
  });
});
