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
    expect(c.tiers.map((t) => [t.id, t.downstream?.retries ?? null])).toEqual([['gateway', 3], ['api', 1], ['cache', null], ['db', null]]);
    expect(c.tiers.find((t) => t.id === 'api')!.cacheAside!.retries).toBe(0);
  });

  it('overrides retries for the callers it names, the client included; the others keep the topology\'s', () => {
    const c = buildRunConfig(webChain, retryStorm, { retries: { client: 0, api: 4 } });
    expect(c.client.call.retries).toBe(0);
    expect(c.tiers.find((t) => t.id === 'api')!.downstream!.retries).toBe(4);
    expect(c.tiers.find((t) => t.id === 'gateway')!.downstream!.retries).toBe(3);
    expect(c.tiers.find((t) => t.id === 'api')!.cacheAside!.retries).toBe(0); // cache-aside calls are not overridden
    // A caller that makes no call (or does not exist) changes nothing.
    expect(buildRunConfig(webChain, retryStorm, { retries: { db: 7, nobody: 2 } })).toEqual(buildRunConfig(webChain, retryStorm));
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
