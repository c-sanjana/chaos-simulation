import { fireEvent, render, screen } from '@testing-library/react';
import { PlaybackBar, type PlaybackBarProps } from './PlaybackBar';

function setup(over: Partial<PlaybackBarProps> = {}) {
  const props: PlaybackBarProps = {
    tMs: 60_400,
    durationMs: 120_000,
    playing: false,
    speed: 1,
    speeds: [1, 4, 16],
    failureWindows: [[30_000, 35_000]],
    onPlayPause: vi.fn(),
    onSeek: vi.fn(),
    onSpeed: vi.fn(),
    ...over,
  };
  const utils = render(<PlaybackBar {...props} />);
  return { props, ...utils };
}

describe('PlaybackBar', () => {
  it('shows a Play button when paused and Pause when playing', () => {
    const { props, rerender } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(props.onPlayPause).toHaveBeenCalledTimes(1);
    rerender(<PlaybackBar {...props} playing />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('shows the time readout in whole seconds', () => {
    setup();
    expect(screen.getByText('t = 60 s / 120 s')).toBeTruthy();
  });

  it('has a labelled scrubber that seeks in milliseconds', () => {
    const { props } = setup();
    const slider = screen.getByRole('slider', { name: 'Playback position' }) as HTMLInputElement;
    expect(slider.max).toBe('120000');
    expect(slider.step).toBe('1000');
    expect(slider.getAttribute('aria-valuetext')).toBe('60 seconds of 120');
    fireEvent.change(slider, { target: { value: '90000' } });
    expect(props.onSeek).toHaveBeenCalledWith(90_000);
  });

  it('draws progress and tints the failure windows on the track', () => {
    setup();
    expect(parseFloat(screen.getByTestId('scrubber-fill').style.width)).toBeCloseTo(50.333);
    const [w] = screen.getAllByTestId('scrubber-window');
    expect(w.style.left).toBe('25%');
    expect(parseFloat(w.style.width)).toBeCloseTo(4.167);
  });

  it('copes with no failure windows and a zero-length run', () => {
    setup({ failureWindows: [], durationMs: 0, tMs: 0 });
    expect(screen.queryAllByTestId('scrubber-window')).toHaveLength(0);
    expect(screen.getByTestId('scrubber-fill').style.width).toBe('0%');
    expect(screen.getByText('t = 0 s / 0 s')).toBeTruthy();
  });

  it('shows speed buttons with the current one pressed', () => {
    const { props } = setup({ speed: 4 });
    expect(screen.getByRole('group', { name: 'Playback speed' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Speed 4×' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Speed 1×' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Speed 16×' }));
    expect(props.onSpeed).toHaveBeenCalledWith(16);
  });
});
