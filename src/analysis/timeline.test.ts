import { buildRunConfig } from '../data/buildConfig';
import { cacheRestart, gatewaySlow } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RunConfig } from '../engine/config';
import { call, tier } from '../engine/testConfigs';
import { analyzed, retryStormRun } from './testRuns';

describe('buildTimeline', { timeout: 60_000 }, () => {
  it('tells the stuck retry storm in order, with the point of no return and a stuck verdict', () => {
    const { analysis, run } = retryStormRun({ retries: 3 });
    const t = analysis.timeline;
    expect(t.length).toBeLessThanOrEqual(10);
    expect(t.map((e) => e.tMs)).toEqual([...t.map((e) => e.tMs)].sort((a, b) => a - b));
    expect(t[0]).toMatchObject({ tMs: 30_000, kind: 'fault', text: 'DB slows 8× (injected failure)' });
    expect(t.some((e) => e.kind === 'fault' && e.text === 'Failure ends; DB back to normal speed')).toBe(true);
    expect(t.some((e) => /exceeds the API's 1 s timeout/.test(e.text))).toBe(true);

    const tip = t.find((e) => e.kind === 'tip')!;
    expect(tip.tMs).toBe(35_000);
    // Not "Tipping point": step 2 uses that name for a traffic level.
    expect(tip.text).toMatch(/^Point of no return: the failure is over, but retries keep DB load at \d+\.\d× its capacity/);
    expect(t.some((e) => /tipping point/i.test(e.text))).toBe(false);

    const verdict = t.find((e) => e.kind === 'bad')!;
    expect(verdict.endMs).toBe(analysis.recovery.judgedUntilMs);
    expect(verdict.text).toMatch(/Never returned to normal.*\d+% of DB work/);

    // The quoted peak load matches the metrics.
    const peak = Number(/peak (\d+\.\d)×/.exec(t.find((e) => /peak/.test(e.text))!.text)![1]);
    const db = run.tiers.db;
    const capacity = (4 * 1000) / (20 * Math.exp(Math.log(5) ** 2 / (2 * 2.3263478740408408 ** 2)));
    const maxLoad = Math.max(...db.arrivalsFirst.map((f, s) => f + db.arrivalsRetry[s]).slice(30, 107));
    expect(peak).toBeCloseTo(maxLoad / capacity, 1);
  });

  it('tells the recovered run with a good verdict and no point of no return', () => {
    const { analysis } = retryStormRun({ retries: 0 });
    const t = analysis.timeline;
    expect(t.some((e) => e.kind === 'tip')).toBe(false);
    const good = t.find((e) => e.kind === 'good')!;
    expect(good.tMs).toBe(analysis.recovery.recoveredAtMs);
    expect(good.text).toBe(`Back to normal: recovered ${Math.round(analysis.recovery.recoveryMs! / 1000)} s after the failure ended`);
  });

  it('describes dead, per-instance and cache-flush faults, and cache hit-rate drops', () => {
    const config: RunConfig = {
      seed: 5,
      durationMs: 60_000,
      client: { rps: 100, call: call('api', { timeoutMs: 2000 }) },
      tiers: [
        tier('api', { kind: 'fixed', ms: 1 }, { instances: 2, workersPerInstance: 100, cacheAside: call('cache', { timeoutMs: 50 }), downstream: call('db', { timeoutMs: 1000 }) }),
        tier('cache', { kind: 'fixed', ms: 0.2 }, { workersPerInstance: 100, cache: { capacity: 200, ttlMs: null, keys: 1000, skew: 1 } }),
        tier('db', { kind: 'fixed', ms: 2 }, { workersPerInstance: 50 }),
      ],
      faults: [
        { tier: 'cache', kind: 'dead', startMs: 20_000, endMs: 25_000, flushAtEnd: true },
        { tier: 'api', instance: 1, kind: 'dead', startMs: 40_000, endMs: 41_000 },
      ],
    };
    const texts = analyzed(config).analysis.timeline.map((e) => e.text);
    // Display labels come from the web-chain layout (see testRuns.ts).
    expect(texts).toContain('Cache goes down (injected failure)');
    expect(texts).toContain('Failure ends; Cache restarts empty');
    expect(texts).toContain('API instance 2 goes down (injected failure)');
    expect(texts).toContain('Failure ends; API back up');
    expect(texts.some((x) => /^Cache hit rate falls to \d+% \(normally \d+%\)$/.test(x))).toBe(true);
  });

  it('reports workers occupied while CPU idles', () => {
    const { analysis } = retryStormRun({ retries: 3 });
    expect(analysis.timeline.some((e) => /workers \d+% occupied, CPU \d+%: waiting, not working/.test(e.text))).toBe(true);
  });

  it('has verdict entries for unaffected and overloaded runs', () => {
    const base: RunConfig = {
      seed: 1,
      durationMs: 30_000,
      client: { rps: 20, call: call('svc', { timeoutMs: 1000 }) },
      tiers: [tier('svc', { kind: 'fixed', ms: 5 }, { workersPerInstance: 20 })],
      faults: [{ tier: 'svc', kind: 'slow', factor: 1.01, startMs: 10_000, endMs: 11_000 }],
    };
    expect(analyzed(base).analysis.timeline.at(-1)).toMatchObject({ kind: 'good', text: 'Stayed within the normal range throughout' });
    const overloaded = { ...base, client: { rps: 500, call: call('svc', { timeoutMs: 100 }) }, tiers: [tier('svc', { kind: 'fixed', ms: 10 })] };
    expect(analyzed(overloaded).analysis.timeline[0]).toMatchObject({ kind: 'bad', text: 'Too much traffic for this system even without the failure' });
  });

  it('a slow Gateway: the client gives up on it; the database tips only once the Gateway passes its pile on', () => {
    const { analysis } = analyzed(buildRunConfig(webChain, gatewaySlow));
    const t = analysis.timeline;
    expect(t.map((e) => e.tMs)).toEqual([...t.map((e) => e.tMs)].sort((a, b) => a - b));
    expect(t.filter((e) => e.kind === 'fault').map((e) => e.text)).toEqual(['Gateway slows 50× (injected failure)', 'Failure ends; Gateway back to normal speed']);
    expect(t.find((e) => /exceeds/.test(e.text))!.text).toMatch(/^Gateway p99 \d\.\d s exceeds the Client's 3 s timeout$/);
    const push = t.find((e) => /^Retries push DB load past its capacity/.test(e.text))!;
    const tip = t.find((e) => e.kind === 'tip')!;
    expect(push.tMs).toBeGreaterThan(gatewaySlow.faults[0].endMs);
    expect(tip.tMs).toBe(push.tMs); // not before the load went over
    expect(tip.text).toMatch(/keep DB load at \d\.\d× its capacity/);
  });

  it('a cache restart: the hit rate drops while it is down, and it comes back empty', () => {
    const t = analyzed(buildRunConfig(webChain, cacheRestart)).analysis.timeline;
    expect(t.map((e) => e.text)).toEqual(expect.arrayContaining(['Cache goes down (injected failure)', 'Failure ends; Cache restarts empty', 'Cache hit rate falls to 0% (normally 75%)']));
    expect(t.find((e) => e.kind === 'tip')!.tMs).toBe(cacheRestart.faults[0].endMs);
  });
});
