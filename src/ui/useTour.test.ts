import { act, renderHook } from '@testing-library/react';
import { TOUR_SEEN_KEY, useTour } from './useTour';
import { tourStops } from './tourStops';

/** An in-memory stand-in for localStorage. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: vi.fn((k: string) => data.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
  };
}

describe('useTour', () => {
  it('opens on the first visit and remembers a completed tour', () => {
    const storage = fakeStorage();
    const { result } = renderHook(() => useTour(storage));
    expect(result.current.open).toBe(true);
    act(() => result.current.close(true));
    expect(result.current.open).toBe(false);
    expect(storage.data.get(TOUR_SEEN_KEY)).toBe('completed');
  });

  it('stays closed once seen, reopens on start(), and remembers a skip', () => {
    const storage = fakeStorage({ [TOUR_SEEN_KEY]: 'completed' });
    const { result } = renderHook(() => useTour(storage));
    expect(result.current.open).toBe(false);
    act(() => result.current.start());
    expect(result.current.open).toBe(true);
    act(() => result.current.close(false));
    expect(result.current.open).toBe(false);
    expect(storage.data.get(TOUR_SEEN_KEY)).toBe('skipped');
  });

  it('opens once per load when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const { result } = renderHook(() => useTour(broken));
    expect(result.current.open).toBe(true);
    act(() => result.current.close(false));
    expect(result.current.open).toBe(false);
  });

  it('uses localStorage by default', () => {
    localStorage.removeItem(TOUR_SEEN_KEY);
    const first = renderHook(() => useTour());
    expect(first.result.current.open).toBe(true);
    act(() => first.result.current.close(true));
    expect(localStorage.getItem(TOUR_SEEN_KEY)).toBe('completed');
    expect(renderHook(() => useTour()).result.current.open).toBe(false);
    localStorage.removeItem(TOUR_SEEN_KEY);
  });
});

describe('tourStops', () => {
  it('is a short demo: about a dozen stops, each a sentence or two', () => {
    expect(tourStops.length).toBeGreaterThanOrEqual(8);
    expect(tourStops.length).toBeLessThanOrEqual(12);
    for (const stop of tourStops) expect(stop.body.split(/\s+/).length).toBeLessThanOrEqual(30);
    // About a minute of reading at ~250 words a minute, titles included.
    const words = tourStops.reduce((n, s) => n + `${s.title} ${s.body}`.split(/\s+/).length, 0);
    expect(words).toBeLessThanOrEqual(260);
  });

  it('the demo moves the replay forward through the run, on the first screen only', () => {
    const moments = tourStops.filter((s) => s.atMs !== undefined);
    expect(moments.length).toBeGreaterThanOrEqual(4);
    for (const s of moments) expect(s.screen).toBe(0);
    for (let i = 1; i < moments.length; i++) expect(moments[i].atMs!).toBeGreaterThan(moments[i - 1].atMs!);
  });

  it('starts on the first screen, never goes back a screen, and ends on the ? button', () => {
    expect(tourStops[0].screen).toBe(0);
    for (let i = 1; i < tourStops.length; i++) expect(tourStops[i].screen).toBeGreaterThanOrEqual(tourStops[i - 1].screen);
    expect(tourStops[tourStops.length - 1].target).toBe('help');
  });
});
