import { act, renderHook } from '@testing-library/react';
import { DEFAULT_SPEEDS, MAX_FRAME_MS, usePlayback } from './usePlayback';

// Manual requestAnimationFrame: tests decide when frames happen and at what timestamp.
let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextId = 1;
function frame(now: number) {
  const due = queue;
  queue = [];
  act(() => due.forEach((f) => f.cb(now)));
}

beforeEach(() => {
  queue = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, cb });
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue = queue.filter((f) => f.id !== id);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('usePlayback', () => {
  it('starts paused at 0 with the first speed', () => {
    const { result } = renderHook(() => usePlayback(120_000));
    expect(result.current).toMatchObject({ tMs: 0, playing: false, speed: 1, speeds: DEFAULT_SPEEDS });
    expect(DEFAULT_SPEEDS).toEqual([1, 4, 16]);
    expect(queue).toHaveLength(0);
  });

  it('advances at speed × real time per animation frame', () => {
    const { result } = renderHook(() => usePlayback(120_000));
    act(() => result.current.play());
    frame(1000); // first frame only sets the reference time
    expect(result.current.tMs).toBe(0);
    frame(1100);
    expect(result.current.tMs).toBe(100);
    act(() => result.current.setSpeed(16));
    frame(1200);
    expect(result.current.tMs).toBe(100 + 1600);
  });

  it('caps a long gap between frames (e.g. a background tab)', () => {
    const { result } = renderHook(() => usePlayback(120_000));
    act(() => result.current.play());
    frame(0);
    frame(60_000);
    expect(result.current.tMs).toBe(MAX_FRAME_MS);
  });

  it('pauses and stops scheduling frames', () => {
    const { result } = renderHook(() => usePlayback(120_000));
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
    frame(0);
    frame(100);
    act(() => result.current.pause());
    expect(result.current.playing).toBe(false);
    expect(queue).toHaveLength(0);
    act(() => result.current.toggle());
    expect(result.current.playing).toBe(true);
    act(() => result.current.toggle());
    expect(result.current).toMatchObject({ playing: false, tMs: 100 });
  });

  it('stops at the end, and playing again restarts from 0', () => {
    const { result } = renderHook(() => usePlayback(1000, { speeds: [4, 8] }));
    expect(result.current.speed).toBe(4);
    act(() => result.current.play());
    frame(0);
    frame(200);
    frame(400); // 1600 ms of simulated time would pass; clamped to the end
    expect(result.current).toMatchObject({ tMs: 1000, playing: false });
    expect(queue).toHaveLength(0);
    act(() => result.current.play());
    expect(result.current).toMatchObject({ tMs: 0, playing: true });
    act(() => result.current.seek(1000));
    act(() => result.current.pause());
    act(() => result.current.toggle());
    expect(result.current).toMatchObject({ tMs: 0, playing: true });
  });

  it('clamps seeks to the run, and clamps the playhead when the run gets shorter', () => {
    const { result, rerender } = renderHook(({ d }) => usePlayback(d), { initialProps: { d: 120_000 } });
    act(() => result.current.seek(-5));
    expect(result.current.tMs).toBe(0);
    act(() => result.current.seek(999_999));
    expect(result.current.tMs).toBe(120_000);
    act(() => result.current.seek(90_000));
    rerender({ d: 60_000 });
    expect(result.current.tMs).toBe(60_000);
  });

  it('cancels the pending frame on unmount', () => {
    const { result, unmount } = renderHook(() => usePlayback(120_000));
    act(() => result.current.play());
    expect(queue).toHaveLength(1);
    unmount();
    expect(queue).toHaveLength(0);
  });

  it('falls back to speed 1 when given no speeds', () => {
    const { result } = renderHook(() => usePlayback(1000, { speeds: [] }));
    expect(result.current.speed).toBe(1);
  });
});
