import type { Verdict } from '../analysis/recovery';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { ScenarioPreset } from '../data/types';
import type { RunConfig } from '../engine/config';
import { validateConfig } from '../engine/validate';
import { executeJob, type CellSummary } from '../worker/jobs';
import { CancelledError, InlinePool } from '../worker/pool';
import { SweepResult, buildSweep, runSweep, tippingPoints, type SweepSpec } from './sweep';

const tier = (config: RunConfig, id: string) => config.tiers.find((t) => t.id === id)!;

describe('buildSweep', () => {
  const spec = buildSweep(webChain, retryStorm);
  const xs = retryStorm.map.x.values;
  const ys = retryStorm.map.y.values;

  it('has one valid config per (traffic, failure length) pair, row by row', () => {
    expect(spec.xAxis).toBe(retryStorm.map.x);
    expect(spec.yAxis).toBe(retryStorm.map.y);
    expect(spec.cells).toHaveLength(xs.length * ys.length);
    expect(spec.cells.map((c) => [c.x, c.y])).toEqual(ys.flatMap((y) => xs.map((x) => [x, y])));
    for (const cell of spec.cells) expect(() => validateConfig(cell.config)).not.toThrow();
  });

  it('sets traffic and the failure length from the cell, and keeps the topology\'s retries', () => {
    for (const { x, y, config } of spec.cells) {
      expect(config.client.rps).toBe(x);
      expect(config.faults).toEqual([{ tier: 'db', kind: 'slow', factor: 8, startMs: 30_000, endMs: 30_000 + y }]);
      expect([config.client.call.retries, tier(config, 'gateway').downstream!.retries, tier(config, 'api').downstream!.retries]).toEqual([5, 3, 1]);
      expect(config.durationMs).toBe(retryStorm.durationMs);
    }
  });

  it('applies base overrides, with the axes taking precedence', () => {
    const cells = buildSweep(webChain, retryStorm, { outageMs: 99_000, seed: 9, rps: 1, retries: { client: 0 } }).cells;
    for (const { x, y, config } of cells) {
      expect(config.faults![0]).toMatchObject({ startMs: 30_000, endMs: 30_000 + y });
      expect(config.seed).toBe(9);
      expect(config.client.rps).toBe(x);
      expect(config.client.call.retries).toBe(0);
      expect(tier(config, 'gateway').downstream!.retries).toBe(3);
    }
  });

  it("maps a retries axis to its caller's retries (the API's when it names none), keeping base overrides for other callers", () => {
    const gatewayRetries: ScenarioPreset = { ...retryStorm, map: { x: retryStorm.map.x, y: { param: 'retries', label: 'Gateway retries', values: [4, 0], caller: 'gateway' } } };
    const cells = buildSweep(webChain, gatewayRetries, { retries: { client: 0, gateway: 9 } }).cells;
    expect(cells).toHaveLength(2 * xs.length);
    for (const { y, config } of cells) {
      expect(tier(config, 'gateway').downstream!.retries).toBe(y);
      expect(config.client.call.retries).toBe(0);
      expect(tier(config, 'api').downstream!.retries).toBe(1);
      expect(config.faults).toEqual(retryStorm.faults);
    }
    const apiRetries: ScenarioPreset = { ...retryStorm, map: { x: retryStorm.map.x, y: { param: 'retries', label: 'DB retries', values: [2] } } };
    for (const { config } of buildSweep(webChain, apiRetries).cells) {
      expect(tier(config, 'api').downstream!.retries).toBe(2);
      expect(tier(config, 'gateway').downstream!.retries).toBe(3);
    }
  });

  it('applies the transform to every cell\'s config', () => {
    const transform = vi.fn((c: RunConfig) => ({ ...c, tiers: c.tiers.map((t) => ({ ...t, dropExpired: true })) }));
    const cells = buildSweep(webChain, retryStorm, {}, transform).cells;
    expect(transform).toHaveBeenCalledTimes(cells.length);
    for (const { config } of cells) expect(config.tiers.every((t) => t.dropExpired)).toBe(true);
    expect(transform.mock.calls[0][0].tiers.some((t) => t.dropExpired)).toBe(false);
  });
});

/** A spec whose configs are never run, for testing results and tipping points. */
function handSpec(xs: number[], ys: number[]): SweepSpec {
  return {
    xAxis: { param: 'rps', label: 'traffic', values: xs },
    yAxis: { param: 'retries', label: 'retries', values: ys },
    cells: ys.flatMap((y) => xs.map((x) => ({ x, y, config: { seed: 0 } as RunConfig }))),
  };
}
const summary = (verdict: Verdict): CellSummary => ({ verdict, recoveryMs: null, failedRequests: 0 });

describe('SweepResult', () => {
  it('tracks finished cells', () => {
    const result = new SweepResult(handSpec([1, 2], [10, 20]));
    expect(result.total).toBe(4);
    expect(result.done).toBe(0);
    expect(result.get(1, 10)).toBeUndefined();

    result.set(2, 20, summary('stuck'));
    result.set(1, 10, summary('recovered'));
    result.set(1, 10, summary('unaffected')); // replacing a cell doesn't count twice
    expect(result.done).toBe(2);
    expect(result.get(1, 10)).toEqual(summary('unaffected'));
    expect(result.cells()).toEqual([
      { x: 1, y: 10, summary: summary('unaffected') },
      { x: 2, y: 20, summary: summary('stuck') },
    ]);
  });

  it('rejects cells that are not in the spec', () => {
    expect(() => new SweepResult(handSpec([1], [10])).set(1, 20, summary('stuck'))).toThrow('No sweep cell at x=1, y=20');
  });
});

describe('tippingPoints', () => {
  /** Builds a result from rows of verdict letters: r recovered, s stuck, o overloaded, u unaffected, . unfinished. */
  function fromRows(xs: number[], rows: [y: number, verdicts: string][]): SweepResult {
    const result = new SweepResult(handSpec(xs, rows.map(([y]) => y)));
    const verdicts: Record<string, Verdict> = { r: 'recovered', s: 'stuck', o: 'overloaded', u: 'unaffected' };
    for (const [y, row] of rows) [...row].forEach((letter, i) => letter !== '.' && result.set(xs[i], y, summary(verdicts[letter])));
    return result;
  }
  const xs = [100, 200, 300, 400];

  it('finds a clean step', () => {
    expect(tippingPoints(fromRows(xs, [[1, 'rrss']]))).toEqual([{ y: 1, tipsAtX: 300, irregular: false }]);
  });

  it('reports null for a row that never tips', () => {
    expect(tippingPoints(fromRows(xs, [[1, 'rrrr']]))).toEqual([{ y: 1, tipsAtX: null, irregular: false }]);
  });

  it('reports the first x for a row stuck everywhere', () => {
    expect(tippingPoints(fromRows(xs, [[1, 'ssss']]))).toEqual([{ y: 1, tipsAtX: 100, irregular: false }]);
  });

  it('flags a row that flips more than once, and tips where it stays stuck', () => {
    expect(tippingPoints(fromRows(xs, [[1, 'rsrs'], [2, 'srss']]))).toEqual([
      { y: 1, tipsAtX: 400, irregular: true },
      { y: 2, tipsAtX: 300, irregular: true },
    ]);
  });

  it('flags a row that goes from stuck back to recovered as traffic rises', () => {
    expect(tippingPoints(fromRows(xs, [[1, 'ssrr']]))).toEqual([{ y: 1, tipsAtX: null, irregular: true }]);
  });

  it('counts overloaded as stuck and unaffected as recovered', () => {
    expect(tippingPoints(fromRows(xs, [[1, 'uroo'], [2, 'uusr']]))).toEqual([
      { y: 1, tipsAtX: 300, irregular: false },
      { y: 2, tipsAtX: null, irregular: true },
    ]);
  });

  it('reads rows in ascending traffic whatever the axis order, keeping the y axis order', () => {
    const result = fromRows([400, 300, 200, 100], [[5, 'ssrr'], [0, 'rrrr']]);
    expect(tippingPoints(result)).toEqual([
      { y: 5, tipsAtX: 300, irregular: false },
      { y: 0, tipsAtX: null, irregular: false },
    ]);
  });

  it('uses only the finished cells of a partly finished map', () => {
    expect(tippingPoints(fromRows(xs, [[1, 'r.s.'], [2, '....']]))).toEqual([
      { y: 1, tipsAtX: 300, irregular: false },
      { y: 2, tipsAtX: null, irregular: false },
    ]);
  });
});

describe('runSweep', () => {
  // A cut-down retry storm: 2 × 2 cells, 20 s runs with the DB slowdown at 5–10 s.
  const small: ScenarioPreset = {
    ...retryStorm,
    durationMs: 20_000,
    faults: [{ tier: 'db', kind: 'slow', factor: 8, startMs: 5_000, endMs: 10_000 }],
    map: { x: { ...retryStorm.map.x, values: [60, 200] }, y: { ...retryStorm.map.y, values: [5000, 1000] } },
  };
  const spec = buildSweep(webChain, small);

  it('runs every cell and reports progress as each finishes', { timeout: 30_000 }, async () => {
    const progress: [number, number, number][] = [];
    const result = await runSweep(spec, new InlinePool().batch(), (cell, r) => {
      expect(r.get(cell.x, cell.y)).toBe(cell.summary);
      progress.push([cell.x, cell.y, r.done]);
    });
    expect(progress).toEqual([
      [60, 5000, 1],
      [200, 5000, 2],
      [60, 1000, 3],
      [200, 1000, 4],
    ]);
    expect(result.done).toBe(4);
    for (const { x, y, config } of spec.cells) expect(result.get(x, y)).toEqual(executeJob({ kind: 'cell', config }));
  });

  it('works without a progress callback', async () => {
    const result = await runSweep(handSpecWithConfigs(), new InlinePool().batch());
    expect(result.done).toBe(1);
  });

  it('rejects with CancelledError when the batch is cancelled, without reporting further cells', async () => {
    const batch = new InlinePool().batch();
    const onCell = vi.fn();
    const running = runSweep(spec, batch, onCell);
    batch.cancel();
    await expect(running).rejects.toBeInstanceOf(CancelledError);
    expect(onCell).not.toHaveBeenCalled();
  });

  it('rejects with a failing cell\'s error and cancels the rest of the batch', async () => {
    const bad = handSpecWithConfigs();
    bad.cells.unshift({ x: 0, y: 0, config: { ...bad.cells[0].config, durationMs: 0 } });
    const batch = new InlinePool().batch();
    await expect(runSweep(bad, batch)).rejects.toThrow('Invalid config');
    expect(batch.cancelled).toBe(true);
  });
});

/** A one-cell spec with a tiny, fast config. */
function handSpecWithConfigs(): SweepSpec {
  const config: RunConfig = {
    seed: 1,
    durationMs: 2000,
    client: { rps: 20, call: { target: 'svc', timeoutMs: null, retries: 0, backoffBaseMs: 0, jitter: false } },
    tiers: [{ id: 'svc', instances: 1, workersPerInstance: 1, coresPerInstance: 1, queueLimit: null, service: { kind: 'fixed', ms: 5 }, downstream: null, dropExpired: false }],
  };
  return { ...handSpec([1], [1]), cells: [{ x: 1, y: 1, config }] };
}
