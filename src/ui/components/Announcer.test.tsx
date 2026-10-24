import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { AnnouncerProvider, useAnnounce, type Announce } from './Announcer';

let announce: Announce = () => {};
function Grab() {
  const a = useAnnounce();
  useEffect(() => {
    announce = a;
  }, [a]);
  return null;
}

const region = () => screen.getByTestId('announcer');

describe('AnnouncerProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is one polite, atomic live region that is there before anything is said', () => {
    render(
      <AnnouncerProvider>
        <Grab />
      </AnnouncerProvider>,
    );
    expect(region().getAttribute('role')).toBe('status');
    expect(region().getAttribute('aria-live')).toBe('polite');
    expect(region().getAttribute('aria-atomic')).toBe('true');
    expect(region().textContent).toBe('');
  });

  it('says the first message at once, then at most one message per interval, joining what queued up', () => {
    render(
      <AnnouncerProvider intervalMs={2000}>
        <Grab />
      </AnnouncerProvider>,
    );
    act(() => announce('Database 8× slower.'));
    act(() => void vi.advanceTimersByTime(0));
    expect(region().textContent).toBe('Database 8× slower.');
    act(() => {
      announce('The app server gives up.');
      announce('');
      announce('Database overloaded.');
    });
    act(() => void vi.advanceTimersByTime(1500));
    expect(region().textContent).toBe('Database 8× slower.'); // not yet: throttled
    act(() => void vi.advanceTimersByTime(500));
    expect(region().textContent).toBe('The app server gives up. Database overloaded.');
  });

  it('replaces a queued message that has the same key', () => {
    render(
      <AnnouncerProvider intervalMs={2000}>
        <Grab />
      </AnnouncerProvider>,
    );
    act(() => announce('first'));
    act(() => void vi.advanceTimersByTime(0));
    act(() => {
      announce('Simulating…', 'run');
      announce('Simulation ready.', 'run');
    });
    act(() => void vi.advanceTimersByTime(2000));
    expect(region().textContent).toBe('Simulation ready.');
  });

  it('does nothing outside a provider and stops its timer when unmounted', () => {
    render(<Grab />);
    expect(() => announce('ignored')).not.toThrow();
    const { unmount } = render(
      <AnnouncerProvider>
        <Grab />
      </AnnouncerProvider>,
    );
    act(() => announce('pending'));
    unmount();
    expect(() => vi.runAllTimers()).not.toThrow();
  });
});
