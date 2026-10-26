import { compileGraph } from './compile';
import { defaultCall, defaultSettings, type BuilderGraph, type ComponentKind } from './graph';
import { branchedGraph, chainGraph } from './testGraphs';
import { findProblems, validateGraph } from './validate';

const withNode = (g: BuilderGraph, id: string, kind: ComponentKind, label = id): BuilderGraph => ({
  ...g,
  nodes: [...g.nodes, { id, label, col: 9, row: 5, settings: defaultSettings(kind) }],
});
const withEdge = (g: BuilderGraph, from: string, to: string): BuilderGraph => ({ ...g, edges: [...g.edges, { id: `${from}-${to}`, from, to, call: defaultCall('server', 'server') }] });
const set = (g: BuilderGraph, id: string, patch: object) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, settings: { ...n.settings, ...patch } } : n)) }) as BuilderGraph;

describe('validateGraph: what can run', () => {
  it('accepts chains with a cache and a queue', () => {
    expect(validateGraph(chainGraph(['client', 'server', 'database']))).toEqual([]);
    expect(validateGraph(chainGraph(['client', 'queue', 'server', 'server', 'database'], 2))).toEqual([]);
  });

  it('accepts an App server calling a DB and a second App server, which calls DB 2 (user report), and compiles it', () => {
    const g: BuilderGraph = {
      nodes: [
        { id: 'client', label: 'Client', col: 1, row: 3, settings: defaultSettings('client') },
        { id: 'app', label: 'App server', col: 3, row: 3, settings: defaultSettings('server') },
        { id: 'db', label: 'DB', col: 5, row: 3, settings: defaultSettings('database') },
        { id: 'app2', label: 'App server 2', col: 5, row: 5, settings: defaultSettings('server') },
        { id: 'db2', label: 'DB2', col: 7, row: 5, settings: defaultSettings('database') },
      ],
      edges: [
        { id: 'a', from: 'client', to: 'app', call: defaultCall('client', 'server') },
        { id: 'b', from: 'app', to: 'db', call: defaultCall('server', 'database') },
        { id: 'c', from: 'app', to: 'app2', call: defaultCall('server', 'server') },
        { id: 'd', from: 'app2', to: 'db2', call: defaultCall('server', 'database') },
      ],
    };
    expect(validateGraph(g)).toEqual([]);
    const t = compileGraph(g);
    expect(t.tiers.find((x) => x.id === 'app')).toMatchObject({ downstream: { target: 'db' }, moreDownstream: [{ target: 'app2' }], fanOut: 'sequence' });
    expect(t.tiers.find((x) => x.id === 'app2')!.downstream!.target).toBe('db2');
  });

  it('accepts a load balancer over several servers, a database shared by two of them, and a cache', () => {
    expect(validateGraph(branchedGraph())).toEqual([]);
  });
});

describe('validateGraph: each message says what is wrong, naming the parts, then what to do', () => {
  it('no Client', () => {
    expect(validateGraph({ nodes: [], edges: [] })).toEqual(['No Client yet. Add one from the list above: requests start there.']);
  });

  it('two Clients', () => {
    const two = withNode(chainGraph(['client', 'server']), 'other', 'client', 'Mobile');
    // The second Client gets no advice to connect it or draw to it: it is to be removed, and nothing may send to a Client.
    expect(validateGraph(two)).toEqual(['Too many Clients: client 0 and Mobile. Keep one and remove the other, since one Client stands for all your users.']);
    const three = withNode(two, 'third', 'client', 'Tablet');
    expect(validateGraph(three)).toEqual(['Too many Clients: client 0, Mobile and Tablet. Keep one and remove the others, since one Client stands for all your users.']);
    // The first Client still gets its own advice when it calls nothing.
    const unconnected = withNode(chainGraph(['client']), 'other', 'client', 'Mobile');
    expect(validateGraph(unconnected)).toEqual([
      'Too many Clients: client 0 and Mobile. Keep one and remove the other, since one Client stands for all your users.',
      "client 0 isn't connected to anything. Draw an arrow from it to the first part users talk to, usually a load balancer.",
    ]);
  });

  it('a Client that calls nothing', () => {
    expect(validateGraph(chainGraph(['client']))).toEqual(["client 0 isn't connected to anything. Draw an arrow from it to the first part users talk to, usually a load balancer."]);
  });

  it('a Client calling two parts', () => {
    const g = withEdge(withNode(chainGraph(['client', 'server']), 's2', 'server'), 'n0', 's2');
    expect(validateGraph(g)).toEqual(['client 0 sends to 2 parts: server 1 and s2. A Client sends to one part, so keep one arrow, or put a load balancer in front of them.']);
  });

  it('a queue handing its messages to two parts', () => {
    const g = withEdge(withNode(chainGraph(['client', 'queue', 'server']), 's2', 'server'), 'n1', 's2');
    expect(validateGraph(g)).toEqual(['queue 1 passes messages to 2 parts: server 2 and s2. A queue passes each message to one part, so keep one arrow, or add a queue for each.']);
  });

  it('a queue that hands its messages to nothing', () => {
    expect(validateGraph(chainGraph(['client', 'queue']))).toEqual(["queue 1 doesn't pass its messages on. Draw an arrow from it to the part that should work through them."]);
  });

  it('a load balancer over nothing', () => {
    expect(validateGraph(chainGraph(['client', 'loadBalancer']))).toEqual(['loadBalancer 1 has nothing to send requests to. Draw an arrow from it to an app server.']);
  });

  it("a load balancer's arrow with a 0% share", () => {
    const g = branchedGraph();
    const zero = { ...g, edges: g.edges.map((e) => (e.id === 'lb--s2' ? { ...e, call: { ...e.call, share: 0 } } : e)) };
    expect(validateGraph(zero)).toEqual(['lb sends 0% of its traffic to s2. Select that arrow and give it a share above 0%, or remove it.']);
    const negative = { ...g, edges: g.edges.map((e) => (e.id === 'lb--s2' ? { ...e, call: { ...e.call, share: -0.2 } } : e)) };
    expect(validateGraph(negative)).toEqual(["The share of traffic from lb to s2 isn't a number above 0. Select that arrow and give it a share above 0%, or remove it."]);
    const nan = { ...g, edges: g.edges.map((e) => (e.id === 'lb--s2' ? { ...e, call: { ...e.call, share: NaN } } : e)) };
    expect(validateGraph(nan)).toHaveLength(1);
  });

  it('two caches for one server', () => {
    const two = withEdge(withNode(chainGraph(['client', 'server', 'database'], 1), 'c2', 'cache'), 'n1', 'c2');
    expect(validateGraph(two)).toContain('server 1 uses 2 caches: cache and c2. An app server can use only one cache, so keep one arrow.');
  });

  it('a cache with nothing behind it', () => {
    expect(validateGraph(chainGraph(['client', 'server'], 1))).toEqual([
      "server 1 has a cache but nothing behind it. Draw an arrow from server 1 to a database, for when the cache doesn't have the answer.",
    ]);
  });

  it('a call that makes no sense (here: a database calling an app server, and anything calling the Client)', () => {
    const g = chainGraph(['client', 'server', 'database']);
    expect(validateGraph(withEdge(g, 'n2', 'n1'))).toContain(
      "database 2 can't send requests to server 1: a database only answers requests; it doesn't send any. Remove that arrow.",
    );
    expect(validateGraph(withEdge(g, 'n1', 'n0'))).toContain("server 1 can't send requests to client 0: the Client is where requests start, so nothing sends to it. Remove that arrow.");
  });

  it('an arrow to, from or between parts that are gone', () => {
    const g = chainGraph(['client', 'server', 'database']);
    expect(validateGraph(withEdge(g, 'n2', 'ghost'))).toContain('database 2 has an arrow to a part that no longer exists. Remove database 2 and add it again.');
    expect(validateGraph(withEdge(g, 'ghost', 'n2'))).toContain('database 2 has an arrow from a part that no longer exists. Remove database 2 and add it again.');
    expect(validateGraph(withEdge(g, 'ghost', 'ghost2'))).toContain(
      'An arrow joins two parts that no longer exist. Press Clear and draw the system again, or start from the example.',
    );
  });

  it('the same call drawn twice', () => {
    const g = chainGraph(['client', 'server', 'database']);
    expect(validateGraph({ ...g, edges: [...g.edges, { ...g.edges[1], id: 'again' }] })).toEqual(['There are two arrows from server 1 to database 2. Remove one of them.']);
  });

  it('a loop, naming blank parts by their kind', () => {
    const loop = withEdge(withEdge(withNode(chainGraph(['client', 'server']), 's2', 'server'), 'n1', 's2'), 's2', 'n1');
    expect(validateGraph(loop)).toContain('These arrows go round in a loop: server 1 → s2 → server 1. Remove one, for example the arrow from s2 to server 1.');
    const blank = { ...loop, nodes: loop.nodes.map((n) => (n.id === 's2' ? { ...n, label: ' ' } : n)) };
    expect(validateGraph(blank)).toContain('These arrows go round in a loop: server 1 → App server → server 1. Remove one, for example the arrow from App server to server 1.');
  });

  it('a part the Client never reaches', () => {
    expect(validateGraph(withNode(chainGraph(['client', 'server', 'database']), 'spare', 'server'))).toEqual([
      'Nothing sends requests to spare. Draw an arrow to it from the part before it, or remove it.',
    ]);
    // While the Client calls nothing, that is the one problem to fix (not one "nothing sends" per part).
    expect(validateGraph(withNode(chainGraph(['client']), 'spare', 'server'))).toEqual([
      "client 0 isn't connected to anything. Draw an arrow from it to the first part users talk to, usually a load balancer.",
    ]);
  });

  it('a part without a name, and two parts with the same name', () => {
    const g = chainGraph(['client', 'server', 'server', 'database']);
    const named = (a: string, b: string) => ({ ...g, nodes: g.nodes.map((n) => (n.id === 'n1' ? { ...n, label: a } : n.id === 'n2' ? { ...n, label: b } : n)) });
    expect(validateGraph(named('  ', 'API'))).toEqual(['An app server has no name. Select it and type one in Name.']);
    // One problem per clash, naming each spelling.
    expect(validateGraph(named('API', 'api '))).toEqual(['Two parts have the same name: "API" and "api". Give each its own name.']);
    expect(validateGraph(named('API', 'API'))).toEqual(['Two parts are called "API". Give each its own name.']);
    const three = { ...named('API', 'API'), nodes: named('API', 'API').nodes.map((n) => (n.id === 'n3' ? { ...n, label: 'Api' } : n)) };
    expect(validateGraph(three)).toEqual(['3 parts have the same name: "API" and "Api". Give each its own name.']);
  });

  it('settings that cannot be simulated', () => {
    const g = chainGraph(['client', 'server', 'queue', 'database'], 1);
    expect(validateGraph(set(g, 'n0', { rps: 0 }))).toEqual(['client 0\'s "Requests per second" must be above 0. Select client 0 and change it.']);
    expect(validateGraph(set(g, 'n1', { service: { medianMs: 5, p99Ms: 5 } }))).toEqual([
      'server 1\'s slowest 1% must take longer than its typical time. Select server 1 and raise "Slowest 1% take" above 5 ms.',
    ]);
    expect(validateGraph(set(g, 'n1', { service: { medianMs: 0, p99Ms: 5 } }))).toEqual(["server 1's typical time must be above 0 ms. Select server 1 and change it."]);
    expect(validateGraph(set(g, 'n1', { instances: 1.5, workersPerInstance: 0, coresPerInstance: -1 }))).toEqual([
      'server 1\'s "Copies (instances)" must be a whole number above 0. Select server 1 and change it.',
      'server 1\'s "Requests each copy handles at once" must be a whole number above 0. Select server 1 and change it.',
      'server 1\'s "CPU cores per copy" must be a whole number above 0. Select server 1 and change it.',
    ]);
    expect(validateGraph(set(g, 'n2', { maxDepth: 0, consumers: -1 }))).toEqual([
      'queue 2\'s "Messages it can hold" must be a whole number above 0. Select queue 2 and change it.',
      'queue 2\'s "Messages handled at once (consumers)" must be a whole number above 0. Select queue 2 and change it.',
    ]);
    expect(validateGraph(set(g, 'c', { capacity: 0, keys: 0 }))).toEqual([
      'cache\'s "Keys it can hold" must be a whole number above 0. Select cache and change it.',
      'cache\'s "Different keys requested" must be a whole number above 0. Select cache and change it.',
    ]);
    expect(validateGraph(set(g, 'n1', { fanOut: 'split' }))).toEqual(['server 1 doesn\'t say how it calls its parts. Select server 1 and choose under "Calls its parts".']);
    // A load balancer or database has no such choice (it is never compiled), so it is not a problem.
    expect(validateGraph(set(g, 'n3', { fanOut: 'split' }))).toEqual([]);
  });

  it("everything else the engine would refuse (code review 3, finding 5), so a graph without problems always runs", () => {
    const g = chainGraph(['client', 'server', 'database'], 1);
    const call = (patch: object) => ({ ...g, edges: g.edges.map((e) => (e.id === 'e1' ? { ...e, call: { ...e.call, ...patch } } : e)) });
    expect(validateGraph(call({ timeoutMs: 0 }))).toEqual(['The arrow from server 1 to database 2 needs a timeout above 0 ms. Select it and change "Timeout", or untick "Give up after a timeout".']);
    expect(validateGraph(call({ timeoutMs: null }))).toEqual([]);
    expect(validateGraph(call({ retries: -1 }))).toEqual(['The arrow from server 1 to database 2 needs a whole number of retries, from 0 to 10. Select it and change "Retries".']);
    expect(validateGraph(call({ retries: 1.5 }))).toHaveLength(1);
    expect(validateGraph(call({ retries: 11 }))).toHaveLength(1);
    expect(validateGraph(call({ backoffBaseMs: -5 }))).toEqual(['The arrow from server 1 to database 2 needs a wait before retrying of 0 ms or more. Select it and change "Wait before retrying".']);
    expect(validateGraph(set(g, 'n0', { rps: Infinity }))).toHaveLength(1);
    expect(validateGraph(set(g, 'n1', { service: { medianMs: 4, p99Ms: Infinity } }))).toHaveLength(1);
    expect(validateGraph(set(g, 'c', { ttlMs: 0 }))).toEqual(['cache\'s "Expire after" must be above 0 s. Select cache and change it, or untick "Entries expire".']);
    expect(validateGraph(set(g, 'c', { ttlMs: null }))).toEqual([]);
    expect(validateGraph(set(g, 'c', { skew: -1 }))).toEqual(['cache\'s "Popularity skew" must be 0 or more. Select cache and change it.']);
    expect(validateGraph(set(g, 'n1', { queueLimit: -5 }))).toEqual([
      'server 1\'s "Requests allowed to wait, per copy" must be a whole number, 0 or more. Select server 1 and change it, or untick "Limit the waiting line".',
    ]);
    expect(validateGraph(set(g, 'n1', { queueLimit: 0 }))).toEqual([]);
    const twin = { ...g, nodes: [...g.nodes, { ...g.nodes[2], label: 'other', col: 9, row: 3 }] };
    expect(validateGraph(twin)).toContain('This saved drawing is damaged: two parts are mixed up. Press Clear and draw it again, or start from the example.');
  });

  it('keeps every message short: at most two sentences, and no internal ids or "reached"', () => {
    const g = chainGraph(['client', 'server', 'queue', 'database'], 1);
    const graphs = [
      { nodes: [], edges: [] },
      withNode(chainGraph(['client', 'server']), 'other', 'client', 'Mobile'),
      withEdge(withNode(chainGraph(['client', 'server']), 's2', 'server'), 'n0', 's2'),
      withNode(chainGraph(['client', 'loadBalancer']), 'spare', 'server'),
      withEdge(chainGraph(['client', 'server', 'database']), 'n2', 'n1'),
      chainGraph(['client', 'queue']),
      set(g, 'n1', { instances: 0, service: { medianMs: 5, p99Ms: 5 }, queueLimit: -1, fanOut: 'x' }),
    ];
    for (const text of graphs.flatMap(validateGraph)) {
      // Sentences end in ". " (not inside "0.5" or quotes).
      expect(text.split(/[.!?] (?=[A-Z"])/).length, text).toBeLessThanOrEqual(2);
      expect(text, text).not.toMatch(/reached|handle|Calls…|\bn\d\b/);
    }
  });
});

describe('findProblems: what each problem is about, and how serious it is', () => {
  it('marks steps still to take as unfinished, naming the box', () => {
    expect(findProblems({ nodes: [], edges: [] })).toEqual([{ text: expect.any(String), severity: 'unfinished', nodes: [], edges: [] }]);
    expect(findProblems(chainGraph(['client']))).toEqual([{ text: expect.any(String), severity: 'unfinished', nodes: ['n0'], edges: [], drawArrow: true }]);
    expect(findProblems(withNode(chainGraph(['client', 'server', 'database']), 'spare', 'server'))).toMatchObject([{ severity: 'unfinished', nodes: ['spare'], edges: [], drawArrow: true }]);
    expect(findProblems(chainGraph(['client', 'server'], 1))).toMatchObject([{ severity: 'unfinished', nodes: ['n1'], drawArrow: true }]);
  });

  it('marks what is drawn or set wrong, naming the arrows and boxes involved', () => {
    const loop = withEdge(withEdge(withNode(chainGraph(['client', 'server']), 's2', 'server'), 'n1', 's2'), 's2', 'n1');
    expect(findProblems(loop)).toMatchObject([{ severity: 'wrong', nodes: [], edges: ['n1-s2', 's2-n1'] }]);
    const twoCalls = withEdge(withNode(chainGraph(['client', 'server']), 's2', 'server'), 'n0', 's2');
    expect(findProblems(twoCalls)).toMatchObject([{ severity: 'wrong', nodes: ['n0'], edges: ['e0', 'n0-s2'] }]);
    const g = chainGraph(['client', 'server', 'database']);
    expect(findProblems({ ...g, edges: [...g.edges, { ...g.edges[1], id: 'again' }] })).toMatchObject([{ severity: 'wrong', edges: ['e1', 'again'] }]);
    expect(findProblems(set(g, 'n1', { instances: 0 }))).toMatchObject([{ severity: 'wrong', nodes: ['n1'], edges: [] }]);
    const named = { ...g, nodes: g.nodes.map((n) => (n.id !== 'n0' ? { ...n, label: 'API' } : n)) };
    expect(findProblems(named)).toMatchObject([{ severity: 'wrong', nodes: ['n1', 'n2'] }]);
  });
});
