import { compileGraph } from '../builder/compile';
import { graphFromPreset, syncGraph } from '../builder/fromPreset';
import { chainGraph } from '../builder/testGraphs';
import { scenarios } from '../data/scenarios';
import { webChain } from '../data/topologies';
import { customSystem, graphForCanvas, PRESET_SYSTEM, scenarioCatalog, systemDraft } from './system';

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
