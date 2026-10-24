import { runSimulation } from './run';
import { reportSimulationProgress, withSimulationProgress } from './progress';
import { singleTier } from './testConfigs';

describe('simulation progress', () => {
  const config = singleTier(1000, { kind: 'exponential', meanMs: 5 }, 30_000);

  it('tells the listener the simulated time as the run goes, without changing the run', () => {
    const ticks: number[] = [];
    const run = withSimulationProgress((ms) => ticks.push(ms), () => runSimulation(config));
    expect(run).toEqual(runSimulation(config));
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    expect(ticks.at(-1)!).toBeLessThanOrEqual(config.durationMs);
  });

  it('restores the previous listener afterwards, even when the run throws; with none, reports go nowhere', () => {
    const outer = vi.fn();
    withSimulationProgress(outer, () => {
      expect(() => withSimulationProgress(vi.fn(), () => runSimulation({ ...config, durationMs: -1 }))).toThrow();
      reportSimulationProgress(5);
    });
    expect(outer).toHaveBeenCalledWith(5);
    expect(() => reportSimulationProgress(6)).not.toThrow();
    expect(outer).toHaveBeenCalledTimes(1);
  });
});
