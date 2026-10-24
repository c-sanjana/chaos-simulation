import { compileGraph } from './compile';
import { defaultCall, defaultSettings, type BuilderGraph, type ComponentKind } from './graph';
import { branchedGraph, chainGraph } from './testGraphs';
import { validateGraph } from './validate';

const withNode = (g: BuilderGraph, id: string, kind: ComponentKind, label = id): BuilderGraph => ({
  ...g,
  nodes: [...g.nodes, { id, label, col: 9, row: 5, settings: defaultSettings(kind) }],
});
const withEdge = (g: BuilderGraph, from: string, to: string): BuilderGraph => ({ ...g, edges: [...g.edges, { id: `${from}-${to}`, from, to, call: defaultCall('server', 'server') }] });
const set = (g: BuilderGraph, id: string, patch: object) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, settings: { ...n.settings, ...patch } } : n)) }) as BuilderGraph;

const HOW = 'drag from its round handle to that part, or select it and use Calls… and Connect';

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

describe('validateGraph: each message names the parts, says why, and how to fix it', () => {
  it('no Client', () => {
    expect(validateGraph({ nodes: [], edges: [] })).toEqual([
      'There is no Client, so no requests would be sent. Drag a Client from the list above onto the canvas (or press its Add button), then connect it to the part users call first.',
    ]);
  });

  it('two Clients', () => {
    const two = withNode(chainGraph(['client', 'server']), 'other', 'client', 'Mobile');
    expect(validateGraph(two)).toContain(
      'There are 2 Clients (client 0 and Mobile), but one Client stands for all your users, and the traffic is set on it. Keep one: select each of the others and press its Remove button.',
    );
  });

  it('a Client that calls nothing', () => {
    expect(validateGraph(chainGraph(['client']))).toEqual([`client 0 calls nothing, so no request would reach your system. Connect it to the part users call first (usually a load balancer): ${HOW}.`]);
  });

  it('a Client calling two parts', () => {
    const g = withEdge(withNode(chainGraph(['client', 'server']), 's2', 'server'), 'n0', 's2');
    expect(validateGraph(g)).toEqual([
      'client 0 sends to server 1 and s2, but the Client stands for users calling one front door, so it calls one part. Keep one of these arrows and remove the others (select an arrow and press Remove this call); to spread users over several parts, put a load balancer between client 0 and them.',
    ]);
  });

  it('a queue handing its messages to two parts', () => {
    const g = withEdge(withNode(chainGraph(['client', 'queue', 'server']), 's2', 'server'), 'n1', 's2');
    expect(validateGraph(g)).toEqual([
      "queue 1 hands its messages to server 2 and s2, but a queue's consumers pass each message to exactly one part. Keep one of these arrows and remove the others (select an arrow and press Remove this call); to feed several parts, give each its own queue.",
    ]);
  });

  it('a queue that hands its messages to nothing', () => {
    expect(validateGraph(chainGraph(['client', 'queue']))).toEqual([`queue 1 holds work, but nothing does it, so its messages would pile up forever. Connect it to the part its consumers call: ${HOW}.`]);
  });

  it('a load balancer over nothing', () => {
    expect(validateGraph(chainGraph(['client', 'loadBalancer']))).toEqual([`loadBalancer 1 spreads requests, but over nothing, so every request would fail there. Connect it to the app servers behind it: ${HOW}.`]);
  });

  it("a load balancer's arrow with a 0% share", () => {
    const g = branchedGraph();
    const zero = { ...g, edges: g.edges.map((e) => (e.id === 'lb--s2' ? { ...e, call: { ...e.call, share: 0 } } : e)) };
    expect(validateGraph(zero)).toEqual(['lb sends no traffic to s2 (its share is 0%), so s2 would sit idle. Select the arrow from lb to s2 and give it a share of traffic above 0%, or press Remove this call.']);
    const nan = { ...g, edges: g.edges.map((e) => (e.id === 'lb--s2' ? { ...e, call: { ...e.call, share: NaN } } : e)) };
    expect(validateGraph(nan)).toHaveLength(1);
  });

  it('two caches for one server', () => {
    const two = withEdge(withNode(chainGraph(['client', 'server', 'database'], 1), 'c2', 'cache'), 'n1', 'c2');
    expect(validateGraph(two)).toContain(
      'server 1 looks things up in 2 caches (cache and c2), but an app server checks one cache before asking the next part. Keep one: select the arrow from server 1 to each of the others and press Remove this call.',
    );
  });

  it('a cache with nothing behind it', () => {
    expect(validateGraph(chainGraph(['client', 'server'], 1))).toEqual([
      `server 1 has a cache but nothing to ask when the cache doesn't have the answer, so those requests could never be answered. Connect server 1 to a database or another part: ${HOW}.`,
    ]);
  });

  it('a call that makes no sense (here: a database calling an app server, and anything calling the Client)', () => {
    const g = chainGraph(['client', 'server', 'database']);
    expect(validateGraph(withEdge(g, 'n2', 'n1'))).toContain(
      "database 2 can't call server 1: A database only answers calls; it doesn't call other components. Select the arrow from database 2 to server 1 and press Remove this call.",
    );
    expect(validateGraph(withEdge(g, 'n1', 'n0'))).toContain(
      "server 1 can't call client 0: Nothing calls the Client: it is where requests start. Select the arrow from server 1 to client 0 and press Remove this call.",
    );
  });

  it('an arrow to, from or between parts that are gone', () => {
    const g = chainGraph(['client', 'server', 'database']);
    expect(validateGraph(withEdge(g, 'n2', 'ghost'))).toContain(
      'database 2 calls a part that is no longer on the canvas, so that call cannot be simulated. Select database 2, press its Remove button (its arrows go with it), and add it again.',
    );
    expect(validateGraph(withEdge(g, 'ghost', 'n2'))).toContain(
      'database 2 is called by a part that is no longer on the canvas, so that call cannot be simulated. Select database 2, press its Remove button (its arrows go with it), and add it again.',
    );
    expect(validateGraph(withEdge(g, 'ghost', 'ghost2'))).toContain(
      'An arrow joins two parts that are no longer on the canvas, so it cannot be simulated. Press Clear and draw the system again, or Start from the example.',
    );
  });

  it('the same call drawn twice', () => {
    const g = chainGraph(['client', 'server', 'database']);
    expect(validateGraph({ ...g, edges: [...g.edges, { ...g.edges[1], id: 'again' }] })).toEqual([
      'server 1 calls database 2 twice, so it is unclear which timeout and retries to use. Select one of the two arrows from server 1 to database 2 and press Remove this call.',
    ]);
  });

  it('a loop, naming blank parts by their kind', () => {
    const loop = withEdge(withEdge(withNode(chainGraph(['client', 'server']), 's2', 'server'), 'n1', 's2'), 's2', 'n1');
    expect(validateGraph(loop)).toContain(
      'These call each other in a loop: server 1 → s2 → server 1. A request would go round forever and never be answered. Remove one of these calls: for example, select the arrow from s2 to server 1 and press Remove this call.',
    );
    const blank = { ...loop, nodes: loop.nodes.map((n) => (n.id === 's2' ? { ...n, label: ' ' } : n)) };
    expect(validateGraph(blank)).toContain(
      'These call each other in a loop: server 1 → App server → server 1. A request would go round forever and never be answered. Remove one of these calls: for example, select the arrow from App server to server 1 and press Remove this call.',
    );
  });

  it('a part the Client never reaches', () => {
    expect(validateGraph(withNode(chainGraph(['client', 'server', 'database']), 'spare', 'server'))).toEqual([
      "spare isn't reached from the Client, so no request would ever get to it. Connect a part that is reached to spare (drag from that part's round handle to spare), or select spare and press Remove spare.",
    ]);
  });

  it('a part without a name, and two parts with the same name', () => {
    const g = chainGraph(['client', 'server', 'server', 'database']);
    const named = (a: string, b: string) => ({ ...g, nodes: g.nodes.map((n) => (n.id === 'n1' ? { ...n, label: a } : n.id === 'n2' ? { ...n, label: b } : n)) });
    expect(validateGraph(named('  ', 'API'))).toEqual(['An app server has no name, and the story and charts name each part. Select it and type a name in Name.']);
    expect(validateGraph(named('API', 'api '))).toEqual([
      'Two parts are called "API", so the story and charts couldn\'t tell them apart. Select one and change its Name.',
      'Two parts are called "api", so the story and charts couldn\'t tell them apart. Select one and change its Name.',
    ]);
  });

  it('settings that cannot be simulated', () => {
    const g = chainGraph(['client', 'server', 'queue', 'database'], 1);
    expect(validateGraph(set(g, 'n0', { rps: 0 }))).toEqual(['client 0: "Requests per second" must be above 0, or no requests would be sent. Select client 0 and change it in its settings.']);
    expect(validateGraph(set(g, 'n1', { service: { medianMs: 5, p99Ms: 5 } }))).toEqual([
      'server 1: the slowest 1% of requests must take longer than a typical one, or the times can\'t be simulated. Select server 1 and raise "Slowest 1% take" above 5 ms.',
    ]);
    expect(validateGraph(set(g, 'n1', { service: { medianMs: 0, p99Ms: 5 } }))).toEqual(['server 1: the typical time must be above 0 ms: every request takes some time. Select server 1 and change it in its settings.']);
    expect(validateGraph(set(g, 'n1', { instances: 1.5, workersPerInstance: 0, coresPerInstance: -1 }))).toEqual([
      'server 1: "Copies (instances)" must be a whole number above 0 to be simulated. Select server 1 and change it in its settings.',
      'server 1: "Requests each copy handles at once" must be a whole number above 0 to be simulated. Select server 1 and change it in its settings.',
      'server 1: "CPU cores per copy" must be a whole number above 0 to be simulated. Select server 1 and change it in its settings.',
    ]);
    expect(validateGraph(set(g, 'n2', { maxDepth: 0, consumers: -1 }))).toEqual([
      'queue 2: "Messages it can hold" must be a whole number above 0 to be simulated. Select queue 2 and change it in its settings.',
      'queue 2: "Messages handled at once (consumers)" must be a whole number above 0 to be simulated. Select queue 2 and change it in its settings.',
    ]);
    expect(validateGraph(set(g, 'c', { capacity: 0, keys: 0 }))).toEqual([
      'cache: "Keys it can hold" must be a whole number above 0 to be simulated. Select cache and change it in its settings.',
      'cache: "Different keys requested" must be a whole number above 0 to be simulated. Select cache and change it in its settings.',
    ]);
    expect(validateGraph(set(g, 'n1', { fanOut: 'split' }))).toEqual(['server 1: it is not set whether it calls its parts one after another or all at once. Select server 1 and choose under "Calls its parts".']);
  });
});
