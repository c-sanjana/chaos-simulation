import { fireEvent, render, screen } from '@testing-library/react';
import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RunConfig } from '../engine/config';
import { buildSweep, SweepResult } from '../sweep/sweep';
import { executeJob } from '../worker/jobs';
import type { CellSummary } from '../worker/jobs';
import { FixStep, fixTab, moveSummary } from './FixStep';
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
    // One tab per fix, best first; the best one is applied and compared straight away.
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThan(1);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].textContent).toMatch(/^✓.*4s$/);
    expect(tabs.at(-1)!.textContent).toMatch(/^✕/); // fixes that did not help come last, without a badge
    expect(screen.getByText('Stuck → recovers in 4 s')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Comparing' }).getAttribute('aria-pressed')).toBe('true');
    await screen.findByText(/helped on 5 of 5 random seeds/, undefined, SLOW);
    expect(screen.getByRole('heading', { name: 'Retry budget of 10%' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Cons' }).textContent).toMatch(/^Cons \(\d\)/);
    await screen.findByRole('heading', { name: /^Before vs after:/ }, SLOW);
    await screen.findByRole('heading', { name: 'Did the tipping point move?' }, SLOW);
    await screen.findByText(/the system used to tip at 120 requests\/s; with the fix it recovers at every traffic level shown/, undefined, SLOW);
    expect(screen.getByText(/^200 rps · 3 DB retries \(current settings\)\. Same traffic/)).toBeTruthy();

    // Clicking a cell in either map compares that cell, re-running it without and with the fix.
    const analyzedBefore = pool.analyzed.length;
    fireEvent.click(screen.getAllByRole('button', { name: /^80 requests per second, 1 DB retries/ })[1]);
    for (const b of screen.getAllByRole('button', { name: /^80 requests per second, 1 DB retries/ })) expect(b.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Simulating 80 rps · 1 DB retries without and with the fix…')).toBeTruthy();
    await screen.findByText(/^80 rps · 1 DB retries\. Same traffic/, undefined, SLOW);
    const reruns = pool.analyzed.slice(analyzedBefore);
    expect(reruns.map((c) => c.client.rps)).toEqual([80, 80]);
    expect(reruns.map((c) => c.tiers.find((t) => t.id === 'api')!.downstream!.retryBudget)).toEqual([undefined, 0.1]);

    // Picking another tab shows its details; applying it compares that fix instead.
    fireEvent.click(tabs[1]);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Apply & compare' }));
    expect(screen.getByRole('button', { name: 'Comparing' })).toBeTruthy();
    await screen.findByRole('heading', { name: new RegExp(`^Before vs after: .*`) }, SLOW);
    // Un-applying leaves nothing to compare.
    fireEvent.click(screen.getByRole('button', { name: 'Comparing' }));
    expect(screen.getByText(/Pick a fix and press Apply & compare/)).toBeTruthy();
    expect(screen.getByText('Apply a fix to see whether it moves the tipping point.')).toBeTruthy();
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

describe('fixTab', () => {
  const candidate = { id: 'bound-queue', title: 't', name: 'Bound the queue', short: 'Bound queue', what: 'DB lets at most 93 wait.', why: "requests waited in DB's queue", pros: ['p1', 'p2'], cons: ['c1', 'c2'], config };
  const original = { verdict: 'stuck' as const, recoveryMs: null, failedRequests: 1000 };

  it('reads as plain sentences and keeps the general cons', () => {
    const t = fixTab({ candidate, outcome: { verdict: 'recovered', recoveryMs: 2000, failedRequests: 200 }, helped: true }, original, { helped: 5, of: 5 });
    expect(t).toMatchObject({ why: "Requests waited in DB's queue.", result: 'Stuck → recovers in 2 s', failed: '200 failed requests instead of 1,000', seeds: 'helped on 5 of 5 random seeds', badge: '2s', cons: ['c1', 'c2'] });
    expect(fixTab({ candidate, outcome: { verdict: 'recovered', recoveryMs: 2000, failedRequests: 200 }, helped: true }, original, undefined).seeds).toBe('checking other seeds…');
  });

  it('puts measured drawbacks first: more failed requests, or helping on only some seeds', () => {
    const t = fixTab({ candidate, outcome: { verdict: 'recovered', recoveryMs: 2000, failedRequests: 1500 }, helped: true }, original, { helped: 3, of: 5 });
    expect(t.cons).toEqual([
      'In this run more requests failed with it than without (1,500 vs 1,000)',
      'Helped on only 3 of 5 random seeds, so the result depends on timing',
      'c1',
      'c2',
    ]);
    const stuck = fixTab({ candidate, outcome: { verdict: 'stuck', recoveryMs: null, failedRequests: 900 }, helped: false }, original, undefined);
    expect([stuck.badge, stuck.seeds, stuck.cons]).toEqual(['', '', ['c1', 'c2']]);
  });
});
