import { webChain } from '../data/topologies';
import { compileGraph } from './compile';
import { cacheCall, flowCallers, flowCalls, longestDepths } from './graphWalk';
import { sharesOf } from './scenarios';
import { branchedGraph, chainGraph } from './testGraphs';

describe('graph walks', () => {
  it('calls in canvas order (top to bottom), callers, the cache, and the longest distance from the Client', () => {
    const g = branchedGraph();
    expect(flowCalls(g, 'lb').map((e) => e.to)).toEqual(['s1', 's2', 's3']);
    expect(flowCalls(g, 's1').map((e) => e.to)).toEqual(['db1']);
    expect(cacheCall(g, 's1')?.to).toBe('cache');
    expect(cacheCall(g, 's2')).toBeUndefined();
    expect(flowCallers(g, 'db1').sort()).toEqual(['s1', 's2']);
    expect(flowCallers(g, 'cache')).toEqual([]);
    expect(Object.fromEntries(longestDepths(g, 'client'))).toEqual({ client: 0, lb: 1, s1: 2, s2: 2, s3: 2, db1: 3, queue: 3, db2: 4 });
    // A part reached along two paths gets the longer one.
    const g2 = chainGraph(['client', 'server', 'server', 'database']);
    g2.edges.push({ id: 'skip', from: 'n1', to: 'n3', call: g2.edges[2].call });
    expect(longestDepths(g2, 'n0').get('n3')).toBe(3);
  });

  it('traffic shares of a built topology: splits multiply, shared parts add up', () => {
    expect(sharesOf(webChain)).toEqual({ gateway: 1, api: 1, cache: 1, db: 1 });
    const s = sharesOf(compileGraph(branchedGraph()));
    expect(s.lb).toBe(1);
    for (const id of ['s1', 's2', 's3', 'cache', 'queue', 'db2']) expect(s[id]).toBeCloseTo(1 / 3);
    expect(s.db1).toBeCloseTo(2 / 3);
  });
});
