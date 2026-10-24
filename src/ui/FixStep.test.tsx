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
// One retrying layer (the app server retries the DB 3 times), so the canned physics below stays simple.
const singleLayer = {
  ...webChain,
  clientCall: { ...webChain.clientCall, retries: 0 },
  tiers: webChain.tiers.map((t) => (t.downstream ? { ...t, downstream: { ...t.downstream, retries: t.id === 'api' ? 3 : 0 } } : t)),
};
const config = buildRunConfig(singleLayer, retryStorm);
const original = executeJob({ kind: 'analyze', config, labels });

/** Canned physics for the fake pool: a retry budget or ≤ 1 API→DB retry recovers; otherwise stuck above 110 rps. */
function verdict(c: RunConfig): CellSummary {
  const api = c.tiers.find((t) => t.id === 'api')!.downstream!;
  if (api.retryBudget !== undefined || api.retries <= 1 || c.client.rps <= 110) return { verdict: 'recovered', recoveryMs: 4000, failedRequests: 10 };
  return { verdict: 'stuck', recoveryMs: null, failedRequests: 9000 };
}

describe('FixStep', { timeout: 60_000 }, () => {
  it('ranks fixes, checks they hold up, and shows the chosen fix everywhere: details, maps and replay', async () => {
    const pool = new FakePool(verdict);
    render(<FixStep pool={pool} topology={singleLayer} scenario={retryStorm} config={config} original={original} labels={labels} />);
    // Once every fix is tested and checked, the best is shown and the corner explains the map.
    await screen.findByText('◆ = the run in the replay; select any cell', undefined, SLOW);
    // One tab per fix, reliable helpers first; the best one is shown straight away once checked.
    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThan(1);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].textContent).toMatch(/^✓.*4 s$/);
    expect(tabs[0].getAttribute('aria-label')).toMatch(/: helped, back to normal 4 s after the failure ended$/);
    expect(tabs.at(-1)!.textContent).toMatch(/^✕/); // fixes that did not help come last, without a badge
    expect(screen.getByText('Shown in the replay')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Retry budget of 10%' })).toBeTruthy();
    expect(screen.getByText('Stuck → recovers in 4 s')).toBeTruthy();
    expect(screen.getByText('at your settings (200 req/s, a 5 s failure)')).toBeTruthy();
    // Checked on other random runs and with a slowdown twice as long (canned physics: both hold).
    expect(screen.getByText(/helped in 5 of 5 random runs · still helps if the slowdown lasts 10 s/)).toBeTruthy();
    expect(screen.getByText('How it helps')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Cons' }).textContent).toMatch(/^Cons \(\d\)/);
    await screen.findByRole('heading', { name: /^Before vs after: Retry budget/ }, SLOW);
    await screen.findByText(/the system used to tip at 120 req\/s; with the fix it recovers at every traffic level shown/, undefined, SLOW);
    expect(screen.getByText(/^200 req\/s · a 5 s failure \(yours\) · only the fix differs$/)).toBeTruthy();
    // The "after" diagram labels what the fix changed.
    fireEvent.click(screen.getByRole('button', { name: 'After' }));
    expect(screen.getAllByText(/retry budget 10%/).length).toBeGreaterThan(0);

    // Clicking a cell in either map compares that cell, re-running it without and with the fix.
    const analyzedBefore = pool.analyzed.length;
    fireEvent.click(screen.getAllByRole('button', { name: /^80 requests per second, 2s failure length/ })[1]);
    // The ◆ moves to the clicked cell in both maps; a link goes back to the current settings.
    for (const b of screen.getAllByRole('button', { name: /^80 requests per second, 2s failure length/ })) {
      expect(b.getAttribute('aria-pressed')).toBe('true');
      expect(b.textContent).toBe('◆');
      expect(b.getAttribute('aria-label')).toMatch(/\(shown in the replay\)$/);
    }
    for (const b of screen.getAllByRole('button', { name: /^200 requests per second, 5s failure length/ })) expect(b.textContent).toBe('');
    expect(screen.getByText('Simulating 80 req/s · a 2 s failure without and with the fix…')).toBeTruthy();
    await screen.findByText(/^80 req\/s · a 2 s failure · only the fix differs$/, undefined, SLOW);
    const reruns = pool.analyzed.slice(analyzedBefore);
    expect(reruns.map((c) => c.client.rps)).toEqual([80, 80]);
    expect(reruns.map((c) => c.tiers.find((t) => t.id === 'api')!.downstream!.retryBudget)).toEqual([undefined, 0.1]);
    fireEvent.click(screen.getByRole('button', { name: 'Back to your settings (200 req/s · 5s failure length)' }));
    await screen.findByText(/^200 req\/s · a 5 s failure \(yours\) · only the fix differs$/, undefined, SLOW);
    for (const b of screen.getAllByRole('button', { name: /^200 requests per second, 5s failure length/ })) expect(b.textContent).toBe('◆');
    expect(screen.queryByRole('button', { name: /^Back to your settings/ })).toBeNull();

    // Choosing another tab shows that fix in the panel, the maps and the replay.
    fireEvent.click(tabs[1]);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    const name = tabs[1].textContent!.replace(/^✓|\d+ s$/g, '');
    await screen.findByText(new RegExp(`^After: ${name}$`), undefined, SLOW);
    await screen.findByRole('heading', { name: /^Before vs after: Cap retries/ }, SLOW);
  });

  it('flags a fix that helps only by luck or not with a longer slowdown, and ranks it below reliable ones', async () => {
    // Canned physics: the retry budget recovers only at the original seed and the original 5 s
    // slowdown; capping retries always does.
    const luck = (c: RunConfig): CellSummary => {
      const api = c.tiers.find((t) => t.id === 'api')!.downstream!;
      const fault = c.faults![0];
      if (api.retryBudget !== undefined && c.seed === config.seed && fault.endMs - fault.startMs === 5000) return { verdict: 'recovered', recoveryMs: 2000, failedRequests: 10 };
      if (api.retries <= 1) return { verdict: 'recovered', recoveryMs: 4000, failedRequests: 10 };
      return { verdict: 'stuck', recoveryMs: null, failedRequests: 9000 };
    };
    render(<FixStep pool={new FakePool(luck)} topology={singleLayer} scenario={retryStorm} config={config} original={original} labels={labels} />);
    await screen.findByText('◆ = the run in the replay; select any cell', undefined, SLOW);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('aria-label')).toMatch(/^Cap retries: helped/);
    const budget = screen.getByRole('tab', { name: /^Retry budget: helped only sometimes/ });
    expect(budget.textContent).toMatch(/^⚠/);
    fireEvent.click(budget);
    expect(screen.getByText('Helped in only 1 of 5 random runs, so the result depends on luck')).toBeTruthy();
    expect(screen.getByText("Didn't help when the slowdown lasted 10 s")).toBeTruthy();
  });

  it('waits for the original run, and reports when no fix helped', async () => {
    const { rerender } = render(<FixStep pool={new FakePool(verdict)} topology={singleLayer} scenario={retryStorm} config={config} original={null} labels={labels} />);
    expect(screen.getByText('Waiting for the original run…')).toBeTruthy();
    const neverHelps = new FakePool(() => ({ verdict: 'stuck', recoveryMs: null, failedRequests: 9000 }));
    rerender(<FixStep pool={neverHelps} topology={singleLayer} scenario={retryStorm} config={config} original={original} labels={labels} />);
    await screen.findByText(/^\d+ fixes tested$/, undefined, SLOW);
    expect(screen.getByText('None of the fixes tried made this run recover.')).toBeTruthy();
    expect(screen.getByText('No fix helped, so there is nothing to compare.')).toBeTruthy();
  });

  it('explains when there is nothing to try, instead of waiting forever', async () => {
    const calm = buildRunConfig(singleLayer, { ...retryStorm, faults: [] });
    const quiet = executeJob({ kind: 'analyze', config: calm, labels });
    render(<FixStep pool={new FakePool(verdict)} topology={singleLayer} scenario={retryStorm} config={calm} original={quiet} labels={labels} />);
    await screen.findByText(/^0 fixes tested$/, undefined, SLOW);
    expect(screen.getByText(/nothing in it points to a fix worth trying|Nothing in this run points to a fix/)).toBeTruthy();
  });

  it('shows errors from the pool', async () => {
    const pool = new FakePool(() => {
      throw new Error('worker crashed');
    });
    render(<FixStep pool={pool} topology={singleLayer} scenario={retryStorm} config={config} original={original} labels={labels} />);
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
    [120, null, /used to tip at 120 req\/s; with the fix it recovers/],
    [null, 200, /makes it tip at 200 req\/s/],
    [120, 200, /moves from 120 to 200 req\/s/],
    [200, 120, /moves down from 200 to 120 req\/s: the fix makes this worse/],
    [160, 160, /stays at 160 req\/s/],
  ])('before tips at %s, after at %s', (b, a, text) => {
    expect(moveSummary(retryStorm, result(b), result(a))).toMatch(text);
  });

  it('says so when your setting is not one of the map rows, and describes the nearest row', () => {
    const sevenSeconds = { ...retryStorm, faults: [{ ...retryStorm.faults[0], endMs: retryStorm.faults[0].startMs + 7000 }] };
    expect(moveSummary(sevenSeconds, result(120), result(null))).toBe(
      "Your setting (a 7 s failure) isn't on the map; with an 8 s failure, the system used to tip at 120 req/s; with the fix it recovers at every traffic level shown.",
    );
  });
});

describe('fixTab', () => {
  const candidate = { id: 'bound-queue', title: 't', name: 'Bound the queue', short: 'Bound queue', what: 'DB lets at most 93 wait.', how: 'It turns extra work away.', why: "requests waited in DB's queue", pros: ['p1', 'p2'], cons: ['c1', 'c2'], config };
  const original = { verdict: 'stuck' as const, recoveryMs: null, failedRequests: 1000 };
  const where = 'at your settings (200 req/s, a 5 s failure)';
  const recovered = { verdict: 'recovered' as const, recoveryMs: 2000, failedRequests: 200 };

  it('reads as plain sentences, with the checks it passed', () => {
    const t = fixTab({ candidate, outcome: recovered, helped: true }, original, { seeds: { helped: 5, of: 5 }, longer: true }, where, 10);
    expect(t).toMatchObject({
      how: 'It turns extra work away.',
      why: "Requests waited in DB's queue.",
      result: 'Stuck → recovers in 2 s',
      where,
      failed: '200 failed requests instead of 1,000',
      checks: ['helped in 5 of 5 random runs', 'still helps if the slowdown lasts 10 s'],
      badge: '2 s',
      status: 'reliable',
      cons: ['c1', 'c2'],
    });
    const checking = fixTab({ candidate, outcome: recovered, helped: true }, original, undefined, where, 10);
    expect([checking.status, checking.checks]).toEqual(['checking', ['checking whether it holds up…']]);
  });

  it('puts measured drawbacks first: more failures, helping only by luck, not holding up with a longer slowdown', () => {
    const t = fixTab({ candidate, outcome: { ...recovered, failedRequests: 1500 }, helped: true }, original, { seeds: { helped: 3, of: 5 }, longer: false }, where, 10);
    expect(t.status).toBe('unreliable');
    expect(t.checks).toEqual(['helped in 3 of 5 random runs', "doesn't help if it lasts 10 s"]);
    expect(t.cons).toEqual([
      'In this run more requests failed with it than without (1,500 vs 1,000)',
      'Helped in only 3 of 5 random runs, so the result depends on luck',
      "Didn't help when the slowdown lasted 10 s",
      'c1',
      'c2',
    ]);
  });

  it('says plainly when nothing changed', () => {
    const stuck = fixTab({ candidate, outcome: { verdict: 'stuck', recoveryMs: null, failedRequests: 1000 }, helped: false }, original, undefined, where, 10);
    expect([stuck.badge, stuck.status, stuck.checks, stuck.result, stuck.failed]).toEqual(['', 'no', [], 'No improvement: still stuck', 'no change: 1,000 failed requests']);
    const unaffected = fixTab({ candidate, outcome: { verdict: 'unaffected', recoveryMs: null, failedRequests: 0 }, helped: true }, original, { seeds: { helped: 5, of: 5 } }, where, null);
    expect([unaffected.badge, unaffected.checks]).toEqual(['0 s', ['helped in 5 of 5 random runs']]);
  });
});
