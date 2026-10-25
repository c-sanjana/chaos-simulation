import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AnnouncerProvider } from './components/Announcer';
import { retryStormRun } from '../analysis/testRuns';
import { webChain } from '../data/topologies';
import { failureOverText, RunPlayer } from './RunPlayer';

vi.mock('uplot', () => import('./testing/fakeUplot'));

const stuck = retryStormRun({ retries: 3 });
const recovered = retryStormRun({ retries: 0 });
const result = (r: typeof stuck) => ({ run: r.run, control: r.control, analysis: r.analysis });
const seek = (ms: number) => fireEvent.change(screen.getByLabelText('Playback position'), { target: { value: String(ms) } });

describe('RunPlayer', { timeout: 60_000 }, () => {
  it('shows the topology and charts, a timeline that plays along, and the verdict only once the replay reaches it', () => {
    render(<RunPlayer title="What happened" subtitle="Retry storm" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} />);
    expect(screen.getByRole('heading', { name: 'What happened' })).toBeTruthy();
    expect(screen.queryByText('Stuck: did not recover after the failure ended')).toBeNull();
    expect(screen.getByText(/^Replaying… the verdict comes/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^DB \(/ })).toBeTruthy();
    expect(screen.getByText('Events appear here as the replay reaches them.')).toBeTruthy();
    seek(32_000);
    // The track has a marker for each event reached, and spells out the newest.
    expect(document.querySelector('.csl-track__detail')).not.toBeNull();
    expect(screen.getByRole('button', { name: /DB slows 8× \(injected failure\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByText('DB slows 8× (injected failure)')).toBeTruthy();
    expect(screen.queryByText(/Point of no return/)).toBeNull();
    expect(screen.getByText(/^\d+ more events ahead$/)).toBeTruthy();
    seek(120_000);
    expect(screen.getByText('Stuck: did not recover after the failure ended')).toBeTruthy();
    expect(screen.getByText(/Point of no return: the failure is over/)).toBeTruthy();
    expect(screen.queryByText(/more events? ahead/)).toBeNull();
    expect(document.querySelectorAll('.csl-timeline__item--latest')).toHaveLength(1);
  });

  it('starts on Load & retries, names the tier each tab really shows, and scopes charts with the Showing dropdown', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} />);
    expect(screen.getByRole('button', { name: 'Load & retries' }).getAttribute('aria-pressed')).toBe('true');
    const scope = screen.getByLabelText('Show metrics for') as HTMLSelectElement;
    expect(scope.options[0].text).toBe('DB (most overloaded)');
    fireEvent.click(screen.getByRole('button', { name: 'Latency' }));
    expect(scope.options[0].text).toBe('End to end (users)');
    expect(screen.getByText("Users' apps give up on one try after 3 s")).toBeTruthy();
    expect(screen.getByText(/The wait includes every retry/)).toBeTruthy(); // the note under the legend
    fireEvent.change(scope, { target: { value: 'db' } });
    expect(scope.value).toBe('db');
    expect(screen.getByText('App server gives up after 1 s')).toBeTruthy();
    fireEvent.change(scope, { target: { value: 'client' } });
    expect(screen.getByText("Users' apps give up on one try after 3 s")).toBeTruthy();
  });

  it('opens settings for a clicked box, or all settings, when editing is enabled', () => {
    const onEdit = vi.fn();
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: /^Edit App server settings/ }));
    expect(onEdit).toHaveBeenLastCalledWith('api');
    fireEvent.click(screen.getByRole('button', { name: /Edit all settings/ }));
    expect(onEdit).toHaveBeenLastCalledWith(null);
    expect(screen.getByText(/Select a box to edit that tier/)).toBeTruthy();
  });

  it('has no edit affordances without an edit handler', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} />);
    expect(screen.queryByRole('button', { name: /Edit all settings/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^App server \(/ })); // harmless
  });

  it('moves the topology snapshot with the playback position', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} />);
    seek(60_000);
    expect(screen.getByText(/Snapshot at t = 60 s/)).toBeTruthy();
  });

  it('compares before and after, switching topology and timeline between them', () => {
    render(
      <RunPlayer
        title="Before vs after"
        subtitle="s"
        topology={webChain}
        config={stuck.config}
        result={result(stuck)}
        after={{ config: recovered.config, result: result(recovered) }}
        autoPlay={false}
      />,
    );
    seek(120_000);
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByText(/^Stuck → recovers in \d+ s$/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Details: what was measured (after the fix)' })).toBeTruthy();
    expect(screen.getByText(/Back to normal: recovered/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Show run' })).getByRole('button', { name: 'Before' }));
    expect(screen.getByRole('heading', { name: 'Details: what was measured (before the fix)' })).toBeTruthy();
    expect(screen.getByText(/Point of no return/)).toBeTruthy();
    expect(screen.getByText(/before the fix\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'After' }));
    expect(screen.getByText(/after the fix\./)).toBeTruthy();
  });

  it('plays at 16× by default, and restarts from the beginning when a new run arrives', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { rerender } = render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Speed 16×' }).getAttribute('aria-pressed')).toBe('true');
    seek(90_000);
    rerender(<RunPlayer title="t" subtitle="s" topology={webChain} config={recovered.config} result={result(recovered)} />);
    await act(async () => {});
    expect(screen.getByText(/Snapshot at t = 0 s/)).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('opens paused at a given moment (the end, after the tour), and replays from the start on request', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { rerender } = render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} openAtMs={120_000} guided />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.getByText(/Snapshot at t = 120 s/)).toBeTruthy();
    expect(screen.getByText('Stuck: did not recover after the failure ended')).toBeTruthy();
    // Same run, new restart key: from the start, playing.
    rerender(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} restartKey={1} guided />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByText(/Snapshot at t = 0 s/)).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('tells the run shown in a compact story when asked (step 2 and 3 replays)', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} after={{ config: recovered.config, result: result(recovered) }} autoPlay={false} sideTimeline compactStory />);
    const story = screen.getByRole('region', { name: 'What is happening, in plain words' });
    expect(story.className).toContain('csl-story--compact');
    expect(story.closest('.csl-player__sidestack')).not.toBeNull();
    seek(120_000);
    // The "after" run (shown by default) recovered: its newest step says so.
    expect(within(story).getAllByRole('listitem')).toHaveLength(1);
    expect(within(story).getByText(/back to normal/i, { selector: '.csl-flow__headline' })).toBeTruthy();
    fireEvent.click(within(story).getByRole('button', { name: /^Why: back to normal/i }));
    expect(within(story).getByText(/back to normal/i, { selector: '.csl-flow__text' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Before' }));
    expect(within(screen.getByRole('region', { name: 'What is happening, in plain words' })).getByText('Still stuck')).toBeTruthy();
  });

  it('waits while held (e.g. under the guided tour) and plays from the start when released', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { rerender } = render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} holdPlayback />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    rerender(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} holdPlayback={false} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByText(/Snapshot at t = 0 s/)).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('guides a first viewing: slows to 4× before the failure and pauses just after it ends', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} guided />);
    await act(async () => {});
    const speed = (x: number) => screen.getByRole('button', { name: `Speed ${x}×` }).getAttribute('aria-pressed');
    seek(27_500);
    expect(speed(4)).toBe('true');
    seek(36_600);
    const callout = document.querySelector<HTMLElement>('.csl-guide')!;
    expect(callout.textContent).toMatch(/The failure is over: the database is back to normal speed/);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    fireEvent.click(within(callout).getByRole('button', { name: '▶ Keep watching' }));
    expect(document.querySelector('.csl-guide')).toBeNull();
    expect(speed(16)).toBe('true');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    seek(37_000); // once dismissed, it doesn't pause again
    expect(document.querySelector('.csl-guide')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('plays forward to the demo’s moment and stops there', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} demoAtMs={20_000} />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    seek(21_000); // the replay gets past the moment: it stops on it
    expect(Number((screen.getByLabelText('Playback position') as HTMLInputElement).value)).toBe(20_000);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('does not pause on a viewer who scrubbed past the moment', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} guided />);
    await act(async () => {});
    seek(80_000);
    seek(85_000);
    expect(document.querySelector('.csl-guide')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('tells the story in plain words above the measured details', () => {
    const story = [
      { tMs: 30_000, text: 'At 30 s the database became 8× slower for 5 seconds.', tone: 'fault' as const },
      { tMs: 117_000, text: 'It never recovered.', tone: 'bad' as const },
    ];
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} story={story} />);
    expect(screen.getByRole('heading', { name: "What's happening" })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Details: what was measured' })).toBeTruthy();
    seek(31_000);
    expect(screen.getByTitle(story[0].text)).toBeTruthy();
    expect(screen.queryByTitle(story[1].text)).toBeNull();
  });

  it('shows the end panel only once the replay reaches the end, and hides it again for a new run', () => {
    const end = <p>Compared with your last run</p>;
    const { rerender } = render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} endPanel={end} />);
    seek(60_000);
    expect(screen.queryByText('Compared with your last run')).toBeNull();
    seek(stuck.run.durationMs);
    expect(screen.getByText('Compared with your last run')).toBeTruthy();
    seek(60_000); // looking back keeps it
    expect(screen.getByText('Compared with your last run')).toBeTruthy();
    rerender(<RunPlayer title="t" subtitle="s" topology={webChain} config={recovered.config} result={result(recovered)} autoPlay={false} endPanel={end} />);
    expect(screen.queryByText('Compared with your last run')).toBeNull();
  });

  it('reveals a recovered verdict when the system gets back to normal', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={recovered.config} result={result(recovered)} autoPlay={false} />);
    const r = recovered.analysis.recovery;
    seek(r.lastFaultEndMs + (r.recoveryMs ?? 0) - 1000);
    expect(screen.queryByText(/^Recovered \d+ s after/)).toBeNull();
    seek(r.lastFaultEndMs + (r.recoveryMs ?? 0));
    expect(screen.getByText(/^Recovered \d+ s after/)).toBeTruthy();
  });

  it('says what "the failure is over" means for whichever part failed last', () => {
    const labels = { db: 'DB', cache: 'Cache', gateway: 'Load balancer' };
    expect(failureOverText([{ tier: 'db', kind: 'slow', factor: 8, startMs: 0, endMs: 5000 }], labels)).toBe('the database is back to normal speed');
    expect(failureOverText([{ tier: 'cache', kind: 'dead', flushAtEnd: true, startMs: 0, endMs: 5000 }], labels)).toBe('the cache is back up, but empty');
    expect(
      failureOverText(
        [
          { tier: 'db', kind: 'slow', factor: 8, startMs: 0, endMs: 5000 },
          { tier: 'gateway', kind: 'dead', startMs: 0, endMs: 9000 },
        ],
        labels,
      ),
    ).toBe('the load balancer is back up');
  });
});

describe('RunPlayer accessibility', { timeout: 60_000 }, () => {
  const story = [
    { tMs: 30_000, text: 'At 30 s the database became 8× slower for 5 seconds.', tone: 'fault' as const },
    { tMs: 31_000, text: 'The app server gave up and everyone asked again.', tone: 'bad' as const },
    { tMs: 117_000, text: 'It never recovered.', tone: 'bad' as const },
  ];
  const announcer = () => screen.getByTestId('announcer');

  it('announces story steps as the replay reveals them, and the verdict, in the page live region (throttled)', () => {
    vi.useFakeTimers();
    const player = (r = stuck) => (
      <AnnouncerProvider>
        <RunPlayer title="t" subtitle="s" topology={webChain} config={r.config} result={result(r)} autoPlay={false} story={story} />
      </AnnouncerProvider>
    );
    const { rerender } = render(player());
    seek(31_000);
    act(() => void vi.advanceTimersByTime(2000));
    expect(announcer().textContent).toBe(`${story[0].text} ${story[1].text}`);
    seek(10_000); // seeking back says nothing, and re-arms the steps
    seek(30_000);
    act(() => void vi.advanceTimersByTime(2000));
    expect(announcer().textContent).toBe(story[0].text);
    seek(120_000);
    act(() => void vi.advanceTimersByTime(2000));
    expect(announcer().textContent).toBe(`${story[1].text} ${story[2].text} Stuck: did not recover after the failure ended`);
    // A new run starts quietly from the beginning.
    rerender(player(recovered));
    act(() => void vi.advanceTimersByTime(2000));
    expect(announcer().textContent).not.toMatch(/never recovered.*never recovered/);
    vi.useRealTimers();
  });

  it('announces the before/after outcome in words in compare mode', () => {
    vi.useFakeTimers();
    render(
      <AnnouncerProvider>
        <RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} after={{ config: recovered.config, result: result(recovered) }} autoPlay={false} />
      </AnnouncerProvider>,
    );
    act(() => void vi.advanceTimersByTime(2000));
    expect(announcer().textContent).toMatch(/^Before the fix: stuck\. After the fix: (recovers in \d+ s|unaffected)\.$/);
    vi.useRealTimers();
  });

  it('announces the guided pause', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    render(
      <AnnouncerProvider intervalMs={0}>
        <RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} guided />
      </AnnouncerProvider>,
    );
    await act(async () => {});
    seek(36_600);
    await waitFor(() => expect(announcer().textContent).toMatch(/Paused: the failure is over: the database is back to normal speed\./));
    vi.unstubAllGlobals();
  });

  it('respects reduced motion: no autoplay, and 4× when played', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduced-motion'), addEventListener: () => {}, removeEventListener: () => {} }));
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} guided />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Speed 4×' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    seek(36_600);
    fireEvent.click(screen.getByRole('button', { name: '▶ Keep watching' }));
    expect(screen.getByRole('button', { name: 'Speed 4×' }).getAttribute('aria-pressed')).toBe('true');
    vi.unstubAllGlobals();
  });

  it('gives the title a focus target, and can put the story above the chart', () => {
    const { container } = render(
      <RunPlayer title="What happened" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} story={story} headingId="step-heading" storyAbove />,
    );
    const heading = screen.getByRole('heading', { name: 'What happened' });
    expect(heading.id).toBe('step-heading');
    expect(heading.tabIndex).toBe(-1);
    const above = container.querySelector('.csl-player__story')!;
    expect(within(above as HTMLElement).getByRole('heading', { name: "What's happening" })).toBeTruthy();
    // The story comes before the charts in reading order, and isn't repeated by the timeline.
    expect(above.compareDocumentPosition(container.querySelector('.csl-player__charts')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: "What's happening" })).toHaveLength(1);
  });

  it('describes the chart in words and can show it as a table of what has been revealed', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} />);
    const chart = screen.getByRole('img', { name: /^Load & retries/ });
    const summary = document.getElementById(chart.getAttribute('aria-describedby')!)!;
    expect(summary.textContent).toMatch(/^Users' new requests \+ Repeats \(from any layer\) \(total\): about \d+ rps until 0 s \(so far\)/);
    seek(60_000);
    expect(summary.textContent).toMatch(/Above DB capacity/);
    fireEvent.click(screen.getByRole('button', { name: 'Show as table' }));
    const table = screen.getByRole('region', { name: /as a table$/ });
    expect(within(table).getAllByRole('row')).toHaveLength(14); // header + 0, 5, …, 60 s
    expect(screen.queryByRole('img', { name: /^Load & retries/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show as chart' }));
    expect(screen.getByRole('img', { name: /^Load & retries/ })).toBeTruthy();
  });

  it('lists the tier behind the default scope once ("DB (most overloaded)", not DB again)', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} />);
    const scope = screen.getByLabelText('Show metrics for') as HTMLSelectElement;
    expect(Array.from(scope.options).map((o) => o.text)).toEqual(['DB (most overloaded)', 'Load balancer', 'App server', 'Cache']);
    // Picked on a tab where it isn't the default, then back on Load & retries: shown as the default.
    fireEvent.click(screen.getByRole('button', { name: 'Latency' }));
    fireEvent.change(scope, { target: { value: 'db' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load & retries' }));
    expect(scope.value).toBe('client');
  });
});
