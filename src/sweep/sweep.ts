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
  /** Smallest x at which the run is stuck, with every larger x also stuck; null if it never tips in range. */
  tipsAtX: number | null;
  /** The row is not a clean step from recovered to stuck: it flips back at least once (noisy boundary). */
  irregular: boolean;
}

/**
 * 'overloaded' (the system can't carry the traffic even without the failure) counts as the stuck
 * side, 'unaffected' as the recovered side.
 */
const stuckSide = (v: Verdict) => v === 'stuck' || v === 'overloaded';

/**
 * One tipping point per y value, in the y axis's order. Each row is read in ascending x over the
 * cells finished so far, so a partly finished map gives provisional answers.
 *
 * `irregular` is set for any row that is not of the form recovered…stuck, i.e. one that goes from
 * stuck back to recovered as traffic rises. That includes rows that flip more than once and a
 * single inverted flip (stuck at low traffic, recovered at high), which a clean step can't explain.
 */
export function tippingPoints(result: SweepResult): TippingPoint[] {
  const xs = [...result.spec.xAxis.values].sort((a, b) => a - b);
  return result.spec.yAxis.values.map((y) => {
    const row: { x: number; stuck: boolean }[] = [];
    for (const x of xs) {
      const summary = result.get(x, y);
      if (summary) row.push({ x, stuck: stuckSide(summary.verdict) });
    }
    let first = row.length; // start of the trailing run of stuck cells
    while (first > 0 && row[first - 1].stuck) first--;
    return {
      y,
      tipsAtX: first < row.length ? row[first].x : null,
      irregular: row.slice(0, first).some((c) => c.stuck),
    };
  });
}
