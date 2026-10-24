import { analyzeRun } from '../analysis/analyze';
import { assessRecovery, controlConfig } from '../analysis/recovery';
import { buildRunConfig } from '../data/buildConfig';
import { cacheRestart, retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RunConfig } from '../engine/config';
import { runSimulation } from '../engine/run';
import { singleTier } from '../engine/testConfigs';
import { cellSummaryOf, executeJob, PROGRESS_INTERVAL_MS } from './jobs';

// A small real run: one tier, slowed down for a second.
const config: RunConfig = {
  ...singleTier(50, { kind: 'exponential', meanMs: 5 }, 5000, {}, { timeoutMs: 200 }),
  faults: [{ tier: 'svc', kind: 'slow', factor: 4, startMs: 1000, endMs: 2000 }],
};

describe('executeJob', () => {
  const run = runSimulation(config);
  const control = runSimulation(controlConfig(config));

  it('analyze: returns the run, its no-failure control, and the analysis', () => {
    const labels = { svc: 'Service' };
    expect(executeJob({ kind: 'analyze', config, labels })).toEqual({ run, control, analysis: analyzeRun(run, control, config, labels) });
  });

  it('cell: returns only the recovery summary', () => {
    const { verdict, recoveryMs, failedRequests } = assessRecovery(run, control, config);
    const summary = executeJob({ kind: 'cell', config });
    expect(summary).toEqual({ verdict, recoveryMs, failedRequests });
    expect(Object.keys(summary).sort()).toEqual(['failedRequests', 'recoveryMs', 'verdict']);
  });

  it('cellSummaryOf an analysis is exactly the cell job of the same config (a cache relies on it)', () => {
    expect(cellSummaryOf(executeJob({ kind: 'analyze', config, labels: {} }))).toEqual(executeJob({ kind: 'cell', config }));
  });

  it('reports progress now and then, from 0 to 1 over the run and its control, without changing the result', () => {
    let wall = 0;
    // Each call to the clock moves wall time on, as a slow run would.
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (wall += PROGRESS_INTERVAL_MS));
    try {
      const fractions: number[] = [];
      const big = { ...config, durationMs: 60_000, client: { ...config.client, rps: 400 } };
      const result = executeJob({ kind: 'cell', config: big }, (f) => fractions.push(f));
      expect(result).toEqual(executeJob({ kind: 'cell', config: big }));
      expect(fractions.length).toBeGreaterThan(2);
      expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
      expect(fractions[0]).toBeGreaterThan(0);
      expect(fractions.at(-1)!).toBeLessThanOrEqual(1);
      expect(fractions.some((f) => f > 0.5)).toBe(true); // the control's half too
    } finally {
      now.mockRestore();
    }
  });

  it('stays quiet while the job is quicker than the reporting interval', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      const onProgress = vi.fn();
      executeJob({ kind: 'cell', config: { ...config, durationMs: 60_000, client: { ...config.client, rps: 400 } } }, onProgress);
      expect(onProgress).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('throws on an invalid config', () => {
    expect(() => executeJob({ kind: 'cell', config: { ...config, durationMs: -1 } })).toThrow('Invalid config');
  });

  describe('retry-storm preset at 200 requests/s', { timeout: 30_000 }, () => {
    it('is stuck with 3 App server → DB retries', () => {
      expect(executeJob({ kind: 'cell', config: buildRunConfig(webChain, retryStorm, { rps: 200, retries: { client: 0, gateway: 0, api: 3 } }) }).verdict).toBe('stuck');
    });

    it('is stuck with the default retries at every layer', () => {
      expect(executeJob({ kind: 'cell', config: buildRunConfig(webChain, retryStorm) }).verdict).toBe('stuck');
    });

    it('cellSummaryOf matches the cell job for the preset failures too', () => {
      for (const scenario of [retryStorm, cacheRestart]) {
        const c = buildRunConfig(webChain, scenario);
        expect(cellSummaryOf(executeJob({ kind: 'analyze', config: c, labels: {} }))).toEqual(executeJob({ kind: 'cell', config: c }));
      }
    });
    it('recovers with no retries', () => {
      expect(executeJob({ kind: 'cell', config: buildRunConfig(webChain, retryStorm, { rps: 200, retries: { client: 0, gateway: 0, api: 0 } }) }).verdict).toBe('recovered');
    });
  });
});
