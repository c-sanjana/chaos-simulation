import { fireEvent, render, screen } from '@testing-library/react';
import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RunConfig } from '../engine/config';
import { buildSweep, SweepResult } from '../sweep/sweep';
import { executeJob } from '../worker/jobs';
import type { CellSummary } from '../worker/jobs';
import { FixStep, moveSummary } from './FixStep';
import { FakePool } from './testing/fakePool';
import { labelsOf } from './viewModels';

vi.mock('uplot', () => import('./testing/fakeUplot'));

const SLOW = { timeout: 30_000 };
const labels = labelsOf(webChain);
const config = buildRunConfig(webChain, retryStorm);
const original = executeJob({ kind: 'analyze', config, labels });

/** Canned physics for the fake pool: a retry budget or ≤ 1 API→DB retry recovers; otherwise stuck above 110 rps. */
function verdict(c: RunConfig): CellSummary {
  const api = c.tiers.find((t) => t.id === 'api')!.downstream!;
  if (api.retryBudget !== undefined || api.retries <= 1 || c.client.rps <= 110) return { verdict: 'recovered', recoveryMs: 4000, failedRequests: 10 };
  return { verdict: 'stuck', recoveryMs: null, failedRequests: 9000 };
}

describe('FixStep', { timeout: 60_000 }, () => {
  it('ranks fixes by measured effect, checks seeds, and compares runs and maps after Apply', async () => {
    const pool = new FakePool(verdict);
    render(<FixStep pool={pool} topology={webChain} scenario={retryStorm} config={config} original={original} labels={labels} />);
    await screen.findByText(/^\d+ fixes tested$/, undefined, SLOW);
    expect(screen.getAllByText('Stuck → recovers in 4 s').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/retry budget/i).length).toBeGreaterThan(0);
    await screen.findAllByText(/helps in 5 of 5 seeds/, undefined, SLOW);
    expect(screen.getByRole('button', { name: /fixes tried that did not help/ })).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: /^Apply & compare/ })[0]);
    await screen.findByRole('heading', { name: /^Before vs after:/ }, SLOW);
    await screen.findByRole('heading', { name: 'Did the tipping point move?' }, SLOW);
    await screen.findByText(/the system used to tip at 120 requests\/s; with the fix it recovers at every traffic level shown/, undefined, SLOW);
  });

  it('waits for the original run, and reports when no fix helped', async () => {
    const { rerender } = render(<FixStep pool={new FakePool(verdict)} topology={webChain} scenario={retryStorm} config={config} original={null} labels={labels} />);
    expect(screen.getByText('Waiting for the original run…')).toBeTruthy();
    const neverHelps = new FakePool(() => ({ verdict: 'stuck', recoveryMs: null, failedRequests: 9000 }));
    rerender(<FixStep pool={neverHelps} topology={webChain} scenario={retryStorm} config={config} original={original} labels={labels} />);
    await screen.findByText(/^\d+ fixes tested$/, undefined, SLOW);
    expect(screen.getByText('None of the fixes tried made this run recover.')).toBeTruthy();
  });

  it('shows errors from the pool', async () => {
    const pool = new FakePool(() => {
      throw new Error('worker crashed');
    });
    render(<FixStep pool={pool} topology={webChain} scenario={retryStorm} config={config} original={original} labels={labels} />);
    await screen.findByText(/worker crashed/, undefined, SLOW);
  });
});

describe('moveSummary', () => {
  const spec = buildSweep(webChain, retryStorm);
  const result = (stuckFrom: number | null) => {
    const r = new SweepResult(spec);
    for (const c of spec.cells) r.set(c.x, c.y, stuckFrom !== null && c.x >= stuckFrom ? { verdict: 'stuck', recoveryMs: null, failedRequests: 1 } : { verdict: 'recovered', recoveryMs: 1000, failedRequests: 0 });
    return r;
  };
  it.each([
    [null, null, /recovered at every traffic level shown, before and after/],
    [120, null, /used to tip at 120 requests\/s; with the fix it recovers/],
    [null, 200, /makes it tip at 200 requests\/s/],
    [120, 200, /moves from 120 to 200 requests\/s/],
    [200, 120, /moves down from 200 to 120 requests\/s: the fix makes this worse/],
    [160, 160, /stays at 160 requests\/s/],
  ])('before tips at %s, after at %s', (b, a, text) => {
    expect(moveSummary(retryStorm, result(b), result(a))).toMatch(text);
  });
});
