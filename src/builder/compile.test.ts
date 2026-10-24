import { buildRunConfig } from '../data/buildConfig';
import { cacheRestart, gatewaySlow, retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import { runSimulation } from '../engine/run';
import { compileGraph, CUSTOM_TOPOLOGY_ID } from './compile';
import { graphFromPreset } from './fromPreset';
import { defaultCall } from './graph';
import { chainGraph } from './testGraphs';
import { validateGraph } from './validate';

describe('compileGraph', () => {
  it('the preset drawn on the canvas compiles back to the preset: same tiers, same layout', () => {
    const graph = graphFromPreset(webChain, 200);
    expect(validateGraph(graph)).toEqual([]);
    const compiled = compileGraph(graph, 'Web app with cache');
    expect(compiled.id).toBe(CUSTOM_TOPOLOGY_ID);
    expect(compiled.clientCall).toEqual(webChain.clientCall);
    expect(compiled.tiers).toEqual(webChain.tiers);
    expect(compiled.layout).toEqual(webChain.layout);
  });

  it('…and simulates exactly like the preset on every scenario', { timeout: 60_000 }, () => {
    const compiled = compileGraph(graphFromPreset(webChain, 200));
    for (const scenario of [retryStorm, cacheRestart, gatewaySlow]) {
      const preset = runSimulation(buildRunConfig(webChain, scenario));
      const built = runSimulation(buildRunConfig(compiled, scenario));
      expect(built.client).toEqual(preset.client);
      expect(built.tiers).toEqual(preset.tiers);
    }
  });

  it('lays a chain out left to right with a cache above its server, and maps every setting', () => {
    const graph = chainGraph(['client', 'loadBalancer', 'server', 'queue', 'server', 'database'], 2);
    expect(validateGraph(graph)).toEqual([]);
    const t = compileGraph(graph);
    expect(t.clientCall).toMatchObject({ target: 'n1', timeoutMs: 3000, retries: 2, jitter: true });
    expect(t.tiers.map((x) => x.id)).toEqual(['n1', 'n2', 'c', 'n3', 'n4', 'n5']);
    expect(Object.fromEntries(Object.entries(t.layout).map(([id, l]) => [id, [l.col, l.row]]))).toEqual({
      client: [1, 3],
      n1: [3, 3],
      n2: [5, 3],
      c: [5, 1],
      n3: [7, 3],
      n4: [9, 3],
      n5: [11, 3],
    });
    const [lb, server, cache, queue, , db] = t.tiers;
    expect(lb).toMatchObject({ instances: 2, workersPerInstance: 1024, service: { kind: 'lognormal', medianMs: 0.5, p99Ms: 2 }, downstream: { target: 'n2', timeoutMs: 2000, retries: 1 } });
    expect(server).toMatchObject({ cacheAside: { target: 'c', timeoutMs: 100, retries: 0 }, downstream: { target: 'n3' } });
    expect(cache).toMatchObject({ cache: { capacity: 2000, ttlMs: 60_000, keys: 10_000, skew: 1 }, downstream: null });
    expect(queue).toMatchObject({ queue: { maxDepth: 10_000, consumers: 16 }, downstream: { target: 'n4' } });
    expect(db).toMatchObject({ downstream: null, workersPerInstance: 64 });
    expect(db).not.toHaveProperty('cacheAside');
  });

  it('a cache shared by two servers sits above the first and appears once', () => {
    const graph = chainGraph(['client', 'server', 'server', 'database'], 1);
    graph.edges.push({ id: 'ec2', from: 'n2', to: 'c', call: defaultCall('server', 'cache') });
    const t = compileGraph(graph);
    expect(t.tiers.map((x) => x.id)).toEqual(['n1', 'c', 'n2', 'n3']);
    expect(t.tiers.find((x) => x.id === 'n2')!.cacheAside!.target).toBe('c');
    expect(t.layout.c).toMatchObject({ col: 3, row: 1 });
  });
});
