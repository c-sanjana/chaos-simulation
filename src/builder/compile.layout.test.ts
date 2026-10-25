import { buildRunConfig } from '../data/buildConfig';
import { callsOf } from '../engine/config';
import { validateConfig } from '../engine/validate';
import { placeCalls, type CallEnds } from '../ui/edgeRoutes';
import { customSystem } from '../ui/system';
import { compileGraph } from './compile';
import { canConnect, defaultCall, defaultSettings, type BuilderGraph, type ComponentKind } from './graph';
import { validateGraph } from './validate';

/** A small seeded random number generator, so the graphs are the same on every run. */
function random(seed: number) {
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  return { next, pick: <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)] };
}

/**
 * A random drawing (the code review's fuzz): a Client and 2 to 11 parts on random cells, each
 * called by one or two earlier parts that may call it (so no loops). Many are invalid; the test
 * keeps the valid ones.
 */
function randomGraph(rnd: ReturnType<typeof random>): BuilderGraph {
  const kinds: ComponentKind[] = ['client'];
  const n = 3 + Math.floor(rnd.next() * 10);
  for (let i = 1; i < n; i++) kinds.push(rnd.pick<ComponentKind>(['loadBalancer', 'server', 'server', 'database', 'cache', 'queue']));
  const cells = new Set<string>();
  const nodes = kinds.map((kind, i) => {
    let col: number;
    let row: number;
    do {
      col = 1 + Math.floor(rnd.next() * 9);
      row = 1 + Math.floor(rnd.next() * 5);
    } while (cells.has(`${col}:${row}`));
    cells.add(`${col}:${row}`);
    return { id: `${kind}-${i}`, label: `${kind} ${i}`, col, row, settings: defaultSettings(kind) };
  });
  const edges: BuilderGraph['edges'] = [];
  for (let j = 1; j < n; j++) {
    const callers = nodes.slice(0, j).filter((a) => canConnect(a.settings.kind, nodes[j].settings.kind));
    const count = 1 + (rnd.next() < 0.35 ? 1 : 0);
    for (let k = 0; k < count && callers.length; k++) {
      const a = rnd.pick(callers);
      if (edges.some((e) => e.from === a.id && e.to === nodes[j].id)) continue;
      edges.push({ id: `${a.id}--${nodes[j].id}`, from: a.id, to: nodes[j].id, call: defaultCall(a.settings.kind, nodes[j].settings.kind) });
    }
  }
  return { nodes, edges };
}

/** What is wrong with how one valid drawing is laid out and drawn (empty = nothing). */
function layoutFaults(g: BuilderGraph): string[] {
  const faults: string[] = [];
  const t = compileGraph(g);
  const placed = Object.entries(t.layout);
  if (placed.length !== g.nodes.length) faults.push('a part is not on the diagram');
  const boxes = new Map<string, string>();
  for (const [id, p] of placed) {
    if (boxes.has(`${p.col}:${p.row}`)) faults.push(`${id} and ${boxes.get(`${p.col}:${p.row}`)} share a cell`);
    boxes.set(`${p.col}:${p.row}`, id);
  }
  const calls: CallEnds[] = [{ from: 'client', to: t.clientCall.target, cache: false }];
  for (const tier of t.tiers) {
    if (tier.cacheAside) calls.push({ from: tier.id, to: tier.cacheAside.target, cache: true });
    for (const c of callsOf(tier)) calls.push({ from: tier.id, to: c.target, cache: false });
  }
  const places = placeCalls(t.layout, calls);
  calls.forEach((c, i) => {
    const a = t.layout[c.from];
    const b = t.layout[c.to];
    const p = places[i];
    if (!c.cache && !(b.col > a.col)) faults.push(`${c.from} → ${c.to} goes right to left`);
    if (!c.cache && p === null) faults.push(`${c.from} → ${c.to} is not drawn`);
    if (p?.orientation !== 'routed') return;
    // The line's horizontal run: along the caller's row with the bend at the target, else the callee's.
    const row = p.route.trunk === 'target' ? a.row : b.row;
    for (let col = a.col + 1; col < b.col; col++) {
      const hit = boxes.get(`${col}:${row}`);
      if (hit) faults.push(`${c.from} → ${c.to} runs under ${hit}`);
    }
  });
  const texts = new Set<string>();
  places.forEach((p, i) => {
    if (!p) return;
    if (texts.has(`${p.col}:${p.row}`)) faults.push(`${calls[i].from} → ${calls[i].to} puts its text in another arrow's cell`);
    texts.add(`${p.col}:${p.row}`);
  });
  return faults;
}

describe('the diagram of any drawing (1,500 random valid ones)', () => {
  it('places every part on a cell of its own, and draws every call left to right, never under a box or over another arrow\'s text', () => {
    const rnd = random(1);
    const found: string[] = [];
    let valid = 0;
    for (let i = 0; i < 40_000 && valid < 1500; i++) {
      const g = randomGraph(rnd);
      if (validateGraph(g).length > 0) continue;
      valid++;
      found.push(...layoutFaults(g));
      // Every scenario offered runs (validateGraph finding nothing is enough).
      const system = customSystem(g);
      if (system.kind === 'custom') for (const s of system.scenarios) validateConfig(buildRunConfig(system.topology, s));
    }
    expect(valid).toBe(1500);
    expect(found).toEqual([]);
  });
});

describe('a call that skips a box on its row (code review: App server → Queue → Database and App server → Database)', () => {
  const node = (id: string, kind: ComponentKind, col: number, row: number) => ({ id, label: id, col, row, settings: defaultSettings(kind) });
  const nodes = [node('client', 'client', 1, 3), node('app', 'server', 3, 3), node('queue', 'queue', 5, 2), node('db', 'database', 7, 3)];
  const kind = (id: string) => nodes.find((n) => n.id === id)!.settings.kind;
  const edge = (from: string, to: string) => ({ id: `${from}--${to}`, from, to, call: defaultCall(kind(from), kind(to)) });
  const g: BuilderGraph = { nodes, edges: [edge('client', 'app'), edge('app', 'queue'), edge('app', 'db'), edge('queue', 'db')] };

  it('moves the database to a row of its own, so both calls bend into it instead of running under the queue', () => {
    expect(validateGraph(g)).toEqual([]);
    const { layout } = compileGraph(g);
    expect(layout).toMatchObject({ client: { col: 1, row: 3 }, app: { col: 3, row: 3 }, queue: { col: 5, row: 3 }, db: { col: 7, row: 5 } });
    const calls = [call('client', 'app'), call('app', 'queue'), call('app', 'db'), call('queue', 'db')];
    expect(placeCalls(layout, calls)).toEqual([
      { orientation: 'horizontal', col: 2, row: 3 },
      { orientation: 'horizontal', col: 4, row: 3 },
      { orientation: 'routed', col: 6, row: 5, route: { trunk: 'source', text: 'below' } },
      { orientation: 'routed', col: 6, row: 3, route: { trunk: 'target', text: 'above' } },
    ]);
    expect(layoutFaults(g)).toEqual([]);
  });
});

function call(from: string, to: string): CallEnds {
  return { from, to, cache: false };
}
