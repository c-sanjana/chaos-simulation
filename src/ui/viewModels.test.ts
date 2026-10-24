import { retryStormRun } from '../analysis/testRuns';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RecoveryResult } from '../analysis/recovery';
import {
  activeFault,
  answerTimes,
  axisPhrase,
  bottleneckTier,
  busiestTier,
  chartView,
  COLORS,
  findTier,
  formatAxisValue,
  labelsOf,
  mapView,
  METRIC_TABS,
  shortVerdict,
  timelineView,
  topologyView,
  retriesPhrase,
  verdictView,
  waitingTier,
} from './viewModels';

const labels = labelsOf(webChain);

describe('topologyView', { timeout: 60_000 }, () => {
  it('draws every tier and every call, healthy before the failure', () => {
    const { config, run } = retryStormRun({ retries: 3 });
    const { nodes, edges } = topologyView(webChain, config, run, 10_000);
    expect(nodes.map((n) => n.id)).toEqual(['client', 'gateway', 'api', 'cache', 'db']);
    expect(nodes.every((n) => n.health === 'ok')).toBe(true);
    expect(nodes.find((n) => n.id === 'api')!.instanceBusy).toHaveLength(4);
    expect(nodes.find((n) => n.id === 'cache')!.lines[0]).toMatch(/^hit rate \d+%$/);
    expect(nodes.find((n) => n.id === 'db')!.lines[0]).toMatch(/^\d+ rps in$/);
    expect(edges.map((e) => [e.id, e.orientation, e.col, e.row])).toEqual([
      ['client-gateway', 'horizontal', 2, 3],
      ['gateway-api', 'horizontal', 4, 3],
      ['api-cache', 'vertical', 5, 2],
      ['api-db', 'horizontal', 6, 3],
    ]);
    expect(edges.find((e) => e.id === 'api-db')!.detail).toBe('no retries');
  });

  it('shows the storm: retries on the DB arrow and unhealthy tiers while stuck', () => {
    const { config, run } = retryStormRun({ retries: 3 });
    const { nodes, edges } = topologyView(webChain, config, run, 60_000);
    const db = edges.find((e) => e.id === 'api-db')!;
    expect(db.detail).toMatch(/^incl\. \d+ retries$/);
    expect(db.health).toBe('bad');
    expect(nodes.find((n) => n.id === 'client')!.health).toBe('bad');
    expect(nodes.find((n) => n.id === 'db')!.health).toBe('bad');
    expect(edges.find((e) => e.id === 'api-cache')!.label).toMatch(/lookups\/s$/);
    // The DB is the overloaded root cause (busy, not failing its own requests); upstream tiers fail.
    expect(nodes.find((n) => n.id === 'db')!.overloaded).toBe(true);
    expect(nodes.find((n) => n.id === 'db')!.fault).toBeUndefined(); // the slowdown is over by 60 s
  });

  it('marks the injected failure while it is active, and labels what a fix changed', () => {
    const { config, run } = retryStormRun({ retries: 3 });
    const during = topologyView(webChain, config, run, 32_000, [
      { tier: 'db', text: 'queue limit 93' },
      { call: { from: 'api', to: 'db' }, text: 'retry budget 10%' },
    ]);
    const db = during.nodes.find((n) => n.id === 'db')!;
    expect(db.fault).toBe('⚡ 8× slower');
    expect(db.change).toBe('queue limit 93');
    expect(during.nodes.find((n) => n.id === 'api')!.change).toBeUndefined();
    expect(during.edges.find((e) => e.id === 'api-db')!.change).toBe('retry budget 10%');
    expect(during.edges.find((e) => e.id === 'gateway-api')!.change).toBeUndefined();
    expect(activeFault({ ...config, faults: [{ kind: 'dead', tier: 'db', startMs: 0, endMs: 1000 }] }, 'db', 500)).toBe('⚡ down');
    expect(activeFault({ ...config, faults: undefined }, 'db', 500)).toBeUndefined();
  });

  it('clamps time to the run and skips tiers the layout does not place', () => {
    const { config, run } = retryStormRun({ retries: 0 });
    const partial = { ...webChain, layout: { api: webChain.layout.api, db: webChain.layout.db } };
    const { nodes, edges } = topologyView(partial, config, run, 10_000_000);
    expect(nodes.map((n) => n.id)).toEqual(['api', 'db']);
    expect(edges.map((e) => e.id)).toEqual(['api-db']);
    const diagonal = { ...webChain, layout: { ...webChain.layout, db: { label: 'DB', col: 7, row: 1 } } };
    expect(topologyView(diagonal, config, run, 0).edges.map((e) => e.id)).not.toContain('api-db');
  });
});

describe('chartView', { timeout: 60_000 }, () => {
  it('builds every tab with failure windows, units and scope', () => {
    const { config, run } = retryStormRun({ retries: 3 });
    for (const tab of METRIC_TABS) {
      const v = chartView(tab.id, config, run, labels, null, undefined, 60);
      expect(v.spec.xsSeconds).toHaveLength(run.client.sent.length);
      expect(v.spec.failureWindows).toEqual([[30, 35]]);
      expect(v.spec.playheadS).toBe(60);
      expect(v.spec.series.every((s) => s.values.length === v.spec.xsSeconds.length)).toBe(true);
      expect(v.spec.ariaLabel).toContain(tab.label);
    }
    expect(chartView('load', config, run, labels, null).scopeLabel).toBe('DB');
    expect(chartView('errors', config, run, labels, null).spec.yMax).toBe(100);
  });

  it('names the tier a tab really shows by default, and shows workers where they wait rather than work', () => {
    const { config, run } = retryStormRun({ retries: 3 });
    expect(chartView('throughput', config, run, labels, null).defaultScopeLabel).toBe('End to end (users)');
    expect(chartView('load', config, run, labels, null).defaultScopeLabel).toBe('DB (most overloaded)');
    // App server workers are all occupied while its CPU is idle; the DB is busy computing (both at 100%).
    expect(waitingTier(run)).toBe('api');
    expect(busiestTier(run)).not.toBe('api');
    const workers = chartView('workers', config, run, labels, null);
    expect([workers.scopeLabel, workers.defaultScopeLabel]).toEqual(['App server', 'App server (most workers waiting)']);
    // Which tier the default is, so a scope picker doesn't list it twice; none for end to end.
    expect([chartView('load', config, run, labels, null).defaultScopeId, workers.defaultScopeId, chartView('latency', config, run, labels, null).defaultScopeId]).toEqual(['db', 'api', null]);
  });

  it('measures end-to-end latency as time to an answer, errors included, so it rises when requests fail', () => {
    const { config, run } = retryStormRun({ retries: 3 });
    const { p50, p99 } = answerTimes(run);
    expect(p99).toHaveLength(run.client.sent.length);
    expect(p50[10]).toBeLessThan(100); // healthy: quick answers
    expect(p99[80]).toBeGreaterThan(1900); // stuck: users wait ~2 s (the Gateway gives up on the API), then get an error
    expect(run.client.latencyP99Ms[80]).not.toBeGreaterThan(p99[80]); // the success-only line looked faster
    const view = chartView('latency', config, run, labels, null);
    expect(view.spec.series.map((x) => x.label)).toEqual(['Slowest 1% wait (p99)', 'Typical wait (median)', "Users' apps give up on one try after 3 s"]);
    // Says why the wait is longer than one timeout, and why lines stop.
    expect(view.note).toMatch(/includes every retry until the final answer or error/);
    expect(view.note).toMatch(/Lines stop where requests had not finished when the run ended/);
    expect(chartView('latency', config, run, labels, 'db').note).toBeUndefined();
  });

  it('stacks first attempts and retries under the capacity line on Load & retries', () => {
    const { config, run } = retryStormRun({ retries: 3 });
    const s = chartView('load', config, run, labels, 'db').spec.series;
    expect(s.map((x) => [x.label, !!x.area, !!x.dashed])).toEqual([
      ["Users' new requests", true, false],
      ['Repeats (from any layer)', true, false],
      ['DB capacity', false, true],
    ]);
    expect(s[1].color).toBe(COLORS.bad);
  });

  it('counts repeats from every layer as repeats, and turned-away requests apart, clipped', async () => {
    const { buildRunConfig } = await import('../data/buildConfig');
    const { retryStorm } = await import('../data/scenarios');
    const { webChain } = await import('../data/topologies');
    const { runSimulation } = await import('../engine/run');
    const { loadSplit } = await import('./viewModels');
    const config = buildRunConfig(webChain, retryStorm);
    const run = runSimulation(config);
    const db = run.tiers.db;
    // With every layer retrying, most first tries at the DB are made for a repeat further up.
    const sum = (xs: number[]) => xs.slice(40, 98).reduce((a, b) => a + b, 0);
    expect(sum(db.arrivalsFromRepeats)).toBeGreaterThan(0.5 * sum(db.arrivalsFirst));
    const split = loadSplit(run, 'db');
    expect(sum(split.repeats)).toBeGreaterThan(5 * sum(split.fresh));
    split.admitted.forEach((a, b) => expect(a).toBeCloseTo(split.fresh[b] + split.repeats[b], 6));
    expect(run.tiers.db.arrivalsFromRepeats.slice(0, 30).every((v) => v === 0)).toBe(true); // none before the failure

    // A bounded queue turns most of the storm away: drawn apart and clipped, so the admitted work stays readable.
    const bounded = { ...config, tiers: config.tiers.map((t) => (t.id === 'db' ? { ...t, queueLimit: 93 } : t)) };
    const view = chartView('load', bounded, runSimulation(bounded), labels, 'db').spec;
    const away = view.series.find((x) => x.label.startsWith('Turned away'))!;
    expect(away.label).toBe('Turned away (clipped at the top)');
    expect(Math.max(...away.values)).toBeLessThanOrEqual(view.yMax!);
    expect(view.yMax!).toBeLessThan(1000);
  });

  it('scopes latency and errors to a selected tier, with the caller timeout', () => {
    const { config, run } = retryStormRun({ retries: 3 });
    const lat = chartView('latency', config, run, labels, 'db');
    expect(lat.scopeLabel).toBe('DB');
    expect(lat.spec.series.map((x) => x.label)).toEqual(['Slowest 1% (p99)', 'Typical (median)', 'App server gives up after 1 s']);
    expect(chartView('latency', config, run, labels, 'client').spec.series.at(-1)!.label).toBe("Users' apps give up on one try after 3 s");
    expect(chartView('latency', config, run, labels, 'gateway').spec.series.at(-1)!.label).toBe('Client gives up after 3 s');
    expect(chartView('errors', config, run, labels, 'api').scopeLabel).toBe('App server');
    expect(chartView('load', config, run, labels, 'api').spec.series.some((x) => /capacity/.test(x.label))).toBe(false);
  });

  it('overlays before (grey) and after (blue) when comparing', () => {
    const before = retryStormRun({ retries: 3 });
    const after = retryStormRun({ retries: 0 });
    for (const tab of METRIC_TABS.filter((t) => t.id !== 'load')) {
      const v = chartView(tab.id, before.config, before.run, labels, null, after.run);
      expect(v.spec.series[0].color).toBe(COLORS.before);
      expect(v.spec.series[1].color).toBe(COLORS.primary);
      expect(v.spec.ariaLabel).toMatch(/before and after/);
    }
  });

  it('keeps the first-attempts vs retries split of the run being shown when comparing load', () => {
    const before = retryStormRun({ retries: 3 });
    const after = retryStormRun({ retries: 0 });
    const shownAfter = chartView('load', before.config, before.run, labels, null, after.run).spec.series;
    expect(shownAfter.map((x) => x.label)).toEqual(["Users' new requests", 'Repeats (from any layer)', 'Total before the fix', 'DB capacity']);
    expect(shownAfter[1].values.every((v) => v === 0)).toBe(true); // no retries after the fix (users' apps 0 here too)
    const shownBefore = chartView('load', before.config, before.run, labels, null, after.run, undefined, false).spec.series;
    expect(shownBefore[2].label).toBe('Total after the fix');
    expect(shownBefore[1].values.some((v) => v > 0)).toBe(true);
  });

  it('omits the timeout line when the caller waits forever', () => {
    const { config, run } = retryStormRun({ retries: 0 });
    const forever = { ...config, client: { ...config.client, call: { ...config.client.call, timeoutMs: null } } };
    expect(chartView('latency', forever, run, labels, null).spec.series.some((s) => s.dashed)).toBe(false);
  });
});

describe('verdicts, maps and helpers', { timeout: 60_000 }, () => {
  const base: Omit<RecoveryResult, 'verdict' | 'recoveryMs'> = { recoveredAtMs: null, failedRequests: 0, judgedUntilMs: 0, lastFaultEndMs: 0 };

  it('words every verdict', () => {
    expect(verdictView({ ...base, verdict: 'recovered', recoveryMs: 12_400 })).toEqual({ text: 'Recovered 12 s after the failure ended', tone: 'good' });
    expect(verdictView({ ...base, verdict: 'unaffected', recoveryMs: null }).tone).toBe('good');
    expect(verdictView({ ...base, verdict: 'stuck', recoveryMs: null }).tone).toBe('bad');
    expect(verdictView({ ...base, verdict: 'overloaded', recoveryMs: null }).text).toMatch(/Overloaded/);
    expect(['recovered', 'unaffected', 'stuck', 'overloaded'].map((v) => shortVerdict({ verdict: v as never, recoveryMs: 3000 }))).toEqual(['recovers in 3 s', 'unaffected', 'stuck', 'overloaded']);
  });

  it('maps sweep summaries to cells, marking pending and current', () => {
    const { x, y } = retryStorm.map; // traffic × failure length (ms)
    const summaries: Record<string, { verdict: 'stuck' | 'recovered' | 'unaffected' | 'overloaded'; recoveryMs: number | null; failedRequests: number }> = {
      '200,5000': { verdict: 'stuck', recoveryMs: null, failedRequests: 5 },
      '60,1000': { verdict: 'unaffected', recoveryMs: null, failedRequests: 0 },
      '80,2000': { verdict: 'recovered', recoveryMs: 2_600, failedRequests: 0 },
      '240,12000': { verdict: 'overloaded', recoveryMs: null, failedRequests: 9 },
    };
    const m = mapView('Current settings', x, y, (cx, cy) => summaries[`${cx},${cy}`], { x: 200, y: 5000 });
    expect(m.cells).toHaveLength(x.values.length * y.values.length);
    const cell = (cx: number, cy: number) => m.cells.find((c) => c.x === cx && c.y === cy)!;
    expect(cell(200, 5000)).toMatchObject({ status: 'stuck', isCurrent: true });
    expect(cell(60, 1000)).toMatchObject({ status: 'recovered', recoverySeconds: 0 });
    expect(cell(80, 2000)).toMatchObject({ status: 'recovered', recoverySeconds: 3 });
    expect(cell(240, 12000).status).toBe('overloaded'); // its own status: not the same as stuck
    expect(cell(100, 3000).status).toBe('pending');
    expect(m.formatY!(5000)).toBe('5s');
    expect(mapView('x', x, y, () => undefined, null).cells.every((c) => !c.isCurrent)).toBe(true);
  });

  it('phrases map values and the retry cascade in words', () => {
    expect(axisPhrase(retryStorm.map.y, 5000)).toBe('a 5 s failure');
    expect(axisPhrase(retryStorm.map.y, 8000)).toBe('an 8 s failure');
    expect(axisPhrase(retryStorm.map.x, 200)).toBe('200 req/s');
    expect(axisPhrase({ param: 'retries', label: 'DB retries', values: [], caller: 'api' }, 3)).toBe('3 DB retries');
    expect(
      retriesPhrase(
        [
          { caller: 'client', retries: 5 },
          { caller: 'gateway', retries: 0 },
          { caller: 'api', retries: 1 },
        ],
        labels,
      ),
    ).toBe('Client 5×, App server 1×');
    expect(retriesPhrase([{ caller: 'api', retries: 0 }], labels)).toBeNull();
  });

  it('formats axes, labels and finds tiers and bottlenecks', () => {
    expect(formatAxisValue({ param: 'outageMs', label: '', values: [] }, 10_000)).toBe('10s');
    expect(formatAxisValue({ param: 'rps', label: '', values: [] }, 120)).toBe('120');
    expect(labels.db).toBe('DB');
    expect(findTier(webChain, 'api').instances).toBe(4);
    const { config, run, analysis } = retryStormRun({ retries: 3 });
    expect(bottleneckTier(config, run)).toBe('db');
    expect(timelineView(analysis)).toEqual(analysis.timeline);
  });
});

describe('unansweredShare', () => {
  it('is the share of requests sent over 3 s that were not answered successfully', async () => {
    const { unansweredShare } = await import('./viewModels');
    const c = { sent: [100, 100, 100, 100], ok: [100, 90, 0, 0], failed: [0, 0, 0, 0] } as unknown as Parameters<typeof unansweredShare>[0];
    expect(unansweredShare(c, 0)).toBe(0);
    expect(unansweredShare(c, 1)).toBeCloseTo(0.05);
    expect(unansweredShare(c, 3)).toBeCloseTo(1 - 90 / 300);
    expect(unansweredShare({ sent: [0], ok: [0] } as unknown as Parameters<typeof unansweredShare>[0], 0)).toBe(0);
    expect(unansweredShare({ sent: [10], ok: [12] } as unknown as Parameters<typeof unansweredShare>[0], 0)).toBe(0); // answers to earlier requests
  });

  it('during the retry storm outage users see their requests unanswered, not 0% errors', async () => {
    const { buildRunConfig } = await import('../data/buildConfig');
    const { retryStorm } = await import('../data/scenarios');
    const { webChain } = await import('../data/topologies');
    const { runSimulation } = await import('../engine/run');
    const { unansweredShare, topologyView } = await import('./viewModels');
    const config = buildRunConfig(webChain, retryStorm);
    const run = runSimulation(config);
    expect(run.client.failed[45]).toBe(0); // nothing has finished failing yet…
    expect(unansweredShare(run.client, 45)).toBeGreaterThan(0.9); // …but almost nothing is answered
    const client = topologyView(webChain, config, run, 45_000).nodes.find((n) => n.id === 'client')!;
    expect(client).toMatchObject({ health: 'bad', lines: ['203 rps sent', expect.stringMatching(/^\d+% not answered$/)] });
    expect(unansweredShare(run.client, 20)).toBeLessThan(0.05);
  });
});
