import { retryStormRun } from '../analysis/testRuns';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RecoveryResult } from '../analysis/recovery';
import {
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
  verdictView,
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
    expect(chartView('workers', config, run, labels, null).scopeLabel).toBe(labels[busiestTier(run)]);
    expect(chartView('errors', config, run, labels, null).spec.yMax).toBe(100);
  });

  it('stacks first attempts and retries under the capacity line on Load & retries', () => {
    const { config, run } = retryStormRun({ retries: 3 });
    const s = chartView('load', config, run, labels, 'db').spec.series;
    expect(s.map((x) => [x.label, !!x.area, !!x.dashed])).toEqual([
      ['First attempts', true, false],
      ['Retries', true, false],
      ['DB capacity', false, true],
    ]);
    expect(s[1].color).toBe(COLORS.bad);
  });

  it('scopes latency and errors to a selected tier, with the caller timeout', () => {
    const { config, run } = retryStormRun({ retries: 3 });
    const lat = chartView('latency', config, run, labels, 'db');
    expect(lat.scopeLabel).toBe('DB');
    expect(lat.spec.series.at(-1)!.label).toBe('Timeout (1 s)');
    expect(chartView('latency', config, run, labels, 'client').spec.series.at(-1)!.label).toBe('Timeout (3 s)');
    expect(chartView('errors', config, run, labels, 'api').scopeLabel).toBe('API');
    expect(chartView('load', config, run, labels, 'api').spec.series.some((x) => /capacity/.test(x.label))).toBe(false);
  });

  it('overlays before (grey) and after (blue) when comparing', () => {
    const before = retryStormRun({ retries: 3 });
    const after = retryStormRun({ retries: 0 });
    for (const tab of METRIC_TABS) {
      const v = chartView(tab.id, before.config, before.run, labels, null, after.run);
      expect(v.spec.series[0].color).toBe(COLORS.before);
      expect(v.spec.series[1].color).toBe(COLORS.primary);
      expect(v.spec.ariaLabel).toMatch(/before and after/);
    }
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
    const { x, y } = retryStorm.map;
    const summaries: Record<string, { verdict: 'stuck' | 'recovered' | 'unaffected' | 'overloaded'; recoveryMs: number | null; failedRequests: number }> = {
      '200,3': { verdict: 'stuck', recoveryMs: null, failedRequests: 5 },
      '60,0': { verdict: 'unaffected', recoveryMs: null, failedRequests: 0 },
      '80,1': { verdict: 'recovered', recoveryMs: 2_600, failedRequests: 0 },
      '240,5': { verdict: 'overloaded', recoveryMs: null, failedRequests: 9 },
    };
    const m = mapView('Current settings', x, y, (cx, cy) => summaries[`${cx},${cy}`], { x: 200, y: 3 });
    expect(m.cells).toHaveLength(x.values.length * y.values.length);
    const cell = (cx: number, cy: number) => m.cells.find((c) => c.x === cx && c.y === cy)!;
    expect(cell(200, 3)).toMatchObject({ status: 'stuck', isCurrent: true });
    expect(cell(60, 0)).toMatchObject({ status: 'recovered', recoverySeconds: 0 });
    expect(cell(80, 1)).toMatchObject({ status: 'recovered', recoverySeconds: 3 });
    expect(cell(240, 5).status).toBe('stuck');
    expect(cell(100, 2).status).toBe('pending');
    expect(m.formatY!(3)).toBe('3');
    expect(mapView('x', x, y, () => undefined, null).cells.every((c) => !c.isCurrent)).toBe(true);
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
