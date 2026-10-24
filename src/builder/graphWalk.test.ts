import { webChain } from '../data/topologies';
import { compileGraph } from './compile';
import { cacheCall, flowCallers, flowCalls, longestDepths, trafficShares } from './graphWalk';
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

  it('traffic shares: splits multiply, one-after-another and all-at-once calls each get the whole share', () => {
    expect(trafficShares(webChain)).toEqual({ gateway: 1, api: 1, cache: 1, db: 1 });
    const t = compileGraph(branchedGraph());
    const s = trafficShares(t);
    expect(s.lb).toBe(1);
    for (const id of ['s1', 's2', 's3', 'cache', 'queue', 'db2']) expect(s[id]).toBeCloseTo(1 / 3);
    expect(s.db1).toBeCloseTo(2 / 3);
    // Uneven shares are normalised; a server calling two parts sends each all of its requests.
    t.tiers[0].downstream!.share = 2;
    t.tiers[0].moreDownstream![0].share = 1;
    t.tiers[0].moreDownstream![1].share = 1;
    const s3 = t.tiers.find((x) => x.id === 's3')!;
    s3.moreDownstream = [{ ...s3.downstream!, target: 'db1' }];
    s3.fanOut = 'parallel';
    const uneven = trafficShares(t);
    expect(uneven.s1).toBeCloseTo(0.5);
    expect(uneven.s3).toBeCloseTo(0.25);
    expect(uneven.db1).toBeCloseTo(0.5 + 0.25 + 0.25);
    expect(uneven.queue).toBeCloseTo(0.25);
    // Shares that add up to nothing split evenly; nonsense shares count as 1.
    t.tiers[0].downstream!.share = 0;
    t.tiers[0].moreDownstream![0].share = 0;
    t.tiers[0].moreDownstream![1].share = 0;
    expect(trafficShares(t).s1).toBeCloseTo(1 / 3);
    t.tiers[0].downstream!.share = NaN;
    expect(trafficShares(t).s1).toBe(1);
  });
});
