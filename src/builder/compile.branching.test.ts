import { callsOf } from '../engine/config';
import { compileGraph } from './compile';
import { graphFromPreset, kindOfTier, syncGraph } from './fromPreset';
import { defaultCall, defaultSettings, type BuilderGraph, type BuilderNode, type ComponentKind } from './graph';
import { branchedGraph, chainGraph } from './testGraphs';
import { validateGraph } from './validate';

const at = (t: ReturnType<typeof compileGraph>) => Object.fromEntries(Object.entries(t.layout).map(([id, l]) => [id, [l.col, l.row]]));

function node(id: string, kind: ComponentKind, col: number, row: number): BuilderNode {
  return { id, label: id, col, row, settings: defaultSettings(kind) };
}
function link(from: string, to: string, a: ComponentKind, b: ComponentKind) {
  return { id: `${from}--${to}`, from, to, call: defaultCall(a, b) };
}
/** Client → Load balancer → n app servers → one shared database. */
export function fanGraph(n: number): BuilderGraph {
  const servers = Array.from({ length: n }, (_, i) => node(`s${i + 1}`, 'server', 5, 1 + 2 * i));
  return {
    nodes: [node('client', 'client', 1, 3), node('lb', 'loadBalancer', 3, 3), ...servers, node('db', 'database', 7, 3)],
    edges: [link('client', 'lb', 'client', 'loadBalancer'), ...servers.map((s) => link('lb', s.id, 'loadBalancer', 'server')), ...servers.map((s) => link(s.id, 'db', 'server', 'database'))],
  };
}
/** Client → API, which calls Auth (above) and DB 1; Auth calls DB 2. */
function twoDatabases(): BuilderGraph {
  return {
    nodes: [node('client', 'client', 1, 3), node('api', 'server', 3, 3), node('db1', 'database', 5, 3), node('auth', 'server', 5, 1), node('db2', 'database', 7, 1)],
    edges: [link('client', 'api', 'client', 'server'), link('api', 'db1', 'server', 'database'), link('api', 'auth', 'server', 'server'), link('auth', 'db2', 'server', 'database')],
  };
}

describe('compileGraph with branches', () => {
  it('a load balancer splits over its servers (evenly unless shares are set); a chain link stays as before', () => {
    const t = compileGraph(branchedGraph());
    expect(t.tiers.map((x) => x.id)).toEqual(['lb', 's1', 'cache', 's2', 's3', 'db1', 'queue', 'db2']);
    const tier = (id: string) => t.tiers.find((x) => x.id === id)!;
    expect(tier('lb')).toMatchObject({ fanOut: 'split', downstream: { target: 's1' }, moreDownstream: [{ target: 's2' }, { target: 's3' }] });
    expect(callsOf(tier('lb')).some((c) => 'share' in c)).toBe(false);
    expect(tier('s1')).toMatchObject({ downstream: { target: 'db1' }, cacheAside: { target: 'cache' } });
    expect(tier('s2').downstream!.target).toBe('db1');
    for (const id of ['s1', 's2', 's3', 'queue', 'db1']) {
      expect(tier(id)).not.toHaveProperty('moreDownstream');
      expect(tier(id)).not.toHaveProperty('fanOut');
    }
    const shared = branchedGraph();
    shared.edges = shared.edges.map((e) => (e.id === 'lb--s1' ? { ...e, call: { ...e.call, share: 2 } } : e));
    expect(compileGraph(shared).tiers[0].downstream).toMatchObject({ target: 's1', share: 2 });
  });

  it('lays branches out in rows: servers fan out around the load balancer, the cache above its server', () => {
    expect(at(compileGraph(branchedGraph()))).toEqual({
      client: [1, 5],
      lb: [3, 5],
      s1: [5, 3],
      cache: [5, 1],
      s2: [5, 5],
      s3: [5, 7],
      db1: [7, 3],
      queue: [7, 7],
      db2: [9, 7],
    });
  });

  it('a database shared by three servers sits level with the middle one; with two, level with the first', () => {
    const g = fanGraph(3);
    expect(validateGraph(g)).toEqual([]);
    expect(at(compileGraph(g))).toEqual({ client: [1, 5], lb: [3, 5], s1: [5, 3], s2: [5, 5], s3: [5, 7], db: [7, 5] });
    expect(at(compileGraph(fanGraph(2)))).toEqual({ client: [1, 3], lb: [3, 3], s1: [5, 3], s2: [5, 5], db: [7, 3] });
  });

  it('a shared part is not moved onto a spot that is taken', () => {
    // s2 also calls a queue, which takes the spot level with s2 that the database would move to.
    const g = fanGraph(3);
    g.nodes.push(node('q', 'queue', 7, 5), node('db2', 'database', 9, 5));
    g.edges.push(link('s2', 'q', 'server', 'queue'), link('q', 'db2', 'queue', 'database'));
    const l = at(compileGraph(g));
    expect(l.q).toEqual([7, 5]);
    expect(l.db).not.toEqual(l.q);
  });

  it('an app server calling a database and another app server: calls in canvas order, one after another or all at once', () => {
    const g = twoDatabases();
    expect(validateGraph(g)).toEqual([]);
    const t = compileGraph(g);
    // Auth is higher on the canvas, so it is called first.
    expect(t.tiers.find((x) => x.id === 'api')).toMatchObject({ fanOut: 'sequence', downstream: { target: 'auth' }, moreDownstream: [{ target: 'db1' }] });
    expect(t.tiers.map((x) => x.id)).toEqual(['api', 'auth', 'db1', 'db2']);
    expect(at(t)).toEqual({ client: [1, 3], api: [3, 3], auth: [5, 3], db2: [7, 3], db1: [5, 5] });
    const parallel = { ...g, nodes: g.nodes.map((n) => (n.id === 'api' ? { ...n, settings: { ...n.settings, fanOut: 'parallel' as const } } : n)) };
    expect(compileGraph(parallel).tiers[0].fanOut).toBe('parallel');
  });

  it('reads branches back from a compiled topology, and syncs edited calls onto the canvas', () => {
    const g = branchedGraph();
    g.edges = g.edges.map((e) => (e.id === 'lb--s3' ? { ...e, call: { ...e.call, share: 0.5 } } : e));
    const t = compileGraph(g);
    const back = graphFromPreset(t, 100);
    expect(back.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(g.edges.map((e) => `${e.from}>${e.to}`).sort());
    expect(back.edges.find((e) => e.to === 's3')!.call.share).toBe(0.5);
    expect(kindOfTier(t, t.tiers[0])).toBe('loadBalancer');
    // The drawer changed a retry on the second call and the split.
    const edited = structuredClone(t);
    edited.tiers[0].moreDownstream![0].retries = 4;
    edited.tiers[0].moreDownstream![1].share = 3;
    const synced = syncGraph(g, edited, 100);
    expect(synced.edges.find((e) => e.id === 'lb--s2')!.call.retries).toBe(4);
    expect(synced.edges.find((e) => e.id === 'lb--s3')!.call.share).toBe(3);
    expect(compileGraph(synced)).toEqual(edited);
  });

  it('keeps a server set to call all at once while it has only one call', () => {
    const g = chainGraph(['client', 'server', 'database']);
    g.nodes[1].settings = { ...g.nodes[1].settings, fanOut: 'parallel' } as BuilderNode['settings'];
    const t = compileGraph(g);
    expect(t.tiers[0]).not.toHaveProperty('fanOut');
    expect(syncGraph(g, t, 100).nodes[1].settings).toMatchObject({ fanOut: 'parallel' });
    // A compiled server that calls several parts all at once is read back that way.
    const two = twoDatabases();
    two.nodes[1].settings = { ...two.nodes[1].settings, fanOut: 'parallel' } as BuilderNode['settings'];
    const compiled = compileGraph(two);
    expect(graphFromPreset(compiled, 100).nodes.find((n) => n.id === 'api')!.settings).toMatchObject({ kind: 'server', fanOut: 'parallel' });
    expect(kindOfTier(compiled, compiled.tiers[0])).toBe('server');
  });
});
