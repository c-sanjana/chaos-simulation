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
  it('shows the topology, verdict and charts, and a timeline that plays along with the replay', () => {
    render(<RunPlayer title="What happened" subtitle="Retry storm" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} />);
    expect(screen.getByRole('heading', { name: 'What happened' })).toBeTruthy();
    expect(screen.getByText('Stuck: did not recover after the failure ended')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^DB \(/ })).toBeTruthy();
    expect(screen.getByText('Events appear here as the replay reaches them.')).toBeTruthy();
    seek(32_000);
    expect(screen.getByText('DB slows 8× (injected failure)')).toBeTruthy();
    expect(screen.queryByText(/Tipping point/)).toBeNull();
    expect(screen.getByText(/^\d+ more events ahead$/)).toBeTruthy();
    seek(120_000);
    expect(screen.getByText(/Tipping point: the failure is over/)).toBeTruthy();
    expect(screen.queryByText(/more events? ahead/)).toBeNull();
    expect(document.querySelectorAll('.csl-timeline__item--latest')).toHaveLength(1);
  });

  it('switches metric tabs and scopes charts with the Showing dropdown', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Latency' }));
    expect(screen.getByText('Timeout (3 s)')).toBeTruthy();
    const scope = screen.getByLabelText('Show metrics for') as HTMLSelectElement;
    fireEvent.change(scope, { target: { value: 'db' } });
    expect(scope.value).toBe('db');
    expect(screen.getByText('Timeout (1 s)')).toBeTruthy();
    fireEvent.change(scope, { target: { value: 'client' } });
    expect(screen.getByText('Timeout (3 s)')).toBeTruthy();
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
    expect(screen.getByText(/Tipping point/)).toBeTruthy();
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
});
