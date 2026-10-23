import type { RunConfig } from '../../engine/config';
import { executeJob, type AnalyzeResult, type CellSummary } from '../../worker/jobs';
import { CancelledError, type SimBatch, type SimPool } from '../../worker/pool';

/**
 * Test pool: `analyze` runs the real simulation (memoised by config), `cell` answers instantly with
 * a canned verdict so map tests stay fast. Records every job it receives.
 */
export class FakePool implements SimPool {
  readonly size = 1;
  readonly analyzed: RunConfig[] = [];
  readonly cells: RunConfig[] = [];
  disposed = false;
  private readonly memo = new Map<string, AnalyzeResult>();

  constructor(private readonly cellVerdict: (c: RunConfig) => CellSummary = defaultCellVerdict) {}

  batch(): SimBatch {
    let cancelled = false;
    const later = <T>(f: () => T) =>
      new Promise<T>((resolve, reject) =>
        setTimeout(() => {
          if (cancelled) return reject(new CancelledError('cancelled'));
          try {
            resolve(f());
          } catch (e) {
            reject(e);
          }
        }, 0),
      );
    return {
      analyze: (config, labels) => {
        this.analyzed.push(config);
        return later(() => {
          const key = JSON.stringify(config);
          if (!this.memo.has(key)) this.memo.set(key, executeJob({ kind: 'analyze', config, labels }));
          return this.memo.get(key)!;
        });
      },
      cell: (config) => {
        this.cells.push(config);
        return later(() => this.cellVerdict(config));
      },
      cancel: () => {
        cancelled = true;
      },
      get cancelled() {
        return cancelled;
      },
    };
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Stuck above 110 requests/s, otherwise recovers in a time that grows with traffic. */
export function defaultCellVerdict(c: RunConfig): CellSummary {
  return c.client.rps > 110 ? { verdict: 'stuck', recoveryMs: null, failedRequests: 1234 } : { verdict: 'recovered', recoveryMs: c.client.rps * 20, failedRequests: 0 };
}
