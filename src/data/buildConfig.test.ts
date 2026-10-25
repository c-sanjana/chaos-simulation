import { validateConfig } from '../engine/validate';
import { buildRunConfig } from './buildConfig';
import { retryStorm, scenarios } from './scenarios';
import { topologies, webChain } from './topologies';

describe('buildRunConfig', () => {
  it('produces a valid config with the scenario defaults', () => {
    const c = buildRunConfig(webChain, retryStorm);
    expect(() => validateConfig(c)).not.toThrow();
    expect(c.seed).toBe(42);
    expect(c.client.rps).toBe(retryStorm.rps);
    expect(c.faults).toEqual(retryStorm.faults);
  });

  it('keeps every call\'s retries from the topology by default (5 / 3 / 1, none on the cache)', () => {
    const c = buildRunConfig(webChain, retryStorm);
    expect(c.client.call.retries).toBe(5);
    expect(c.tiers.map((t) => [t.id, t.downstream?.retries ?? null])).toEqual([['lb', 3], ['api', 1], ['cache', null], ['db', null]]);
    expect(c.tiers.find((t) => t.id === 'api')!.cacheAside!.retries).toBe(0);
  });

  it('overrides retries for the callers it names, the client included; the others keep the topology\'s', () => {
    const c = buildRunConfig(webChain, retryStorm, { retries: { client: 0, api: 4 } });
    expect(c.client.call.retries).toBe(0);
    expect(c.tiers.find((t) => t.id === 'api')!.downstream!.retries).toBe(4);
    expect(c.tiers.find((t) => t.id === 'lb')!.downstream!.retries).toBe(3);
    expect(c.tiers.find((t) => t.id === 'api')!.cacheAside!.retries).toBe(0); // cache-aside calls are not overridden
    // A caller that makes no call (or does not exist) changes nothing.
    expect(buildRunConfig(webChain, retryStorm, { retries: { db: 7, nobody: 2 } })).toEqual(buildRunConfig(webChain, retryStorm));
  });

  it("applies a caller's retry override to every one of its downstream calls (branching)", () => {
    const api = webChain.tiers.find((t) => t.id === 'api')!;
    const branched = {
      ...webChain,
      tiers: [...webChain.tiers.map((t) => (t.id === 'api' ? { ...api, moreDownstream: [{ ...api.downstream!, target: 'search', retries: 2 }], fanOut: 'parallel' as const } : t)), { ...webChain.tiers[3], id: 'search' }],
    };
    const own = buildRunConfig(branched, retryStorm).tiers.find((t) => t.id === 'api')!;
    expect([own.downstream!.retries, own.moreDownstream![0].retries]).toEqual([1, 2]);
    const c = buildRunConfig(branched, retryStorm, { retries: { api: 4 } });
    const overridden = c.tiers.find((t) => t.id === 'api')!;
    expect([overridden.downstream!.retries, overridden.moreDownstream![0].retries, overridden.cacheAside!.retries]).toEqual([4, 4, 0]);
    expect(overridden.fanOut).toBe('parallel');
    expect(() => validateConfig(c)).not.toThrow();
    // Tiers without further calls get no moreDownstream field.
    expect('moreDownstream' in c.tiers.find((t) => t.id === 'lb')!).toBe(false);
  });

  it('overrides traffic, outage length and seed without mutating the presets', () => {
    const c = buildRunConfig(webChain, retryStorm, { rps: 80, outageMs: 12_000, seed: 3 });
    expect(c.client.rps).toBe(80);
    expect(c.seed).toBe(3);
    expect(c.faults![0].endMs - c.faults![0].startMs).toBe(12_000);
    expect(retryStorm.faults[0].endMs).toBe(35_000);
    expect(webChain.tiers[0].downstream!.retries).toBe(3);
    expect(webChain.clientCall.retries).toBe(5);
  });

  it('registers presets by id, and every scenario names a known topology', () => {
    expect(topologies[webChain.id]).toBe(webChain);
    for (const s of Object.values(scenarios)) {
      expect(topologies[s.topology]).toBeDefined();
      expect(() => validateConfig(buildRunConfig(topologies[s.topology], s))).not.toThrow();
    }
    for (const t of webChain.tiers) expect(webChain.layout[t.id]).toBeDefined();
  });
});
