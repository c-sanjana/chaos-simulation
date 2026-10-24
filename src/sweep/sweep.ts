/**
 * The tipping-point map: run a scenario over a grid of (traffic, y-axis setting) and find, per
 * row, the traffic at which the system stops recovering from the failure.
 *
 * Specs and results are plain data plus small objects; the runner fans cells out through a
 * `SimBatch`, so it works with the worker pool or the in-process pool alike.
 */
import type { Verdict } from '../analysis/recovery';
import type { RunConfig } from '../engine/config';
import { buildRunConfig, type ScenarioOverrides } from '../data/buildConfig';
import type { Axis, ScenarioPreset, TopologyPreset } from '../data/types';
import type { CellSummary } from '../worker/jobs';
import type { SimBatch } from '../worker/pool';

export interface SweepCellSpec {
  x: number;
  y: number;
  config: RunConfig;
}

export interface SweepSpec {
  xAxis: Axis;
  yAxis: Axis;
  /** One per (x, y), row by row in the y axis's order, each row in the x axis's order. */
  cells: SweepCellSpec[];
}

/**
 * One cell per (x, y) on the scenario's map axes: the scenario with `base` overrides and the
 * cell's axis values (a retries axis varies its caller's retries; other params set the override of
 * the same name), then the optional transform (used to apply a fix to every cell).
 */
export function buildSweep(
  topology: TopologyPreset,
  scenario: ScenarioPreset,
  base: ScenarioOverrides = {},
  transform: (c: RunConfig) => RunConfig = (c) => c,
): SweepSpec {
  const { x: xAxis, y: yAxis } = scenario.map;
  const cells: SweepCellSpec[] = [];
  for (const y of yAxis.values) {
    for (const x of xAxis.values) {
      const overrides: ScenarioOverrides = { ...base };
      for (const [axis, v] of [[xAxis, x], [yAxis, y]] as const) {
        // A retries axis varies one caller's retries; the others set the override of the same name.
        if (axis.param === 'retries') overrides.retries = { ...overrides.retries, [axis.caller ?? 'api']: v };
        else overrides[axis.param] = v;
      }
      cells.push({ x, y, config: transform(buildRunConfig(topology, scenario, overrides)) });
    }
  }
  return { xAxis, yAxis, cells };
}

export interface SweepCellResult {
  x: number;
  y: number;
  summary: CellSummary;
}

const cellKey = (x: number, y: number) => `${x},${y}`;

/** The map's results so far: a summary for each finished cell. */
export class SweepResult {
  private readonly summaries = new Map<string, CellSummary>();
  private readonly validKeys: Set<string>;

  constructor(readonly spec: SweepSpec) {
    this.validKeys = new Set(spec.cells.map((c) => cellKey(c.x, c.y)));
  }

  set(x: number, y: number, summary: CellSummary): void {
    const key = cellKey(x, y);
    if (!this.validKeys.has(key)) throw new Error(`No sweep cell at x=${x}, y=${y}`);
    this.summaries.set(key, summary);
  }

  get(x: number, y: number): CellSummary | undefined {
    return this.summaries.get(cellKey(x, y));
  }

  /** Finished cells. */
  get done(): number {
    return this.summaries.size;
  }

  get total(): number {
    return this.validKeys.size;
  }

  /** Finished cells, in the spec's order. */
  cells(): SweepCellResult[] {
    const out: SweepCellResult[] = [];
    for (const { x, y } of this.spec.cells) {
      const summary = this.get(x, y);
      if (summary) out.push({ x, y, summary });
    }
    return out;
  }
}

/**
 * Runs every cell through the batch, calling `onCell` as each finishes (in completion order).
 * Resolves with the full result. Rejects with `CancelledError` if the batch is cancelled; if a cell
 * fails, rejects with its error and cancels the batch so the remaining cells stop.
 */
export async function runSweep(
  spec: SweepSpec,
  batch: SimBatch,
  onCell?: (cell: SweepCellResult, result: SweepResult) => void,
): Promise<SweepResult> {
  const result = new SweepResult(spec);
  try {
    await Promise.all(
      spec.cells.map(async ({ x, y, config }) => {
        const summary = await batch.cell(config);
        result.set(x, y, summary);
        onCell?.({ x, y, summary }, result);
      }),
    );
  } catch (e) {
    batch.cancel();
    throw e;
  }
  return result;
}

export interface TippingPoint {
  y: number;
  /**
   * The tipping point: the smallest x at which the run gets stuck (a 'stuck' verdict, not
   * 'overloaded'), with every larger x on the failing side too (stuck or overloaded). Null if the
   * row never tips in range, including a row that is only overloaded.
   */
  tipsAtX: number | null;
  /** The row is not a clean step from recovered to stuck: it flips back at least once (noisy boundary). */
  irregular: boolean;
  /** The lowest x with a stuck cell anywhere in the row (for "around X–Y" on an irregular row); null if none. */
  firstStuckX: number | null;
  /**
   * From this x on, every finished cell is 'overloaded': too much traffic even without the
   * failure. Null if the row doesn't end overloaded. Overload is not a tipping point.
   */
  overloadedFromX: number | null;
}

/**
 * The failing side of a row: 'stuck' (did not recover after the failure) and 'overloaded' (can't
 * carry the traffic even without the failure). 'unaffected' counts as the recovered side.
 */
const failingSide = (v: Verdict) => v === 'stuck' || v === 'overloaded';

/**
 * One tipping point per y value, in the y axis's order. Each row is read in ascending x over the
 * cells finished so far, so a partly finished map gives provisional answers.
 *
 * The tipping point is computed from stuck cells only (PLAN.md, 2026-10-24): an overloaded cell
 * fails without any failure, so it says nothing about where a failure starts to stick. Overloaded
 * cells still count as the failing side when deciding whether a row is a clean step, and a row
 * that ends overloaded reports where that starts (`overloadedFromX`).
 *
 * `irregular` is set for any row that is not of the form recovered…failing, i.e. one that goes
 * from stuck or overloaded back to recovered as traffic rises. That includes rows that flip more
 * than once and a single inverted flip (stuck at low traffic, recovered at high), which a clean
 * step can't explain.
 */
export function tippingPoints(result: SweepResult): TippingPoint[] {
  const xs = [...result.spec.xAxis.values].sort((a, b) => a - b);
  return result.spec.yAxis.values.map((y) => {
    const row: { x: number; verdict: Verdict }[] = [];
    for (const x of xs) {
      const summary = result.get(x, y);
      if (summary) row.push({ x, verdict: summary.verdict });
    }
    let first = row.length; // start of the trailing run of failing cells
    while (first > 0 && failingSide(row[first - 1].verdict)) first--;
    let overloaded = row.length; // start of the trailing run of overloaded cells
    while (overloaded > 0 && row[overloaded - 1].verdict === 'overloaded') overloaded--;
    const tip = row.slice(first).find((c) => c.verdict === 'stuck');
    return {
      y,
      tipsAtX: tip?.x ?? null,
      irregular: row.slice(0, first).some((c) => failingSide(c.verdict)),
      firstStuckX: row.find((c) => c.verdict === 'stuck')?.x ?? null,
      overloadedFromX: overloaded < row.length ? row[overloaded].x : null,
    };
  });
}
