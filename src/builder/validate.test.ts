import { branchedGraph, chainGraph } from './testGraphs';
import { defaultCall, defaultSettings, type BuilderGraph } from './graph';
import { validateGraph } from './validate';

const withNode = (g: BuilderGraph, id: string, kind: Parameters<typeof defaultSettings>[0]): BuilderGraph => ({
  ...g,
  nodes: [...g.nodes, { id, label: id, col: 9, row: 5, settings: defaultSettings(kind) }],
});
const withEdge = (g: BuilderGraph, from: string, to: string): BuilderGraph => ({ ...g, edges: [...g.edges, { id: `${from}-${to}`, from, to, call: defaultCall('server', 'server') }] });

describe('validateGraph', () => {
  it('accepts chains with a cache and a queue', () => {
    expect(validateGraph(chainGraph(['client', 'server', 'database']))).toEqual([]);
    expect(validateGraph(chainGraph(['client', 'queue', 'server', 'server', 'database'], 2))).toEqual([]);
  });

  it('needs exactly one client, connected', () => {
    expect(validateGraph({ nodes: [], edges: [] })).toEqual(['Add a Client: it stands for the users sending requests.']);
    const lone = chainGraph(['client']);
    expect(validateGraph(lone)).toEqual(['Connect the Client to the component users call first.']);
    const two = withNode(chainGraph(['client', 'server']), 'other', 'client');
    expect(validateGraph(two)).toContain('Use one Client: it stands for all your users.');
  });

  it('branching: a server calls several parts, a load balancer splits, several parts share one', () => {
    const g = withEdge(withNode(chainGraph(['client', 'server', 'database']), 'db2', 'database'), 'n1', 'db2');
    expect(validateGraph(g)).toEqual([]);
    expect(validateGraph(branchedGraph())).toEqual([]);
  });

  it('the Client and a queue each send to one part, and say how to spread', () => {
    const client = withEdge(withNode(chainGraph(['client', 'server']), 's2', 'server'), 'n0', 's2');
    expect(validateGraph(client)).toEqual([
      'The Client sends to server 1 and s2, but it stands for users calling one front door. Remove all but one of these calls, and put a load balancer in front to spread users over several parts.',
    ]);
    const queue = withEdge(withNode(chainGraph(['client', 'queue', 'server']), 's2', 'server'), 'n1', 's2');
    expect(validateGraph(queue)).toEqual(["queue 1 hands its messages to server 2 and s2, but a queue's consumers pass each message to one part. Remove all but one of these calls, or add a queue for each."]);
  });

  it("a load balancer's arrows each need a share of traffic above 0%", () => {
    const g = branchedGraph();
    const zero = { ...g, edges: g.edges.map((e) => (e.id === 'lb--s2' ? { ...e, call: { ...e.call, share: 0 } } : e)) };
    expect(validateGraph(zero)).toEqual(['lb sends no traffic to s2: give that arrow a share of traffic above 0%, or remove it.']);
    const nan = { ...g, edges: g.edges.map((e) => (e.id === 'lb--s2' ? { ...e, call: { ...e.call, share: NaN } } : e)) };
    expect(validateGraph(nan)).toHaveLength(1);
  });

  it('the same call drawn twice, and a server set to call its parts some other way', () => {
    const g = chainGraph(['client', 'server', 'database']);
    expect(validateGraph({ ...g, edges: [...g.edges, { ...g.edges[1], id: 'again' }] })).toEqual(['server 1 calls database 2 twice: select one of the two arrows and press Remove this call.']);
    const odd = { ...g, nodes: g.nodes.map((n) => (n.id === 'n1' ? { ...n, settings: { ...n.settings, fanOut: 'split' } } : n)) } as BuilderGraph;
    expect(validateGraph(odd)).toEqual(['server 1: choose whether it calls its parts one after another or all at once.']);
  });

  it('caches: one per server, and a server with a cache needs something to fall back on', () => {
    const two = withEdge(withNode(chainGraph(['client', 'server', 'database'], 1), 'c2', 'cache'), 'n1', 'c2');
    expect(validateGraph(two)).toContain('server 1 uses 2 caches; use one. Select the arrow to each extra cache and press Remove this call.');
    const noFallback = chainGraph(['client', 'server'], 1);
    expect(validateGraph(noFallback)).toEqual([
      "server 1 has a cache but nothing to ask when the cache doesn't have the answer: connect it to a database or another component.",
    ]);
  });

  it('a queue and a load balancer must lead somewhere', () => {
    expect(validateGraph(chainGraph(['client', 'queue']))).toEqual(['queue 1 holds work, but nothing does it: connect it to the component its consumers call.']);
    expect(validateGraph(chainGraph(['client', 'loadBalancer']))).toEqual(['loadBalancer 1 spreads requests, but over nothing: connect it to the servers behind it.']);
  });

  it('refuses calls that make no sense, loops, missing ends and unreached parts', () => {
    const g = chainGraph(['client', 'server', 'database']);
    expect(validateGraph(withEdge(g, 'n2', 'n1'))).toContain("database 2 can't call server 1: a database doesn't call an app server. Select that arrow and press Remove this call.");
    const loop = withEdge(withEdge(withNode(chainGraph(['client', 'server']), 's2', 'server'), 'n1', 's2'), 's2', 'n1');
    // Blank names are shown as their kind, never as an empty word.
    const blank = { ...loop, nodes: loop.nodes.map((n) => (n.id === 's2' ? { ...n, label: ' ' } : n)) };
    expect(validateGraph(blank)).toContain('These call each other in a loop: server 1 → App server → server 1. A request would go round forever: remove one of these calls.');
    expect(validateGraph(loop)).toContain('These call each other in a loop: server 1 → s2 → server 1. A request would go round forever: remove one of these calls.');
    expect(validateGraph(withEdge(g, 'n2', 'ghost'))).toContain('A connection points at a component that no longer exists.');
    expect(validateGraph(withNode(g, 'spare', 'server'))).toEqual(["spare isn't reached from the Client: connect it or remove it."]);
  });

  it('every part needs its own name', () => {
    const g = chainGraph(['client', 'server', 'server', 'database']);
    const named = (a: string, b: string) => ({ ...g, nodes: g.nodes.map((n) => (n.id === 'n1' ? { ...n, label: a } : n.id === 'n2' ? { ...n, label: b } : n)) });
    expect(validateGraph(named('  ', 'API'))).toEqual(['Give the app server a name: select it and type one in Name.']);
    expect(validateGraph(named('API', 'api '))).toEqual(['Two parts are called "API": give each its own name (select one and change its Name).', 'Two parts are called "api": give each its own name (select one and change its Name).']);
  });

  it('settings that cannot be simulated', () => {
    const g = chainGraph(['client', 'server', 'queue', 'database'], 1);
    const set = (id: string, patch: object) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, settings: { ...n.settings, ...patch } } : n)) }) as BuilderGraph;
    expect(validateGraph(set('n0', { rps: 0 }))).toEqual(['client 0: traffic must be above 0 requests a second.']);
    expect(validateGraph(set('n1', { service: { medianMs: 5, p99Ms: 5 } }))).toEqual(['server 1: the slowest 1% (p99) must take longer than the typical (median) request. Raise "Slowest 1% take" above 5 ms.']);
    expect(validateGraph(set('n1', { service: { medianMs: 0, p99Ms: 5 } }))).toEqual(['server 1: the typical (median) time must be above 0.']);
    expect(validateGraph(set('n1', { instances: 1.5, workersPerInstance: 0 }))).toEqual(['server 1: copies must be a whole number above 0.', 'server 1: workers per copy must be a whole number above 0.']);
    expect(validateGraph(set('n2', { maxDepth: 0, consumers: -1 }))).toEqual(['queue 2: the number of messages it holds must be a whole number above 0.', 'queue 2: consumers must be a whole number above 0.']);
    expect(validateGraph(set('c', { capacity: 0, keys: 0 }))).toEqual(['cache: the number of keys it holds must be a whole number above 0.', 'cache: the number of distinct keys must be a whole number above 0.']);
  });
});
