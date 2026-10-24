import { webChain } from '../data/topologies';
import { compileGraph } from './compile';
import { chainGraph } from './testGraphs';
import { kindOfTier } from './fromPreset';
import { builtScenarios, estimateCapacityRps, tierCapacityRps, trafficAxis } from './scenarios';

const kinds = (t: typeof webChain) => Object.fromEntries(t.tiers.map((x) => [x.id, kindOfTier(t, x)]));

describe('traffic range for a built topology', () => {
  it('on the preset: the DB without cache help, ~160 req/s, gives the preset map range 60–240', () => {
    expect(Math.round(estimateCapacityRps(webChain))).toBe(Math.round(tierCapacityRps(webChain.tiers.find((t) => t.id === 'db')!)));
    expect(estimateCapacityRps(webChain)).toBeGreaterThan(150);
    expect(estimateCapacityRps(webChain)).toBeLessThan(170);
    expect(trafficAxis(estimateCapacityRps(webChain)).values).toEqual([60, 80, 100, 120, 140, 160, 180, 200, 220, 240]);
  });

  it('scales with the system, in nice steps, never starting at 0', () => {
    expect(trafficAxis(1600).values).toEqual([600, 800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400]); // a third of capacity to 1.5×, step 200
    expect(trafficAxis(5).values[0]).toBeGreaterThan(0);
  });

  it("a queue's consumers cap it by how fast the next part answers", () => {
    const t = compileGraph(chainGraph(['client', 'queue', 'database']));
    // 16 consumers ÷ the DB's mean time (~26 ms for median 20, p99 100) ≈ 600/s, above the DB's 4 cores (~150/s)…
    expect(estimateCapacityRps(t)).toBeCloseTo(tierCapacityRps(t.tiers[1]), 5);
    const few = compileGraph({ ...chainGraph(['client', 'queue', 'database']), nodes: chainGraph(['client', 'queue', 'database']).nodes.map((n) => (n.settings.kind === 'queue' ? { ...n, settings: { ...n.settings, consumers: 2 } } : n)) });
    expect(estimateCapacityRps(few)).toBeLessThan(tierCapacityRps(few.tiers[1])); // …with 2 consumers, the consumers are the limit
  });
});

describe('builtScenarios', () => {
  it('offers each scenario that applies, aimed at the right part, at the client traffic', () => {
    const t = compileGraph(chainGraph(['client', 'loadBalancer', 'server', 'queue', 'server', 'database'], 2));
    const list = builtScenarios(t, { n1: 'loadBalancer', n2: 'server', c: 'cache', n3: 'queue', n4: 'server', n5: 'database' }, 100);
    expect(list.map((s) => [s.id, s.title, s.faults[0].tier, s.faults[0].kind])).toEqual([
      ['custom-db-slow', 'database 5 slows down', 'n5', 'slow'],
      ['custom-cache-restart', 'cache restarts empty', 'c', 'dead'],
      ['custom-front-slow', 'loadBalancer 1 slows down', 'n1', 'slow'],
      ['custom-queue-backlog', 'Work behind queue 3 slows down', 'n4', 'slow'],
    ]);
    for (const s of list) {
      expect(s.rps).toBe(100);
      expect(s.topology).toBe('custom');
      expect(s.map.x.param).toBe('rps');
      expect(s.map.y.param).toBe('outageMs');
      expect(s.faults[0].startMs).toBe(30_000);
    }
    expect(list[1].faults[0].flushAtEnd).toBe(true);
  });

  it('slows the front door enough to serve only about half the traffic', () => {
    const t = compileGraph(chainGraph(['client', 'server', 'database']));
    const [, front] = builtScenarios(t, { n1: 'server', n2: 'database' }, 100);
    const factor = front.faults[0].factor!;
    expect(tierCapacityRps(t.tiers[0]) / factor).toBeCloseTo(50, -1);
  });

  it('leaves out what does not apply', () => {
    const t = compileGraph(chainGraph(['client', 'queue', 'server']));
    expect(builtScenarios(t, { n1: 'queue', n2: 'server' }, 50).map((s) => s.id)).toEqual(['custom-queue-backlog']);
    expect(builtScenarios(webChain, kinds(webChain), 200).map((s) => s.id)).toEqual(['custom-db-slow', 'custom-cache-restart', 'custom-front-slow']);
  });
});
