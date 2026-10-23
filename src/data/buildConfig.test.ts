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

  it('applies retries to every call except cache lookups', () => {
    const c = buildRunConfig(webChain, retryStorm, { retries: 5 });
    expect(c.client.call.retries).toBe(5);
    for (const t of c.tiers) {
      if (t.downstream) expect(t.downstream.retries).toBe(5);
      if (t.cacheAside) expect(t.cacheAside.retries).toBe(0);
    }
  });

  it('overrides traffic, outage length and seed without mutating the presets', () => {
    const c = buildRunConfig(webChain, retryStorm, { rps: 80, outageMs: 12_000, seed: 3 });
    expect(c.client.rps).toBe(80);
    expect(c.seed).toBe(3);
    expect(c.faults![0].endMs - c.faults![0].startMs).toBe(12_000);
    expect(retryStorm.faults[0].endMs).toBe(35_000);
    expect(webChain.tiers[0].downstream!.retries).toBe(0);
  });

  it('registers presets by id, and every scenario names a known topology', () => {
    expect(topologies[webChain.id]).toBe(webChain);
    for (const s of Object.values(scenarios)) expect(topologies[s.topology]).toBeDefined();
    for (const t of webChain.tiers) expect(webChain.layout[t.id]).toBeDefined();
  });
});
