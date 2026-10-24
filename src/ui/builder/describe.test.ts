import { starterGraph, updateNode } from '../../builder/edit';
import { defaultSettings, type PoolSettings } from '../../builder/graph';
import { callLabel, callSentence, displayName, edgeEnds, edgeTitle, formatCount, formatMs, nodeLines, nodeSummary, plural } from './describe';

const call = { timeoutMs: 1000, retries: 1, backoffBaseMs: 50, jitter: true };

describe('number formatting', () => {
  it('formats counts and times plainly', () => {
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(0.25)).toBe('0.25');
    expect(formatMs(0.3)).toBe('0.3 ms');
    expect(formatMs(4)).toBe('4 ms');
    expect(formatMs(20.4)).toBe('20 ms');
    expect(formatMs(1000)).toBe('1 s');
    expect(formatMs(1500)).toBe('1.5 s');
    expect(formatMs(60_000)).toBe('60 s');
    expect(plural(1, 'retry', 'retries')).toBe('1 retry');
    expect(plural(2000, 'key', 'keys')).toBe('2,000 keys');
  });
});

describe('nodeLines', () => {
  it('shows one or two key numbers per kind', () => {
    expect(nodeLines(defaultSettings('client'))).toEqual(['100 req/s']);
    expect(nodeLines(defaultSettings('server'))).toEqual(['4 × 200 workers', '~4 ms each']);
    expect(nodeLines({ ...(defaultSettings('database') as PoolSettings), workersPerInstance: 1 })).toEqual(['1 × 1 worker', '~20 ms each']);
    expect(nodeLines(defaultSettings('cache'))).toEqual(['holds 2,000 keys', '~0.3 ms each']);
    expect(nodeLines(defaultSettings('queue'))).toEqual(['holds 10,000', '16 consumers']);
    expect(nodeLines({ kind: 'queue', maxDepth: 5, consumers: 1, service: { medianMs: 1, p99Ms: 2 } })).toEqual(['holds 5', '1 consumer']);
  });
});

describe('call text', () => {
  it('labels arrows briefly', () => {
    expect(callLabel(call)).toBe('1 s · 1 retry');
    expect(callLabel({ ...call, timeoutMs: 100, retries: 0 })).toBe('100 ms · no retries');
    expect(callLabel({ ...call, timeoutMs: null, retries: 3 })).toBe('no timeout · 3 retries');
  });

  it('describes calls in a sentence', () => {
    expect(callSentence(call)).toBe('gives up after 1 s, then tries again up to 1 time');
    expect(callSentence({ ...call, timeoutMs: null, retries: 0 })).toBe('waits as long as it takes, and does not try again');
    expect(callSentence({ ...call, retries: 2 })).toMatch(/up to 2 times$/);
  });
});

describe('names', () => {
  it('uses the name, or the kind for a blank name', () => {
    const g = updateNode(starterGraph(), 'server-1', { label: '   ' });
    expect(displayName(g.nodes[0])).toBe('Client');
    expect(displayName(g.nodes[2])).toBe('App server');
    expect(nodeSummary(g.nodes[2])).toBe('App server, an app server: 4 × 200 workers, ~4 ms each');
    expect(nodeSummary(g.nodes[1])).toMatch(/^Load balancer, a load balancer:/);
  });

  it('names an arrow by its ends, falling back to ids for missing ends', () => {
    const g = starterGraph();
    const edge = g.edges[3];
    expect(edgeEnds(g, edge).to?.label).toBe('Database');
    expect(edgeTitle(g, edge)).toBe('App server calls Database');
    expect(edgeTitle({ nodes: [], edges: [] }, edge)).toBe('server-1 calls database-1');
  });
});
