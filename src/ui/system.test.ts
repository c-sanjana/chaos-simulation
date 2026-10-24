import { compileGraph } from '../builder/compile';
import { graphFromPreset, syncGraph } from '../builder/fromPreset';
import { chainGraph } from '../builder/testGraphs';
import { scenarios } from '../data/scenarios';
import { webChain } from '../data/topologies';
import { updateFault, updateScenario, updateTier } from './draft';
import { carryOver, customSystem, editedDraft, exampleGraph, graphForCanvas, PRESET_SYSTEM, scenarioCatalog, systemDraft, withTrafficAxis } from './system';

type Custom = Extract<ReturnType<typeof customSystem>, { kind: 'custom' }>;

describe('system', () => {
  it('the preset system offers the preset scenarios on the example topology', () => {
    expect(scenarioCatalog(PRESET_SYSTEM)).toEqual(Object.values(scenarios));
    const d = systemDraft(PRESET_SYSTEM, 'cache-restart');
    expect(d.scenario.id).toBe('cache-restart');
    expect(d.topology).toEqual(webChain);
    expect(d.topology).not.toBe(webChain); // a copy to edit
    expect(graphForCanvas(PRESET_SYSTEM, 150).nodes.find((n) => n.id === 'client')!.settings).toEqual({ kind: 'client', rps: 150 });
  });

  it('a built system is compiled and offers its own scenarios at the client traffic', () => {
    const graph = chainGraph(['client', 'server', 'database'], 1);
    const system = customSystem(graph);
    expect(system.kind).toBe('custom');
    expect(scenarioCatalog(system).map((s) => s.id)).toEqual(['custom-db-slow', 'custom-cache-restart', 'custom-front-slow']);
    const d = systemDraft(system, 'nope'); // unknown → the first
    expect(d.scenario.id).toBe('custom-db-slow');
    expect(d.scenario.rps).toBe(100);
    expect(d.topology).toEqual(compileGraph(graph));
    expect(graphForCanvas(system, 999)).toBe(graph);
  });
});

describe('syncGraph', () => {
  it('takes settings changed elsewhere, keeping what each part is, its name and place', () => {
    const graph = chainGraph(['client', 'server', 'database'], 1);
    const t = compileGraph(graph);
    const edited = {
      ...t,
      tiers: t.tiers.map((x) => (x.id === 'n2' ? { ...x, instances: 3 } : x.id === 'n1' ? { ...x, downstream: { ...x.downstream!, retries: 4 } } : x)),
    };
    const synced = syncGraph({ ...graph, nodes: [...graph.nodes, { id: 'loose', label: 'loose', col: 9, row: 5, settings: { kind: 'client', rps: 1 } }] }, edited, 250);
    const db = synced.nodes.find((n) => n.id === 'n2')!;
    expect(db).toMatchObject({ label: 'database 2', col: 5, row: 3, settings: { kind: 'database', instances: 3 } });
    expect(synced.nodes.find((n) => n.id === 'n1')!.settings.kind).toBe('server'); // the preset reader would call the first tier a load balancer
    expect(synced.nodes.find((n) => n.id === 'n0')!.settings).toEqual({ kind: 'client', rps: 250 });
    expect(synced.edges.find((e) => e.from === 'n1' && e.to === 'n2')!.call.retries).toBe(4);
    expect(synced.nodes.find((n) => n.id === 'loose')!.settings).toEqual({ kind: 'client', rps: 1 }); // not in the topology: untouched
    expect(compileGraph(synced).tiers).toEqual(edited.tiers);
  });

  it('reads a preset as drawn: the first tier is a load balancer, leaves are databases', () => {
    const g = graphFromPreset(webChain, 200);
    expect(Object.fromEntries(g.nodes.map((n) => [n.id, n.settings.kind]))).toEqual({ client: 'client', gateway: 'loadBalancer', api: 'server', cache: 'cache', db: 'database' });
  });
});

describe('carrying a failure over to a new built system', () => {
  const example = customSystem(exampleGraph()) as Custom; // the example's part ids: gateway, api, cache, db

  it('keeps the failure (and its title once changed) when its parts are still there; traffic comes from the canvas', () => {
    const applied = updateScenario(updateFault(systemDraft(PRESET_SYSTEM, 'retry-storm'), { factor: 4 }), { durationMs: 150_000 });
    const kept = carryOver(applied, 'retry-storm', example);
    expect(kept.reset).toBeUndefined();
    expect(kept.scenarioId).toBe('custom-db-slow');
    expect(kept.draft.scenario).toMatchObject({ title: 'Retry storm', faults: applied.scenario.faults, durationMs: 150_000, rps: 200, topology: 'custom' });
    expect(kept.draft.scenario.map.y).toEqual(applied.scenario.map.y);
    expect(kept.draft.scenario.map.x).toEqual(example.scenarios[0].map.x);
    expect(kept.draft.topology).toEqual(example.topology);
    // The scenario exactly as offered keeps its own words.
    const offered = systemDraft(example, 'custom-cache-restart');
    expect(carryOver(offered, 'custom-cache-restart', example).draft.scenario.title).toBe('Cache restarts empty');
  });

  it('resets it, saying why, when a part is gone or can no longer fail that way', () => {
    const chain = customSystem(chainGraph(['client', 'server', 'database'], 1)) as Custom; // n1 server, c cache, n2 database
    const gone = carryOver(systemDraft(PRESET_SYSTEM, 'retry-storm'), 'retry-storm', chain);
    expect(gone.reset).toBe('The failure was reset to "database 2 slows down": DB, where it happened, is no longer in your system.');
    expect(gone.draft).toEqual(systemDraft(chain, 'custom-db-slow'));
    // "Restarts empty" on a part that is no longer a cache.
    const restart = { ...systemDraft(chain, 'custom-cache-restart') };
    restart.scenario = { ...restart.scenario, faults: [{ ...restart.scenario.faults[0], tier: 'n2' }] };
    expect(carryOver(restart, 'custom-cache-restart', chain).reset).toMatch(/database 2 is no longer a cache, so it can't restart empty\.$/);
    // "One copy goes down" where there is only one copy now, or fewer than before.
    const one = updateFault(systemDraft(chain, 'custom-db-slow'), { kind: 'dead', instance: 0 });
    expect(carryOver(one, 'custom-db-slow', chain).reset).toMatch(/database 2 has only one copy now, so losing one would take it down completely\.$/);
    const fewer = updateFault(systemDraft(chain, ''), { tier: 'n1', kind: 'dead', instance: 5 });
    expect(carryOver(fewer, '', chain).reset).toMatch(/server 1 has only 4 copies now\.$/);
  });
});

describe('a built system as it is now', () => {
  const system = customSystem(chainGraph(['client', 'server', 'database'], 1)) as Custom;

  it('another failure keeps the settings edits and traffic, with scenarios sized for them', () => {
    const edited = updateScenario(updateTier(systemDraft(system, 'custom-db-slow'), 'n1', (t) => ({ ...t, instances: 9 })), { rps: 300 });
    const next = editedDraft(system, 'custom-front-slow', edited);
    expect(next.scenario.id).toBe('custom-front-slow');
    expect(next.scenario.rps).toBe(300);
    expect(next.topology.tiers.find((t) => t.id === 'n1')!.instances).toBe(9);
    expect(next.scenario.map.x.values).toContain(300);
  });

  it('a re-run with new traffic moves the map to it; a preset map stays as it is', () => {
    const d = updateScenario(systemDraft(system, 'custom-db-slow'), { rps: 1000 });
    expect(d.scenario.map.x.values).not.toContain(1000);
    expect(withTrafficAxis(d).scenario.map.x.values).toContain(1000);
    const same = systemDraft(system, 'custom-db-slow');
    expect(withTrafficAxis(same)).toBe(same);
    const preset = updateScenario(systemDraft(PRESET_SYSTEM, 'retry-storm'), { rps: 1000 });
    expect(withTrafficAxis(preset)).toBe(preset);
  });
});
