/**
 * End to end: a branched system drawn on the canvas, compiled, simulated by the engine and shown on
 * the diagram (needs the engine's branching: split, sequence and shared parts).
 */
import { branchedGraph } from '../builder/testGraphs';
import { buildRunConfig } from '../data/buildConfig';
import { runSimulation } from '../engine/run';
import { customSystem } from './system';
import { callWeights, topologyView } from './viewModels';

describe('a branched built system, simulated and drawn', { timeout: 60_000 }, () => {
  const system = customSystem(branchedGraph());
  if (system.kind !== 'custom') throw new Error('expected a built system');
  const scenario = system.scenarios.find((s) => s.id === 'custom-db-slow')!;
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
    const empty = { ...run, tiers: Object.fromEntries(Object.entries(run.tiers).map(([id, t]) => [id, { ...t, arrivalsFirst: t.arrivalsFirst.map(() => 0), arrivalsRetry: t.arrivalsRetry.map(() => 0), ok: t.ok.map(() => 0) }])) };
    expect(callWeights(config, empty, 5, calls)).toEqual([0.5, 0.5]);
  });
});
