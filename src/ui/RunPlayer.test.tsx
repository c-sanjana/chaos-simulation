import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { retryStormRun } from '../analysis/testRuns';
import { webChain } from '../data/topologies';
import { RunPlayer } from './RunPlayer';

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
    expect(screen.getByText('User gives up after 3 s')).toBeTruthy();
    fireEvent.change(scope, { target: { value: 'db' } });
    expect(scope.value).toBe('db');
    expect(screen.getByText('API gives up after 1 s')).toBeTruthy();
    fireEvent.change(scope, { target: { value: 'client' } });
    expect(screen.getByText('User gives up after 3 s')).toBeTruthy();
  });

  it('opens settings for a clicked box, or all settings, when editing is enabled', () => {
    const onEdit = vi.fn();
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: /^Edit API settings/ }));
    expect(onEdit).toHaveBeenLastCalledWith('api');
    fireEvent.click(screen.getByRole('button', { name: /Edit all settings/ }));
    expect(onEdit).toHaveBeenLastCalledWith(null);
    expect(screen.getByText(/Click a box to edit that tier/)).toBeTruthy();
  });

  it('has no edit affordances without an edit handler', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} />);
    expect(screen.queryByRole('button', { name: /Edit all settings/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^API \(/ })); // harmless
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
    expect(screen.getByText(/^Stuck → recovers in \d+ s$/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Why: live timeline (after the fix)' })).toBeTruthy();
    expect(screen.getByText(/Back to normal: recovered/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Show run' })).getByRole('button', { name: 'Before' }));
    expect(screen.getByRole('heading', { name: 'Why: live timeline (before the fix)' })).toBeTruthy();
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
    const callout = screen.getByRole('status');
    expect(callout.textContent).toMatch(/The failure is over: the database is back to normal speed/);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
    fireEvent.click(within(callout).getByRole('button', { name: '▶ Keep watching' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(speed(16)).toBe('true');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    seek(37_000); // once dismissed, it doesn't pause again
    expect(screen.queryByRole('status')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('does not pause on a viewer who scrubbed past the moment', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} guided />);
    await act(async () => {});
    seek(80_000);
    seek(85_000);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('tells the story in plain words above the measured details', () => {
    const story = [
      { tMs: 30_000, text: 'At 30 s the database became 8× slower for 5 seconds.', tone: 'fault' as const },
      { tMs: 117_000, text: 'It never recovered.', tone: 'bad' as const },
    ];
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} story={story} />);
    expect(screen.getByRole('heading', { name: "What's happening, in plain words" })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Details: what was measured' })).toBeTruthy();
    seek(31_000);
    expect(screen.getByText(story[0].text)).toBeTruthy();
    expect(screen.queryByText(story[1].text)).toBeNull();
  });

  it('reveals a recovered verdict when the system gets back to normal', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={recovered.config} result={result(recovered)} autoPlay={false} />);
    const r = recovered.analysis.recovery;
    seek(r.lastFaultEndMs + (r.recoveryMs ?? 0) - 1000);
    expect(screen.queryByText(/^Recovered \d+ s after/)).toBeNull();
    seek(r.lastFaultEndMs + (r.recoveryMs ?? 0));
    expect(screen.getByText(/^Recovered \d+ s after/)).toBeTruthy();
  });
});
