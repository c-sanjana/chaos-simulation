import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { acrossNumbers, FixTabs, rankedFirstReason, tabLabel, type FixTab } from './FixTabs';

const tab = (over: Partial<FixTab>): FixTab => ({
  id: 'retry-budget',
  short: 'Retry budget',
  name: 'Retry budget of 10%',
  what: 'API stops retrying DB once retries reach 10% of first attempts.',
  how: 'Repeats stop piling up, so the database can catch up.',
  why: "Retries made up 74% of DB's load.",
  result: 'Stuck → recovers in 3 s',
  where: 'at your settings (200 req/s · 3 DB retries)',
  failed: '40 failed requests instead of 12,687',
  checks: ['helped in 5 of 5 random runs', 'still helps if the slowdown lasts 10 s'],
  badge: '3 s',
  status: 'reliable',
  recoverySeconds: 3,
  failedCount: 40,
  pros: ['Stops retries from multiplying load', 'Cheap: a client setting, no new servers'],
  cons: ['Callers see errors sooner during a real outage', 'The calling code must count its retries', 'A third con'],
  ...over,
});
const tabs = [
  tab({}),
  tab({ id: 'cap-retries', short: 'Cap retries', name: 'Cap retries at 1', badge: '13 s', status: 'unreliable', result: 'Stuck → recovers in 13 s', recoverySeconds: 13 }),
  tab({ id: 'jitter', short: 'Jitter', name: 'Exponential backoff with full jitter', result: 'No improvement: still stuck', badge: '', status: 'no', checks: [], recoverySeconds: null }),
];

beforeEach(() => sessionStorage.clear());

const openMore = () => fireEvent.click(screen.getByRole('button', { name: 'More about this fix' }));

describe('FixTabs', () => {
  it('names each tab with its outcome, marking fixes that help only sometimes', () => {
    render(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} />);
    const [first, second] = screen.getAllByRole('tab');
    expect(first.getAttribute('aria-selected')).toBe('true'); // defaults to the first (best) fix
    // Each row: mark, name, time to recover, failed requests (the numbers compare at a glance).
    expect(first.textContent).toBe('✓Retry budget3 s40 failed');
    expect(first.getAttribute('aria-label')).toBe('Retry budget: helped, back to normal 3 s after the failure ended; 40 failed requests');
    expect(second.textContent).toBe('⚠Cap retries13 s40 failed');
    expect(second.getAttribute('aria-label')).toBe('Cap retries: helped only sometimes, back to normal 13 s after the failure ended; 40 failed requests');
    fireEvent.click(screen.getByRole('button', { name: "Tried, didn't help (1)" }));
    const third = screen.getByRole('tab');
    expect(third.textContent).toBe('✕Jitter40 failed');
    expect(third.getAttribute('aria-label')).toBe('Jitter: did not help; 40 failed requests');
    expect(tabLabel(tab({ status: 'checking', badge: '', failedCount: 12687 }))).toBe('Retry budget: helped (checking whether it holds up); 12,687 failed requests');
  });

  it('leads the panel with the result where it was measured and one line on why', () => {
    const verdict = { title: 'Why it worked', text: 'Repeats fell, so the database could catch up.' };
    const { rerender } = render(<FixTabs tabs={[{ ...tabs[0], verdict }, ...tabs.slice(1)]} selectedId="retry-budget" onSelect={() => {}} />);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('fix-tab-retry-budget');
    expect(within(panel).getByRole('heading', { name: 'Retry budget of 10%' })).toBeTruthy();
    expect(within(panel).getByText('Shown in the replay')).toBeTruthy();
    const result = panel.querySelector('.csl-fixtabs__result')!;
    // A fix that held up: the failed requests under the result; the checks wait under "More".
    expect(result.textContent).toBe('Stuck → recovers in 3 s at your settings (200 req/s · 3 DB retries)40 failed requests instead of 12,687');
    expect(result.querySelector('b')!.className).toBe('csl-fixtabs__good');
    expect(panel.querySelector('.csl-fixtabs__why')!.textContent).toBe('Why it worked: Repeats fell, so the database could catch up.');
    // Until the run with the fix is measured, the why line says so.
    rerender(<FixTabs tabs={tabs} selectedId="retry-budget" onSelect={() => {}} />);
    expect(within(screen.getByRole('tabpanel')).getByText('Working out why…')).toBeTruthy();
    // A fix that helped only sometimes: the checks are its caveat, so they stay next to the result.
    rerender(<FixTabs tabs={tabs} selectedId="cap-retries" onSelect={() => {}} />);
    expect(screen.getByRole('tabpanel').querySelector('.csl-fixtabs__detail')!.textContent).toBe('40 failed requests instead of 12,687 · helped in 5 of 5 random runs · still helps if the slowdown lasts 10 s');
  });

  it('keeps how it works, why it was suggested, the checks and the pros and cons under "More about this fix", closed at first', () => {
    const { unmount } = render(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} />);
    const more = screen.getByRole('button', { name: 'More about this fix' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('How it works')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Pros' })).toBeNull();
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const details = document.getElementById(more.getAttribute('aria-controls')!)!;
    expect(within(details).getByText('How it works').nextElementSibling!.textContent).toBe('Repeats stop piling up, so the database can catch up.');
    expect(within(details).getByText('Why it was suggested').nextElementSibling!.textContent).toBe("Retries made up 74% of DB's load.");
    expect(within(details).getByText('Checks').nextElementSibling!.textContent).toBe('helped in 5 of 5 random runs · still helps if the slowdown lasts 10 s');
    expect(within(details).getByRole('region', { name: 'Pros' })).toBeTruthy();
    // Remembered for the session, for every fix.
    unmount();
    render(<FixTabs tabs={tabs} selectedId="cap-retries" onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'More about this fix' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('How it works')).toBeTruthy();
    openMore(); // closes it again
    expect(screen.queryByText('How it works')).toBeNull();
    expect(sessionStorage.getItem('csl-fix-more-open')).toBe('0');
  });

  it('labels a retry fix one layer or whole stack, and shows its end-to-end multiplication as numbers', () => {
    const across = "Every layer that retries changes together. If every call fails, retries can multiply the calls reaching the database up to 48× (users' apps 6 × the load balancer 4 × the app server 2). With this fix: up to 1.3× (1.1 × 1.1 × 1.1).";
    const stack = tab({ id: 'retry-budget-every-layer', short: 'Budget, all layers', scope: 'stack', acrossStack: across });
    const { rerender } = render(<FixTabs tabs={[stack, tabs[2]]} selectedId={null} onSelect={() => {}} />);
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText('Whole stack').className).toContain('csl-fixtabs__scope--stack');
    const line = panel.querySelector('.csl-fixtabs__across')!;
    expect(line.querySelector('[aria-hidden="true"]')!.textContent).toBe("48× → 1.3× calls reaching the database if every call failsusers' apps 6 × the load balancer 4 × the app server 2 → 1.1 × 1.1 × 1.1");
    expect(line.querySelector('.csl-sr-only')!.textContent).toBe(across); // read out as the sentence
    openMore();
    expect(within(panel).getByText('Across the stack').nextElementSibling!.textContent).toBe(across);
    expect(screen.getAllByRole('tab')[0].getAttribute('aria-label')).toBe('Budget, all layers: helped, back to normal 3 s after the failure ended; 40 failed requests'); // the name says it
    expect(tabLabel(tab({ short: 'Retry at one layer', scope: 'stack', status: 'no', badge: '' }))).toBe('Retry at one layer (whole stack): did not help; 40 failed requests');
    expect(tabLabel(tab({ short: 'Cap retries at 1', scope: 'layer', status: 'no', badge: '' }))).toBe('Cap retries at 1 (one layer): did not help; 40 failed requests');
    // A sentence that isn't the usual multiplication is shown as it is.
    const odd = "Only one layer changes. This fix changes the app server's calls to the database: up to 12× → 6.6× through them.";
    rerender(<FixTabs tabs={[tab({ scope: 'layer', acrossStack: odd }), tabs[2]]} selectedId={null} onSelect={() => {}} />);
    expect(within(screen.getByRole('tabpanel')).getByText('One layer')).toBeTruthy();
    expect(screen.getByRole('tabpanel').querySelector('.csl-fixtabs__across')!.textContent).toBe(`Across the stack: ${odd}`);
    // Not a retry fix: neither label nor line.
    rerender(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} />);
    expect(screen.queryByText(/Across the stack/)).toBeNull();
    expect(screen.queryByText('One layer')).toBeNull();
  });

  it('lists pros and cons with their counts, so several cons are never missed', () => {
    render(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} />);
    openMore();
    expect(within(screen.getByRole('region', { name: 'Pros' })).getByRole('heading').textContent).toBe('Pros (2)');
    const cons = screen.getByRole('region', { name: 'Cons' });
    expect(within(cons).getByRole('heading').textContent).toBe('Cons (3)');
    expect(within(cons).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '−Callers see errors sooner during a real outage',
      '−The calling code must count its retries',
      '−A third con',
    ]);
  });

  it('shows the chosen fix, colouring its result by whether it helped reliably', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<FixTabs tabs={tabs} selectedId="jitter" onSelect={onSelect} />);
    expect(within(screen.getByRole('tabpanel')).getByText('No improvement: still stuck').className).toBe('csl-fixtabs__bad');
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(onSelect).toHaveBeenCalledWith('cap-retries');
    rerender(<FixTabs tabs={tabs} selectedId="cap-retries" onSelect={onSelect} />);
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('tabpanel')).getByText('Stuck → recovers in 13 s').className).toBe('csl-fixtabs__warn');
  });

  it('renders nothing when there are no fixes (the step explains why)', () => {
    const { container } = render(<FixTabs tabs={[]} selectedId={null} onSelect={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('explains its marks and numbers on screen, and why the first fix is first', () => {
    render(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} />);
    expect(document.getElementById('fix-tabs-key-helped')!.textContent).toBe('✓ held up⚠ only sometimes12 s = time to recover');
    expect(screen.getByRole('tablist').getAttribute('aria-describedby')).toBe('fix-tabs-key-helped');
    openMore();
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText("Why it's ranked first").nextElementSibling!.textContent).toBe('It held up in the checks; Cap retries helped only sometimes.');
    fireEvent.click(screen.getByRole('button', { name: "Tried, didn't help (1)" }));
    expect(screen.getByRole('tablist').getAttribute('aria-describedby')).toBe('fix-tabs-key-not');
    expect(document.getElementById('fix-tabs-key-not')!.textContent).toBe("✕ didn't help, or only by luck");
  });

  it("shows the run's own reason it worked or didn't, and the rank reason only on the first fix", () => {
    const verdict = { title: "Why it didn't help here", text: "Users' apps (5×) still retry, so the database still had up to 3.2× the work it can handle." };
    const { rerender } = render(<FixTabs tabs={[tabs[0], { ...tabs[2], verdict }]} selectedId="jitter" onSelect={() => {}} />);
    const panel = screen.getByRole('tabpanel');
    expect(panel.querySelector('.csl-fixtabs__why')!.textContent).toBe(`Why it didn't help here: ${verdict.text}`);
    openMore();
    expect(within(panel).queryByText("Why it's ranked first")).toBeNull();
    rerender(<FixTabs tabs={[tab({ status: 'rare', badge: '2 s' })]} selectedId={null} onSelect={() => {}} />);
    const rare = screen.getByRole('tab');
    expect(rare.textContent).toMatch(/^✕/); // helped once in five: luck, marked like no help
    expect(rare.className).toContain('csl-fixtab--rare');
    expect(rare.getAttribute('aria-label')).toBe('Retry budget: helped only by luck, back to normal 2 s after the failure ended; 40 failed requests');
    expect(within(screen.getByRole('tabpanel')).getByText('Stuck → recovers in 3 s').className).toBe('csl-fixtabs__bad');
  });
});

describe('FixTabs views: fixes that helped, and the ones tried that did not', () => {
  const mixed = [
    tab({}),
    tab({ id: 'cap-retries', short: 'Cap retries', status: 'unreliable', badge: '13 s' }),
    tab({ id: 'checking', short: 'Bound queue', status: 'checking' }),
    tab({ id: 'jitter', short: 'Jitter', status: 'no', badge: '' }),
    tab({ id: 'lucky', short: 'Lucky', status: 'rare', badge: '2 s' }),
  ];
  const names = () => screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label')!.split(':')[0]);

  it('splits the fixes by whether they helped, fully or partly, and shows the helped ones first', () => {
    render(<FixTabs tabs={mixed} selectedId={null} onSelect={() => {}} />);
    const helped = screen.getByRole('button', { name: 'Fixes that helped (3)' });
    const not = screen.getByRole('button', { name: "Tried, didn't help (2)" });
    expect(helped.getAttribute('aria-pressed')).toBe('true');
    expect(not.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('tablist', { name: 'Fixes that helped' })).toBeTruthy();
    expect(names()).toEqual(['Retry budget', 'Cap retries', 'Bound queue']); // reliable, sometimes, still checking
    fireEvent.click(not);
    expect(not.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('tablist', { name: "Fixes that didn't help" })).toBeTruthy();
    expect(names()).toEqual(['Jitter', 'Lucky']); // did not help, and only by luck
  });

  it('switching views keeps the chosen fix in the panel; choosing in either view shows that fix', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<FixTabs tabs={mixed} selectedId="cap-retries" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: "Tried, didn't help (2)" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('fix-tab-cap-retries');
    expect(screen.getAllByRole('tab').every((t) => t.getAttribute('aria-selected') === 'false')).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: /^Lucky/ }));
    expect(onSelect).toHaveBeenCalledWith('lucky');
    rerender(<FixTabs tabs={mixed} selectedId="lucky" onSelect={onSelect} />);
    expect(screen.getByRole('tab', { name: /^Lucky/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('fix-tab-lucky');
    // Back to the helped view: the lucky fix is still the one shown.
    fireEvent.click(screen.getByRole('button', { name: 'Fixes that helped (3)' }));
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('fix-tab-lucky');
  });

  it('sorts a fix into the other view when its checks come in, without changing the chosen fix or the view', () => {
    const { rerender } = render(<FixTabs tabs={mixed} selectedId="checking" onSelect={() => {}} />);
    rerender(<FixTabs tabs={mixed.map((t) => (t.id === 'checking' ? { ...t, status: 'rare' as const } : t))} selectedId="checking" onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'Fixes that helped (2)' }).getAttribute('aria-pressed')).toBe('true');
    expect(names()).toEqual(['Retry budget', 'Cap retries']);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('fix-tab-checking');
  });

  it('opens the second view with a note when nothing helped', () => {
    const none = [tab({ id: 'a', short: 'A', status: 'no', badge: '' }), tab({ id: 'b', short: 'B', status: 'rare' })];
    render(<FixTabs tabs={none} selectedId={null} onSelect={() => {}} noneHelped="None of the fixes tried made this run recover." />);
    expect(screen.getByRole('button', { name: "Tried, didn't help (2)" }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('None of the fixes tried made this run recover.')).toBeTruthy();
    expect(names()).toEqual(['A', 'B']);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('fix-tab-a');
    expect(screen.queryByText('Shown in the replay')).toBeNull(); // nothing chosen, so nothing replayed
    fireEvent.click(screen.getByRole('button', { name: 'Fixes that helped (0)' }));
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('leaves the switch out when every fix helped', () => {
    render(<FixTabs tabs={mixed.slice(0, 3)} selectedId={null} onSelect={() => {}} noneHelped="None helped." />);
    expect(screen.queryByRole('group', { name: 'Which fixes to list' })).toBeNull();
    expect(screen.queryByText('None helped.')).toBeNull();
    expect(names()).toEqual(['Retry budget', 'Cap retries', 'Bound queue']);
  });
});

describe('acrossNumbers', () => {
  const whole = "If every call fails, retries can multiply the calls reaching the database up to 48× (users' apps 6 × the load balancer 4 × the app server 2).";
  it("reads the multiplication out of the sentence, or null when it can't", () => {
    expect(acrossNumbers(`Only one layer changes. ${whole} With this fix: up to 26× (6 × 4 × 1.1).`)).toEqual({
      target: 'the database',
      before: '48',
      beforeFactors: "users' apps 6 × the load balancer 4 × the app server 2",
      after: '26',
      afterFactors: '6 × 4 × 1.1',
    });
    expect(acrossNumbers(`Every layer that retries changes together. ${whole} With this fix: up to 2×.`)).toMatchObject({ after: '2', afterFactors: null });
    expect(acrossNumbers(`Only one layer changes. ${whole} This fix leaves that at 48×.`)).toMatchObject({ before: '48', after: '48', afterFactors: null });
    // A numbered name keeps its own brackets: "App server 2 (2)".
    expect(acrossNumbers("… reaching DB up to 12× (users' apps 3 × App server 2 (2)). With this fix: up to 6×.")!.beforeFactors).toBe("users' apps 3 × App server 2 (2)");
    expect(acrossNumbers(`Only one layer changes. ${whole} This fix changes the API's calls to the database: up to 12× → 6.6× through them.`)).toBeNull();
    expect(acrossNumbers('Something else.')).toBeNull();
  });
});

describe('rankedFirstReason', () => {
  const a = tab({ id: 'a', short: 'A' });
  it('names the key that puts the first fix ahead of the runner-up', () => {
    expect(rankedFirstReason([a])).toBe('It is the only fix that held up here.');
    expect(rankedFirstReason([tab({ status: 'unreliable' }), tab({ status: 'no' })])).toBe('It is the only fix that helped at all, though only sometimes.');
    expect(rankedFirstReason([a, tab({ short: 'B', status: 'rare' })])).toBe('It is the only fix that held up here.');
    expect(rankedFirstReason([a, tab({ short: 'B', recoverySeconds: 9 })])).toBe('It got back to normal soonest: 3 s after the failure ended, against 9 s for B.');
    expect(rankedFirstReason([a, tab({ short: 'B', recoverySeconds: null })])).toBe('It got back to normal soonest: 3 s after the failure ended, against never for B.');
    expect(rankedFirstReason([a, tab({ short: 'B', recoverySeconds: 4, failedCount: 1200 })])).toBe('It got back to normal about as soon as B (3 s and 4 s) but failed fewer requests (40 against 1,200).');
    expect(rankedFirstReason([a, tab({ short: 'B', recoverySeconds: 3, failedCount: 40 })])).toMatch(/^It ranks first by the checks it passed/);
    expect(rankedFirstReason([tab({ status: 'no' })])).toBeNull();
  });
});

describe('FixTabs keyboard', () => {
  // Three fixes that helped, so all three are in one list (the roving tab stop is per list).
  const tabs = [tab({}), tab({ id: 'cap-retries', short: 'Cap retries', status: 'unreliable' }), tab({ id: 'jitter', short: 'Jitter', status: 'checking' })];
  it('is one tab stop; ←/→/Home/End move focus (wrapping) and Enter or a click chooses', () => {
    const onSelect = vi.fn();
    render(<FixTabs tabs={tabs} selectedId="cap-retries" onSelect={onSelect} />);
    const all = screen.getAllByRole('tab');
    expect(all.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    act(() => all[1].focus());
    fireEvent.keyDown(all[1], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(all[2]);
    expect(all.map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
    fireEvent.keyDown(all[2], { key: 'ArrowRight' }); // wraps
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(all[2]);
    fireEvent.keyDown(all[2], { key: 'Home' });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: 'End' });
    expect(document.activeElement).toBe(all[2]);
    fireEvent.keyDown(all[2], { key: 'x' });
    expect(document.activeElement).toBe(all[2]);
    // Moving focus doesn't choose (choosing re-simulates); Enter/Space click the focused tab.
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(all[2]);
    expect(onSelect).toHaveBeenCalledWith('jitter');
  });

  it('puts the tab stop back on the chosen tab when focus leaves the list, and the panel is focusable', () => {
    render(
      <>
        <FixTabs tabs={tabs} selectedId="retry-budget" onSelect={() => {}} />
        <button type="button">after</button>
      </>,
    );
    const all = screen.getAllByRole('tab');
    act(() => all[0].focus());
    fireEvent.keyDown(all[0], { key: 'ArrowRight' });
    expect(all[1].tabIndex).toBe(0);
    fireEvent.blur(all[1], { relatedTarget: screen.getByRole('button', { name: 'after' }) });
    expect(all.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getByRole('tabpanel').tabIndex).toBe(0);
  });

  it('moves within the list on screen only', () => {
    const mixed = [tab({}), tab({ id: 'b', short: 'B', status: 'no', badge: '' }), tab({ id: 'c', short: 'C', status: 'no', badge: '' })];
    render(<FixTabs tabs={mixed} selectedId="retry-budget" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: "Tried, didn't help (2)" }));
    const list = screen.getAllByRole('tab');
    expect(list.map((t) => t.tabIndex)).toEqual([0, -1]); // the chosen fix is in the other list
    act(() => list[0].focus());
    fireEvent.keyDown(list[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(list[1]);
    fireEvent.keyDown(list[1], { key: 'ArrowRight' }); // wraps within this list
    expect(document.activeElement).toBe(list[0]);
    // The lists run down the panel, so ↓/↑ move too.
    fireEvent.keyDown(list[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(list[1]);
    fireEvent.keyDown(list[1], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(list[0]);
  });
});
