import { connect, setFanOut, setShare, shareFractions, sharesWith, shareWeight } from './edit';
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

  it("sets one of a load balancer's arrows' share; arrows of a single call are left alone", () => {
    const g = setShare(branchedGraph(), 'lb--s1', 50);
    expect(g.edges.filter((e) => e.from === 'lb').map((e) => e.call.share)).toEqual([0.5, 0.25, 0.25]);
    const chain = chainGraph(['client', 'loadBalancer', 'server']);
    expect(setShare(chain, chain.edges[1].id, 50)).toBe(chain);
    expect(setShare(chain, 'nope', 50)).toBe(chain);
  });

  it('an app server calls its parts one after another or all at once; other kinds ignore it', () => {
    const g = setFanOut(branchedGraph(), 's1', 'parallel');
    expect(g.nodes.find((n) => n.id === 's1')!.settings).toMatchObject({ fanOut: 'parallel' });
    expect(setFanOut(g, 'lb', 'parallel').nodes.find((n) => n.id === 'lb')!.settings).not.toHaveProperty('fanOut');
  });
});
