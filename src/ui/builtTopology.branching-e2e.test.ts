/**
 * End to end: a branched system drawn on the canvas, compiled, simulated by the engine and shown on
 * the diagram (needs the engine's branching: split, sequence and shared parts).
 */
import { analyzed } from '../analysis/testRuns';
import { buildStory } from '../analysis/story';
import { defaultCall, defaultSettings, type ComponentKind } from '../builder/graph';
import { branchedGraph } from '../builder/testGraphs';
import { buildRunConfig } from '../data/buildConfig';
import { runSimulation } from '../engine/run';
import { customSystem } from './system';
import { callWeights, topologyView } from './viewModels';
import { findScenario } from '../builder/scenarios';

describe('a branched built system, simulated and drawn', { timeout: 60_000 }, () => {
  const system = customSystem(branchedGraph());
  if (system.kind !== 'custom') throw new Error('expected a built system');
  const scenario = findScenario(system.scenarios, 'custom-db-slow')!;
  const config = buildRunConfig(system.topology, scenario);
  const run = runSimulation(config);
  const at = (tMs: number) => topologyView(system.topology, config, run, tMs);

  it("the load balancer splits evenly: about a third of the users' traffic to each server, routed above and below", () => {
    const { edges } = at(10_000);
    const rps = (id: string) => edges.find((e) => e.id === id)!.rps;
    const total = rps('lb-s1') + rps('lb-s2') + rps('lb-s3');
    for (const id of ['lb-s1', 'lb-s2', 'lb-s3']) expect(rps(id) / total).toBeGreaterThan(0.2);
    expect(edges.find((e) => e.id === 'lb-s1')).toMatchObject({ orientation: 'routed', route: { trunk: 'source', text: 'above' } });
    expect(edges.find((e) => e.id === 'lb-s2')).toMatchObject({ orientation: 'horizontal', clearStart: true });
    expect(edges.find((e) => e.id === 'lb-s3')).toMatchObject({ orientation: 'routed', route: { trunk: 'source', text: 'below' } });
  });

  it("a shared database's arrivals are divided between its two arrows, and both arrows are drawn", () => {
    const { edges, nodes } = at(10_000);
    const db = nodes.find((n) => n.id === 'db1')!;
    const into = edges.filter((e) => e.to === 'db1');
    expect(into.map((e) => e.id).sort()).toEqual(['s1-db1', 's2-db1']);
    expect(into.reduce((a, e) => a + e.rps, 0)).toBeCloseTo(db.rps!, 5);
    // s1 has a cache, so it sends the database less than s2 does.
    expect(into.find((e) => e.id === 's1-db1')!.rps).toBeLessThan(into.find((e) => e.id === 's2-db1')!.rps);
    expect(into.find((e) => e.id === 's2-db1')).toMatchObject({ orientation: 'routed', route: { trunk: 'target' } });
    // The queue's work reaches the second database.
    expect(edges.find((e) => e.id === 'queue-db2')!.rps).toBeGreaterThan(0);
  });

  it('splits by the traffic shares when nothing arrived', () => {
    const calls = [
      { from: 's1', to: 'db1', cache: false },
      { from: 's2', to: 'db1', cache: false },
    ];
    const zero = (xs: number[]) => xs.map(() => 0);
    const calls0 = (t: (typeof run.tiers)[string]) => t.calls?.map((c) => ({ ...c, first: zero(c.first), retries: zero(c.retries) }));
    const empty = { ...run, tiers: Object.fromEntries(Object.entries(run.tiers).map(([id, t]) => [id, { ...t, arrivalsFirst: zero(t.arrivalsFirst), arrivalsRetry: zero(t.arrivalsRetry), ok: zero(t.ok), calls: calls0(t) }])) };
    expect(callWeights(config, empty, 5, calls)).toEqual([0.5, 0.5]);
  });
});

/**
 * Reported by the user: App server calls Database, then App server 2, which calls Database 2.
 * Database 2 slowing makes everyone in front ask again, and every repeat reaches Database first
 * (the app server calls it first), so Database is what gets overloaded, while App server 2 then
 * gets nothing. The story must name the database the diagram shows overloaded.
 */
describe('a server calling a database and then a second server (user report)', { timeout: 60_000 }, () => {
  const node = (id: string, kind: ComponentKind, label: string, col: number) => ({ id, label, col, row: 3, settings: defaultSettings(kind) });
  const nodes = [node('client-1', 'client', 'Client', 1), node('server-1', 'server', 'App server', 3), node('database-1', 'database', 'Database', 5), node('server-2', 'server', 'App server 2', 7), node('database-2', 'database', 'Database 2', 9)];
  const kindOf = (id: string) => nodes.find((n) => n.id === id)!.settings.kind;
  const edge = (from: string, to: string) => ({ id: `${from}--${to}`, from, to, call: defaultCall(kindOf(from), kindOf(to)) });
  const system = customSystem({ nodes, edges: [edge('client-1', 'server-1'), edge('server-1', 'database-1'), edge('server-1', 'server-2'), edge('server-2', 'database-2')] });
  if (system.kind !== 'custom') throw new Error('expected a built system');
  const scenario = system.scenarios.find((s) => s.faults.some((f) => f.tier === 'database-2'))!;
  const { config, run, analysis } = analyzed(buildRunConfig(system.topology, scenario));
  const labels = Object.fromEntries(Object.entries(system.topology.layout).map(([id, l]) => [id, l.label]));
  const story = buildStory(run, config, analysis, labels);

  it('slows Database 2, and tells Database (called first) as the overloaded part, as the diagram does', () => {
    expect(config.faults).toEqual([expect.objectContaining({ tier: 'database-2', kind: 'slow' })]);
    const overload = story.find((s) => s.kind === 'overload');
    expect(overload?.headline).toBe('Database overloaded');
    expect(overload?.text).toMatch(/Retries land on it too, not only on Database 2\.$/);
    const verdict = story.find((s) => s.kind === 'stuck')!;
    expect(verdict.text).not.toMatch(/Database 2 getting/);
  });
});
