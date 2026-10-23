import { analyzeRun } from '../analysis/analyze';
import { assessRecovery, controlConfig } from '../analysis/recovery';
import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RunConfig } from '../engine/config';
import { runSimulation } from '../engine/run';
import { singleTier } from '../engine/testConfigs';
import { executeJob } from './jobs';

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

  it('throws on an invalid config', () => {
    expect(() => executeJob({ kind: 'cell', config: { ...config, durationMs: -1 } })).toThrow('Invalid config');
  });

  describe('retry-storm preset at 200 requests/s', { timeout: 30_000 }, () => {
    it('is stuck with 3 API → DB retries', () => {
      expect(executeJob({ kind: 'cell', config: buildRunConfig(webChain, retryStorm, { rps: 200, retries: 3 }) }).verdict).toBe('stuck');
    });

    it('recovers with no retries', () => {
      expect(executeJob({ kind: 'cell', config: buildRunConfig(webChain, retryStorm, { rps: 200, retries: 0 }) }).verdict).toBe('recovered');
    });
  });
});
