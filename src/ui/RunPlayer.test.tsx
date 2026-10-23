import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { retryStormRun } from '../analysis/testRuns';
import { webChain } from '../data/topologies';
import { RunPlayer } from './RunPlayer';

vi.mock('uplot', () => import('./testing/fakeUplot'));

const stuck = retryStormRun({ retries: 3 });
const recovered = retryStormRun({ retries: 0 });
const result = (r: typeof stuck) => ({ run: r.run, control: r.control, analysis: r.analysis });

describe('RunPlayer', { timeout: 60_000 }, () => {
  it('shows the topology, verdict, charts and timeline for a run', () => {
    render(<RunPlayer title="What happened" subtitle="Retry storm" topology={webChain} config={stuck.config} result={result(stuck)} />);
    expect(screen.getByRole('heading', { name: 'What happened' })).toBeTruthy();
    expect(screen.getByText('Stuck: did not recover after the failure ended')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^DB \(/ })).toBeTruthy();
    expect(screen.getByText(/Tipping point: the failure is over/)).toBeTruthy();
    expect(screen.getByText('Showing: end to end, as users see it')).toBeTruthy();
    expect(screen.getByText(/Snapshot at t = 0 s\. Click a tier/)).toBeTruthy();
  });

  it('switches metric tabs and scopes charts to a clicked tier', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Latency' }));
    expect(screen.getByText('Timeout (3 s)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^DB \(/ }));
    expect(screen.getByText('Showing: DB')).toBeTruthy();
    expect(screen.getByText('Timeout (1 s)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Client:/ }));
    expect(screen.getByText('Showing: end to end')).toBeTruthy();
  });

  it('moves the topology snapshot with the playback position', () => {
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} />);
    fireEvent.change(screen.getByLabelText('Playback position'), { target: { value: '60000' } });
    expect(screen.getByText(/Snapshot at t = 60 s/)).toBeTruthy();
  });

  it('compares before and after, switching topology and timeline between them', () => {
    render(
      <RunPlayer title="Before vs after" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} after={{ config: recovered.config, result: result(recovered) }} />,
    );
    expect(screen.getByText(/^Stuck → recovers in \d+ s$/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Why: timeline (after the fix)' })).toBeTruthy();
    expect(screen.getByText(/Back to normal: recovered/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Show run' })).getByRole('button', { name: 'Before' }));
    expect(screen.getByRole('heading', { name: 'Why: timeline (before the fix)' })).toBeTruthy();
    expect(screen.getByText(/Tipping point/)).toBeTruthy();
    expect(screen.getByText(/before the fix\. Click a tier/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'After' }));
    expect(screen.getByText(/after the fix\. Click a tier/)).toBeTruthy();
  });

  it('starts playing at 4× when asked to', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    render(<RunPlayer title="t" subtitle="s" topology={webChain} config={stuck.config} result={result(stuck)} autoPlay />);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Speed 4×' }).getAttribute('aria-pressed')).toBe('true');
    vi.unstubAllGlobals();
  });
});
