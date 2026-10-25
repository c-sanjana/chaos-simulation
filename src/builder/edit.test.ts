import {
  GRID_COLS,
  GRID_ROWS,
  addCell,
  addNode,
  canConnectNodes,
  connect,
  connectRefusal,
  emptyGraph,
  firstFreeCell,
  inGrid,
  moveNode,
  nearestFreeCell,
  nodeAt,
  removeEdge,
  removeNode,
  starterGraph,
  updateCall,
  updateNode,
} from './edit';
import { canConnect, defaultCall, defaultSettings, type BuilderGraph, type ComponentKind } from './graph';

const KINDS: ComponentKind[] = ['client', 'loadBalancer', 'server', 'cache', 'database', 'queue'];

/** Adds and asserts success, for building fixtures. */
function add(g: BuilderGraph, kind: ComponentKind, col: number, row: number): BuilderGraph {
  const r = addNode(g, kind, col, row);
  expect(r.reason).toBeUndefined();
  return r.graph;
}

/** Every cell filled with servers. */
function fullGraph(): BuilderGraph {
  let g = emptyGraph();
  for (let row = 1; row <= GRID_ROWS; row++) for (let col = 1; col <= GRID_COLS; col++) g = add(g, 'server', col, row);
  return g;
}

describe('grid helpers', () => {
  it('knows which cells are on the grid', () => {
    expect(inGrid(1, 1)).toBe(true);
    expect(inGrid(GRID_COLS, GRID_ROWS)).toBe(true);
    expect(inGrid(0, 1)).toBe(false);
    expect(inGrid(1, GRID_ROWS + 1)).toBe(false);
    expect(inGrid(1.5, 2)).toBe(false);
  });

  it('finds the first free cell in reading order, or null when full', () => {
    expect(firstFreeCell(emptyGraph())).toEqual({ col: 1, row: 1 });
    let g = add(emptyGraph(), 'server', 1, 1);
    g = add(g, 'server', 2, 1);
    expect(firstFreeCell(g)).toEqual({ col: 3, row: 1 });
    expect(firstFreeCell(fullGraph())).toBeNull();
  });

  it('finds the nearest free cell, clamping targets onto the grid', () => {
    const g = add(emptyGraph(), 'server', 5, 3);
    expect(nearestFreeCell(g, 2, 2)).toEqual({ col: 2, row: 2 });
    // (5, 3) is taken; its four neighbours tie, and the earliest in reading order wins.
    expect(nearestFreeCell(g, 5, 3)).toEqual({ col: 5, row: 2 });
    expect(nearestFreeCell(g, -4, 99)).toEqual({ col: 1, row: GRID_ROWS });
    expect(nearestFreeCell(g, 6.4, 1.2)).toEqual({ col: 6, row: 1 }); // fractions round to a cell
    expect(nearestFreeCell(fullGraph(), 1, 1)).toBeNull();
  });

  it('places added boxes one cell apart: right of the selected box, else along the example layout, else anywhere roomy', () => {
    expect(addCell(emptyGraph())).toEqual({ col: 1, row: 3 });
    const g = starterGraph(); // Client 1,3 · LB 3,3 · App server 5,3 · Cache 5,1 · DB 7,3
    expect(addCell(g, 'database-1')).toEqual({ col: 9, row: 3 });
    expect(addCell(g, 'loadBalancer-1')).toEqual({ col: 5, row: 5 }); // 5,3 is taken: below it, so the arrows fan out
    expect(addCell(add(g, 'server', 5, 5), 'loadBalancer-1')).toEqual({ col: 9, row: 3 }); // 5,1 (the cache) and 5,5 taken: the middle row
    expect(addCell(g)).toEqual({ col: 9, row: 3 });
    expect(addCell(g, 'missing')).toEqual({ col: 9, row: 3 });
    // Middle row full: the top row (away from the cache), then the bottom row.
    const middle = add(g, 'queue', 9, 3);
    expect(addCell(middle)).toEqual({ col: 1, row: 1 });
    // No cell with room around it: any empty cell.
    let crowded = emptyGraph();
    for (let row = 1; row <= GRID_ROWS; row += 2) for (let col = 1; col <= GRID_COLS; col += 2) crowded = add(crowded, 'server', col, row);
    expect(addCell(crowded)).toEqual({ col: 2, row: 1 });
    expect(addCell(fullGraph())).toBeNull();
  });

  it('looks up the node at a cell', () => {
    const g = starterGraph();
    expect(nodeAt(g, 5, 3)?.id).toBe('server-1');
    expect(nodeAt(g, 9, 5)).toBeUndefined();
  });
});

describe('addNode', () => {
  it('adds a component with default settings, a unique id and a numbered label', () => {
    const first = addNode(emptyGraph(), 'server', 3, 2);
    expect(first.id).toBe('server-1');
    expect(first.graph.nodes).toEqual([{ id: 'server-1', label: 'App server', col: 3, row: 2, settings: defaultSettings('server') }]);
    const second = addNode(first.graph, 'server', 3, 2);
    expect(second.graph.nodes[1]).toMatchObject({ id: 'server-2', label: 'App server 2', col: 3, row: 1 });
    const third = addNode(second.graph, 'server', 1, 1);
    expect(third.graph.nodes[2]).toMatchObject({ id: 'server-3', label: 'App server 3' });
  });

  it('reuses the lowest free id and label after a removal', () => {
    let g = add(emptyGraph(), 'database', 1, 1);
    g = add(g, 'database', 2, 1);
    g = removeNode(g, 'database-1');
    const r = addNode(g, 'database', 3, 1);
    expect(r.graph.nodes[1]).toMatchObject({ id: 'database-1', label: 'Database' });
  });

  it('does not change its input', () => {
    const g = emptyGraph();
    addNode(g, 'cache', 1, 1);
    expect(g.nodes).toHaveLength(0);
  });

  it('allows only one Client', () => {
    const g = add(emptyGraph(), 'client', 1, 1);
    const r = addNode(g, 'client', 2, 1);
    expect(r.graph).toBe(g);
    expect(r.reason).toMatch(/already a Client/);
    expect(r.id).toBeUndefined();
  });

  it('refuses when the canvas is full', () => {
    const g = fullGraph();
    const r = addNode(g, 'queue', 1, 1);
    expect(r.graph).toBe(g);
    expect(r.reason).toMatch(/canvas is full/);
  });
});

describe('moveNode', () => {
  it('moves to a free cell', () => {
    const r = moveNode(starterGraph(), 'database-1', 9, 3);
    expect(r.reason).toBeUndefined();
    expect(nodeAt(r.graph, 9, 3)?.id).toBe('database-1');
  });

  it('returns the same graph when the cell does not change', () => {
    const g = starterGraph();
    expect(moveNode(g, 'server-1', 5, 3)).toEqual({ graph: g });
  });

  it('refuses taken cells, cells off the grid and unknown ids, with a reason', () => {
    const g = starterGraph();
    expect(moveNode(g, 'server-1', 7, 3)).toEqual({ graph: g, reason: 'That spot is taken by Database.' });
    expect(moveNode(g, 'server-1', 10, 3)).toEqual({ graph: g, reason: 'That is outside the canvas.' });
    expect(moveNode(g, 'nope', 9, 5).reason).toMatch(/no longer exists/);
  });

  it('names a blank-labelled occupant by its kind', () => {
    const g = updateNode(starterGraph(), 'database-1', { label: '  ' });
    expect(moveNode(g, 'server-1', 7, 3).reason).toBe('That spot is taken by Database.');
  });
});

describe('removeNode and removeEdge', () => {
  it('removes a component and every call to or from it', () => {
    const g = removeNode(starterGraph(), 'server-1');
    expect(g.nodes.map((n) => n.id)).toEqual(['client-1', 'loadBalancer-1', 'cache-1', 'database-1']);
    expect(g.edges.map((e) => e.id)).toEqual(['client-1--loadBalancer-1']);
  });

  it('removes one call', () => {
    const g = removeEdge(starterGraph(), 'server-1--cache-1');
    expect(g.edges).toHaveLength(3);
    expect(g.nodes).toHaveLength(5);
  });
});

describe('connect', () => {
  it('adds a call with the default settings for the pair', () => {
    let g = add(emptyGraph(), 'server', 1, 1);
    g = add(g, 'database', 3, 1);
    const r = connect(g, 'server-1', 'database-1');
    expect(r.reason).toBeUndefined();
    expect(r.id).toBe('server-1--database-1');
    expect(r.graph.edges).toEqual([{ id: 'server-1--database-1', from: 'server-1', to: 'database-1', call: defaultCall('server', 'database') }]);
  });

  it('refuses self-calls, duplicates, unknown ids and pairs canConnect rules out', () => {
    const g = starterGraph();
    expect(connect(g, 'server-1', 'server-1')).toEqual({ graph: g, reason: "A box can't have an arrow to itself." });
    expect(connect(g, 'server-1', 'database-1')).toEqual({ graph: g, reason: "There's already an arrow from App server to Database." });
    expect(connect(g, 'server-1', 'ghost').reason).toMatch(/no longer exists/);
    expect(connect(g, 'database-1', 'server-1')).toEqual({ graph: g, reason: "A database only answers requests; it doesn't send any." });
    expect(connect(g, 'loadBalancer-1', 'cache-1').reason).toBe('Only an app server looks things up in a cache.');
  });

  it('names blank-labelled components by their kind in reasons', () => {
    const g = updateNode(updateNode(starterGraph(), 'server-1', { label: '' }), 'database-1', { label: '' });
    expect(connect(g, 'server-1', 'database-1').reason).toBe("There's already an arrow from App server to Database.");
  });

  it('reports whether a connection would work', () => {
    const g = starterGraph();
    expect(canConnectNodes(g, 'loadBalancer-1', 'database-1')).toBe(true);
    expect(canConnectNodes(g, 'cache-1', 'database-1')).toBe(false);
  });
});

describe('connectRefusal', () => {
  it('explains exactly the pairs canConnect rules out', () => {
    for (const from of KINDS) {
      for (const to of KINDS) {
        const why = connectRefusal(from, to);
        expect(why === null).toBe(canConnect(from, to));
      }
    }
  });

  it('words each kind of refusal plainly', () => {
    expect(connectRefusal('server', 'client')).toMatch(/nothing sends to it/);
    expect(connectRefusal('cache', 'database')).toMatch(/A cache only answers requests/);
    expect(connectRefusal('client', 'database')).toMatch(/not straight to a database/);
    expect(connectRefusal('client', 'cache')).toMatch(/not straight to a cache/);
    expect(connectRefusal('queue', 'cache')).toMatch(/Only an app server/);
  });
});

describe('updateNode', () => {
  it('renames without trimming, so names can be typed with spaces', () => {
    const g = updateNode(starterGraph(), 'server-1', { label: 'Web ' });
    expect(g.nodes.find((n) => n.id === 'server-1')?.label).toBe('Web ');
  });

  it('patches settings, merging the service time and ignoring keys the kind lacks', () => {
    const g = updateNode(starterGraph(), 'server-1', { settings: { instances: 8, service: { p99Ms: 50 }, rps: 999, capacity: 1 } });
    const s = g.nodes.find((n) => n.id === 'server-1')!.settings;
    expect(s).toEqual({ ...defaultSettings('server'), instances: 8, service: { medianMs: 4, p99Ms: 50 } });
    expect(g.nodes.find((n) => n.id === 'server-1')!.label).toBe('App server');
  });

  it('never changes the kind, and accepts nulls for "no limit"', () => {
    const patch = { settings: { kind: 'database', queueLimit: null, ttlMs: null } } as never;
    const g = updateNode(updateNode(starterGraph(), 'server-1', patch), 'cache-1', patch);
    expect(g.nodes.find((n) => n.id === 'server-1')!.settings).toMatchObject({ kind: 'server', queueLimit: null });
    expect(g.nodes.find((n) => n.id === 'cache-1')!.settings).toMatchObject({ kind: 'cache', ttlMs: null });
  });

  it('leaves other nodes alone and works with an empty patch', () => {
    const before = starterGraph();
    const g = updateNode(before, 'client-1', {});
    expect(g.nodes).toEqual(before.nodes);
    expect(g.nodes[1]).toBe(before.nodes[1]);
  });
});

describe('updateCall', () => {
  it('patches one call', () => {
    const g = updateCall(starterGraph(), 'server-1--database-1', { retries: 3, timeoutMs: null });
    expect(g.edges.find((e) => e.id === 'server-1--database-1')!.call).toEqual({ ...defaultCall('server', 'database'), retries: 3, timeoutMs: null });
    expect(g.edges.find((e) => e.id === 'client-1--loadBalancer-1')!.call).toEqual(defaultCall('client', 'loadBalancer'));
  });
});

describe('starterGraph', () => {
  it('lays out Client → Load balancer → App server → Database left to right, with the Cache above the App server', () => {
    const g = starterGraph();
    const at = Object.fromEntries(g.nodes.map((n) => [n.label, [n.col, n.row]]));
    expect(at).toEqual({ Client: [1, 3], 'Load balancer': [3, 3], 'App server': [5, 3], Cache: [5, 1], Database: [7, 3] });
    expect(g.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['client-1>loadBalancer-1', 'loadBalancer-1>server-1', 'server-1>cache-1', 'server-1>database-1']);
    for (const e of g.edges) {
      const from = g.nodes.find((n) => n.id === e.from)!.settings.kind;
      const to = g.nodes.find((n) => n.id === e.to)!.settings.kind;
      expect(canConnect(from, to)).toBe(true);
      expect(e.call).toEqual(defaultCall(from, to));
    }
  });

  it('uses ids that addNode and connect would not clash with', () => {
    const r = addNode(starterGraph(), 'server', 9, 5);
    expect(r.id).toBe('server-2');
    expect(connect(r.graph, 'server-2', 'database-1').id).toBe('server-2--database-1');
  });

  it('returns a fresh graph each time', () => {
    expect(starterGraph()).not.toBe(starterGraph());
    expect(starterGraph()).toEqual(starterGraph());
  });
});
