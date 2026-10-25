import { renderHook, waitFor } from '@testing-library/react';
import { buildRunConfig } from '../data/buildConfig';
import { scenarios } from '../data/scenarios';
import { webChain } from '../data/topologies';
import { executeJob, type AnalyzeResult } from '../worker/jobs';
import { FakePool } from './testing/fakePool';
import { useFixRanking, type FixRankingState } from './useFixRanking';
import { labelsOf } from './viewModels';

const labels = labelsOf(webChain);
const setup = (id: string) => {
  const config = buildRunConfig(webChain, scenarios[id]);
  const result = executeJob({ kind: 'analyze', config, labels }) as AnalyzeResult;
  return { config, analysis: result.analysis, run: result.run };
};

describe('useFixRanking', () => {
  it('never returns the ranking of the previous config, not even for the render where the config changes (code review 3, finding 8)', async () => {
    const pool = new FakePool();
    const first = setup('retry-storm');
    const second = setup('cache-restart');
    const seen: Array<{ props: typeof first; state: FixRankingState }> = [];
    const { result, rerender } = renderHook(
      (props: typeof first) => {
        const state = useFixRanking(pool, props.config, props.analysis, labels, props.run);
        seen.push({ props, state });
        return state;
      },
      { initialProps: first },
    );
    await waitFor(() => expect(result.current.candidates.length).toBeGreaterThan(0));
    const before = seen.length;
    rerender(second);
    await waitFor(() => expect(result.current.candidates.length).toBeGreaterThan(0));
    // Every render with the second config shows nothing yet, or fixes made for the second config.
    const faults = (s: FixRankingState) => s.candidates.map((c) => JSON.stringify(c.config.faults));
    for (const { props, state } of seen.slice(before)) {
      expect(props).toBe(second);
      for (const f of faults(state)) expect(f).toBe(JSON.stringify(second.config.faults));
    }
    expect(seen[before].state.candidates).toEqual([]);
  }, 60_000);
});
