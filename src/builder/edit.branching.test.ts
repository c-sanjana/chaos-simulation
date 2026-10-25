import { connect, editShare, setFanOut, setShare, shareEdit, shareFractions, sharesWith, shareWeight } from './edit';
import { branchedGraph, chainGraph } from './testGraphs';

describe('editing branches', () => {
  it('a load balancer may call several servers, and an app server several parts', () => {
    const g = branchedGraph();
    const more = connect(g, 's2', 'queue');
    expect(more.reason).toBeUndefined();
    expect(connect(more.graph, 's2', 'queue').reason).toBe('s2 already calls queue.');
  });

  it('shares in percent: the other arrows keep their proportions and make up the rest', () => {
    expect(shareFractions([undefined, undefined, 2])).toEqual([0.25, 0.25, 0.5]);
    expect(shareFractions([0, 0])).toEqual([0.5, 0.5]);
    expect(shareWeight(-1)).toBe(1);
    expect(sharesWith([undefined, undefined, undefined], 0, 50)).toEqual([0.5, 0.25, 0.25]);
    expect(sharesWith([1, 3], 1, 60)).toEqual([0.4, 0.6]);
    // Everything was on the edited arrow: the rest is shared evenly.
    expect(sharesWith([1, 0, 0], 0, 40)).toEqual([0.4, 0.3, 0.3]);
    expect(sharesWith([1, 1], 0, 150)).toEqual([1, 0]);
  });

  it('typing 70, then 20, then 10 gives exactly 70/20/10: shares set by hand keep their value while the others make up the rest', () => {
    let pinned: number[] = [];
    let shares: Array<number | undefined> = [undefined, undefined, undefined];
    for (const [index, percent] of [[0, 70], [1, 20], [2, 10]]) {
      const next = shareEdit(shares, index, percent, pinned);
      shares = next.shares;
      pinned = next.pinned;
    }
    expect(shares).toEqual([0.7, 0.2, 0.1]);
    expect(pinned).toEqual([0, 1, 2]);
    // With every other arrow set by hand there is nothing left to make up the rest: they all share it, and the round starts again.
    expect(shareEdit([0.7, 0.2, 0.1], 0, 50, [0, 1, 2])).toEqual({ shares: [0.5, 0.333333, 0.166667], pinned: [0] });
    // Arrows set by hand that already add up to more than is left: the same.
    expect(shareEdit([0.7, 0.2, 0.1], 2, 40, [0])).toEqual({ shares: [0.466667, 0.133333, 0.4], pinned: [2] });
    // Free arrows with nothing left between them share the rest evenly.
    expect(shareEdit([0.5, 0.5, 0, 0], 1, 30, [0])).toEqual({ shares: [0.5, 0.3, 0.1, 0.1], pinned: [0, 1] });
  });

  it('editShare keeps the arrows set by hand by id, and only among the same load balancer', () => {
    const g = branchedGraph();
    let r = editShare(g, 'lb--s1', 70, ['elsewhere']);
    expect(r.pinned).toEqual(['lb--s1']);
    r = editShare(r.graph, 'lb--s2', 20, r.pinned);
    r = editShare(r.graph, 'lb--s3', 10, r.pinned);
    expect(r.graph.edges.filter((e) => e.from === 'lb').map((e) => e.call.share)).toEqual([0.7, 0.2, 0.1]);
    expect(editShare(g, 'nope', 50, ['x'])).toEqual({ graph: g, pinned: ['x'] });
    expect(editShare(g, 's1--db1', 50).graph).toBe(g);
  });

  it("sets one of a load balancer's arrows' share; arrows of a single call are left alone", () => {
    const g = setShare(branchedGraph(), 'lb--s1', 50);
    expect(g.edges.filter((e) => e.from === 'lb').map((e) => e.call.share)).toEqual([0.5, 0.25, 0.25]);
    const chain = chainGraph(['client', 'loadBalancer', 'server']);
    expect(setShare(chain, chain.edges[1].id, 50)).toBe(chain);
    expect(setShare(chain, 'nope', 50)).toBe(chain);
  });

  it('a new arrow from a load balancer whose shares were set gets an even share; the others keep their proportions', () => {
    const lbShares = (graph: ReturnType<typeof branchedGraph>) => graph.edges.filter((e) => e.from === 'lb').map((e) => [e.to, e.call.share]);
    let g = setShare(branchedGraph(), 'lb--s1', 50);
    g = { ...g, nodes: [...g.nodes, { ...g.nodes.find((n) => n.id === 's3')!, id: 's4', label: 's4', col: 5, row: 4 }] };
    const after = connect(g, 'lb', 's4');
    expect(after.reason).toBeUndefined();
    // 50/25/25 + a 4th server → 37.5/18.75/18.75/25 (never 25/13/13/50).
    expect(lbShares(after.graph)).toEqual([['s1', 0.375], ['s2', 0.1875], ['s3', 0.1875], ['s4', 0.25]]);
    expect(shareFractions(after.graph.edges.filter((e) => e.from === 'lb').map((e) => e.call.share))).toEqual([0.375, 0.1875, 0.1875, 0.25]);
    // Without shares set, every arrow stays even (no shares are written).
    const even = connect({ ...branchedGraph(), nodes: g.nodes }, 'lb', 's4').graph;
    expect(lbShares(even).every(([, share]) => share === undefined)).toBe(true);
    // Other callers never get shares.
    expect(connect(g, 's2', 'queue').graph.edges.find((e) => e.id === 's2--queue')!.call.share).toBeUndefined();
  });

  it('an app server calls its parts one after another or all at once; other kinds ignore it', () => {
    const g = setFanOut(branchedGraph(), 's1', 'parallel');
    expect(g.nodes.find((n) => n.id === 's1')!.settings).toMatchObject({ fanOut: 'parallel' });
    expect(setFanOut(g, 'lb', 'parallel').nodes.find((n) => n.id === 'lb')!.settings).not.toHaveProperty('fanOut');
  });
});
