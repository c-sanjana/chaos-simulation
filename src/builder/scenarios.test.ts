import { webChain } from '../data/topologies';
import { compileGraph } from './compile';
import { chainGraph } from './testGraphs';
import { kindOfTier } from './fromPreset';
import { builtScenarios, estimateCapacityRps, tierCapacityRps, trafficAxis } from './scenarios';

const kinds = (t: typeof webChain) => Object.fromEntries(t.tiers.map((x) => [x.id, kindOfTier(t, x)]));

describe('traffic range for a built topology', () => {
  it('on the preset: the DB without cache help, ~160 req/s', () => {
    expect(Math.round(estimateCapacityRps(webChain))).toBe(Math.round(tierCapacityRps(webChain.tiers.find((t) => t.id === 'db')!)));
    expect(estimateCapacityRps(webChain)).toBeGreaterThan(150);
    expect(estimateCapacityRps(webChain)).toBeLessThan(170);
  });

  it("is centred on the users' own traffic, widened to take in a nearby capacity", () => {
    // The example system at its 200 req/s, cached: a third of the traffic to twice it.
    expect(trafficAxis(200, estimateCapacityRps(webChain), true).values).toEqual([50, 100, 150, 200, 250, 300, 350, 400]);
    // Review 2.1: Client -> App server at 100 req/s has ~3,000 req/s of capacity; the map stays around 100, not 1,000-5,500.
    expect(trafficAxis(100, 3150, false).values).toEqual([40, 60, 80, 100, 120, 140, 160, 180, 200]);
    // Capacity a little below the traffic: the range reaches down to half of it.
    expect(trafficAxis(100, 40, false).values[0]).toBeLessThanOrEqual(20);
  });

  it('without a cache, stops at 1.25x capacity, or just past the traffic when that is higher', () => {
    const nearCapacity = trafficAxis(1000, 1000, false).values;
    expect(nearCapacity.at(-1)).toBeLessThanOrEqual(1250);
    expect(nearCapacity).toContain(1000);
    const overloaded = trafficAxis(100, 10, false).values;
    expect(overloaded).toContain(100);
    expect(overloaded.at(-1)).toBeLessThanOrEqual(120);
    // With a cache the healthy system can take more, so twice the traffic stays on the map.
    expect(trafficAxis(1000, 1000, true).values.at(-1)).toBeGreaterThanOrEqual(2000);
  });

  it('whole numbers in round steps, the traffic always on the map, never above the 5,000 req/s limit', () => {
    for (const rps of [1, 2, 3, 7, 13, 50, 99, 100, 137, 250, 999, 1234, 2600, 4999, 5000]) {
      for (const capacity of [0.004, 1, rps / 3, rps, rps * 2, rps * 10, 70_000, Infinity]) {
        for (const cache of [false, true]) {
          const v = trafficAxis(rps, capacity, cache).values;
          const why = `${rps} req/s, capacity ${capacity}, cache ${cache}: ${v.join(', ')}`;
          expect(v.length, why).toBeGreaterThanOrEqual(5);
          expect(v.length, why).toBeLessThanOrEqual(10);
          expect(v.every((x) => Number.isInteger(x) && x >= 1 && x <= 5000), why).toBe(true);
          expect(v[0] <= rps && v.at(-1)! >= Math.min(rps, 5000), why).toBe(true);
          const step = v[1] - v[0];
          expect([1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500], why).toContain(step);
          expect(v.every((x, i) => i === 0 || x - v[i - 1] === step), why).toBe(true);
        }
      }
    }
    expect(trafficAxis(1, 0.004, false).values).toEqual([1, 2, 3, 4, 5]); // no 0.004 req/s axes
    expect(trafficAxis(5000, 20_000, true).values.at(-1)).toBe(5000);
  });

  it('makes the traffic a cell of its own when a round step divides it', () => {
    expect(trafficAxis(150, 160, true).values).toContain(150);
    expect(trafficAxis(80, 160, false).values).toContain(80);
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
      ['custom-db-slow:n5', 'database 5 slows down', 'n5', 'slow'],
      ['custom-cache-restart:c', 'cache restarts empty', 'c', 'dead'],
      ['custom-front-slow:n1', 'loadBalancer 1 slows down', 'n1', 'slow'],
      ['custom-queue-backlog:n3', 'server 4 slows down', 'n4', 'slow'],
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

  it('slows the front door enough to serve only about half the traffic, and says what that means per request', () => {
    const t = compileGraph(chainGraph(['client', 'server', 'database']));
    const [, front] = builtScenarios(t, { n1: 'server', n2: 'database' }, 100);
    const factor = front.faults[0].factor!;
    expect(tierCapacityRps(t.tiers[0]) / factor).toBeCloseTo(50, -1);
    expect(front.blurb).toBe(`server 1, the first thing users reach, takes ~${4 * factor} ms a request instead of ~4 ms (${factor}× slower) for 20 s.`);
  });

  it("keeps the front door's slowdown a slowdown: a typical request still finishes within half the users' timeout", () => {
    const t = compileGraph(chainGraph(['client', 'loadBalancer', 'server', 'database']));
    const kinds = { n1: 'loadBalancer', n2: 'server', n3: 'database' };
    // A load balancer has room for ~13,000 req/s; at 1 req/s "half the traffic" would mean 1,000x slower.
    expect(builtScenarios(t, kinds, 1).find((s) => s.id === 'custom-front-slow:n1')!.faults[0].factor).toBe(1000);
    const strict = compileGraph(chainGraph(['client', 'loadBalancer', 'server', 'database']));
    strict.clientCall.timeoutMs = 100; // 0.5 ms typical: at most 100 x slower (50 ms, half the timeout)
    expect(builtScenarios(strict, kinds, 1).find((s) => s.id === 'custom-front-slow:n1')!.faults[0].factor).toBe(100);
  });

  it('describes the slowdown behind a queue by its effect', () => {
    const t = compileGraph(chainGraph(['client', 'queue', 'server']));
    const [backlog] = builtScenarios(t, { n1: 'queue', n2: 'server' }, 50);
    expect(backlog.blurb).toMatch(/^server 2 takes ~[\d.]+ (ms|s) a request instead of ~4 ms \(\d+× slower\) for 20 s; messages pile up in queue 1\. Does it catch up\?$/);
  });

  it('leaves out what does not apply', () => {
    const t = compileGraph(chainGraph(['client', 'queue', 'server']));
    expect(builtScenarios(t, { n1: 'queue', n2: 'server' }, 50).map((s) => s.id)).toEqual(['custom-queue-backlog:n1']);
    expect(builtScenarios(webChain, kinds(webChain), 200).map((s) => s.id)).toEqual(['custom-db-slow:db', 'custom-cache-restart:cache', 'custom-front-slow:lb']);
  });
});
