/**
 * The bundled presets with the default retries at every layer (users' apps 5, Gateway → API 3,
 * API → DB 1): each default run gets stuck, and each map's staircase is where the comments in
 * scenarios.ts say it is. Measured, not scripted: if the engine changes, these say which claim moved.
 */
import { assessRecovery, controlConfig, type Verdict } from '../analysis/recovery';
import { runSimulation } from '../engine/run';
import { buildRunConfig, type ScenarioOverrides } from './buildConfig';
import { cacheRestart, gatewaySlow, retryStorm, scenarios } from './scenarios';
import { webChain } from './topologies';
import type { ScenarioPreset } from './types';

function verdictOf(scenario: ScenarioPreset, overrides: ScenarioOverrides = {}): Verdict {
  const config = buildRunConfig(webChain, scenario, overrides);
  return assessRecovery(runSimulation(config), runSimulation(controlConfig(config)), config).verdict;
}

/** Back to normal (or never left it). */
const recovers = (v: Verdict) => v === 'recovered' || v === 'unaffected';

describe('presets', () => {
  it('each has one failure by default and a traffic × failure-length map that includes its own settings', () => {
    for (const s of Object.values(scenarios)) {
      expect(s.faults).toHaveLength(1);
      expect(s.map.x.param).toBe('rps');
      expect(s.map.y.param).toBe('outageMs');
      expect(s.map.x.values).toContain(s.rps);
      expect(s.map.y.values).toContain(s.faults[0].endMs - s.faults[0].startMs);
      // Longest failure at the top of the map.
      expect(s.map.y.values).toEqual([...s.map.y.values].sort((a, b) => b - a));
    }
  });
});

describe('presets at their default settings (retries 5 / 3 / 1)', { timeout: 60_000 }, () => {
  it('retry storm: a 5 s DB slowdown at 200 req/s gets stuck', () => {
    expect(verdictOf(retryStorm)).toBe('stuck');
  });

  // Right at the edge: 180 req/s recovers (below).
  it('cache restart: 5 s without the cache at 200 req/s gets stuck', () => {
    expect(verdictOf(cacheRestart)).toBe('stuck');
  });

  it('gateway slow: a 20 s Gateway slowdown at 200 req/s gets stuck', () => {
    expect(verdictOf(gatewaySlow)).toBe('stuck');
  });
});

/** [failure length (s), traffic (req/s), recovers?] */
type Claim = [seconds: number, rps: number, recovers: boolean];

describe("each map's staircase, as the comments in scenarios.ts claim", { timeout: 120_000 }, () => {
  const check = (scenario: ScenarioPreset, claims: Claim[]) => {
    const measured = claims.map(([seconds, rps]): Claim => [seconds, rps, recovers(verdictOf(scenario, { rps, outageMs: seconds * 1000 }))]);
    expect(measured).toEqual(claims);
  };

  it('retry storm: up to 2 s always recovers; 3 s tips at 160 req/s, 5 s at 100, 8 s at 80', () => {
    check(retryStorm, [
      [2, 240, true],
      [3, 140, true],
      [3, 160, false],
      [5, 80, true],
      [5, 100, false],
      [8, 60, true],
      [8, 80, false],
    ]);
  });

  it('cache restart: 1 s recovers everywhere; 3 s tips at 220 req/s, 5 s at 200, 10 s at 180', () => {
    check(cacheRestart, [
      [1, 240, true],
      [3, 200, true],
      [3, 220, false],
      [5, 180, true],
      [10, 160, true],
      [10, 180, false],
    ]);
  });

  it('gateway slow: up to 5 s always recovers; 10 s tips at 220 req/s, 20 s at 180', () => {
    check(gatewaySlow, [
      [5, 240, true],
      [10, 200, true],
      [10, 220, false],
      [20, 160, true],
      [20, 180, false],
    ]);
  });
});
