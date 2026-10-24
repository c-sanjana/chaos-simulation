import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { placePopover, Tour, TourButton, type TourStop } from './Tour';

const STOPS: TourStop[] = [
  { target: 'a', screen: 0, title: 'Stop A', body: 'About A.' },
  { target: 'b', screen: 0, title: 'Stop B', body: 'About B.' },
  { target: 'c', screen: 1, title: 'Stop C', body: 'About C.' },
  { target: 'nowhere', screen: 1, title: 'Stop D', body: 'Never mounts.' },
];

/** A page with screen-specific targets, a "Help" opener, and the tour wired like the app will. */
function Harness({ onClose = () => {}, onScreen = () => {}, initiallyOpen = true, stops = STOPS }: { onClose?: (c: boolean) => void; onScreen?: (s: number) => void; initiallyOpen?: boolean; stops?: TourStop[] }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [current, setCurrent] = useState(0);
  return (
    <>
      <button onClick={() => setOpen(true)}>Help</button>
      {current === 0 && (
        <>
          <div data-tour="a">A</div>
          <div data-tour="b">B</div>
        </>
      )}
      {current === 1 && <div data-tour="c">C</div>}
      <Tour
        stops={stops}
        open={open}
        onClose={(c) => (onClose(c), setOpen(false))}
        onScreen={(s) => (onScreen(s), setCurrent(s))}
      />
    </>
  );
}

/** Gives elements a layout, keyed by id or data-tour (jsdom lays nothing out, so everything is 0×0 otherwise). */
function mockRects(rects: Record<string, { top: number; left: number; width: number; height: number }>) {
  return vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    const r = rects[el.id] ?? rects[el.dataset?.tour ?? ''] ?? { top: 0, left: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  });
}

const dialog = () => screen.getByRole('dialog');
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('placePopover', () => {
  const view = { width: 1280, height: 800 };
  const pop = { width: 300, height: 150 };

  it('goes below the target, centred on it, by default', () => {
    expect(placePopover({ top: 100, left: 400, width: 200, height: 40 }, pop, view)).toEqual({ side: 'bottom', top: 152, left: 350 });
  });

  it('flips above when there is no room below', () => {
    expect(placePopover({ top: 600, left: 400, width: 200, height: 150 }, pop, view)).toEqual({ side: 'top', top: 438, left: 350 });
  });

  it('honours a preferred side, and flips to the opposite one when it does not fit', () => {
    const target = { top: 300, left: 40, width: 200, height: 100 };
    expect(placePopover(target, pop, view, 'right')).toEqual({ side: 'right', top: 275, left: 252 });
    expect(placePopover(target, pop, view, 'left')).toEqual({ side: 'right', top: 275, left: 252 });
    expect(placePopover({ ...target, left: 900 }, pop, view, 'left')).toEqual({ side: 'left', top: 275, left: 588 });
  });

  it('tries the remaining sides after the preferred one and its opposite', () => {
    // A tall, wide target: no room left or right, room below only.
    expect(placePopover({ top: 20, left: 20, width: 1240, height: 400 }, pop, view, 'left')).toMatchObject({ side: 'bottom', top: 432 });
  });

  it('uses the roomier of above/below and stays on screen when nothing fits', () => {
    const big = { top: 100, left: 0, width: 1280, height: 640 };
    expect(placePopover(big, pop, view)).toEqual({ side: 'top', top: 16, left: 490 });
    expect(placePopover({ ...big, top: 60 }, pop, view)).toEqual({ side: 'bottom', top: 634, left: 490 });
  });

  it('clamps horizontally on a phone', () => {
    const phone = { width: 375, height: 700 };
    expect(placePopover({ top: 50, left: 300, width: 60, height: 30 }, { width: 343, height: 160 }, phone)).toEqual({ side: 'bottom', top: 92, left: 16 });
  });

  it('centres the popover without a target, keeping the margin if it is larger than the screen', () => {
    expect(placePopover(null, pop, view)).toEqual({ side: 'center', top: 325, left: 490 });
    expect(placePopover(null, { width: 2000, height: 2000 }, view)).toEqual({ side: 'center', top: 16, left: 16 });
  });
});

describe('Tour', () => {
  it('renders nothing while closed or without stops', () => {
    const { rerender } = render(<Tour stops={STOPS} open={false} onClose={() => {}} onScreen={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<Tour stops={[]} open onClose={() => {}} onScreen={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a labelled dialog for the first stop and highlights its target', () => {
    mockRects({ a: { top: 100, left: 200, width: 300, height: 40 } });
    render(<Harness />);
    const d = screen.getByRole('dialog', { name: 'Stop A' });
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.getAttribute('aria-describedby')).toBe(screen.getByText('About A.').id);
    expect(screen.getByText('1 of 4')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Skip tour' })).toBeTruthy();
    expect(d.hasAttribute('data-hidden')).toBe(false);

    const spot = screen.getByTestId('tour-spot');
    expect([spot.style.top, spot.style.left, spot.style.width, spot.style.height]).toEqual(['94px', '194px', '312px', '52px']);
    expect(screen.getByTestId('tour-scrim').className).not.toContain('--dim');
    // The popover is 0×0 in jsdom: below the ring, centred on it.
    expect(d.dataset.side).toBe('bottom');
    expect([d.style.top, d.style.left]).toEqual(['158px', '350px']);
  });

  it('steps forward and back, and finishes with Done on the last stop', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('dialog', { name: 'Stop B' })).toBeTruthy();
    expect(screen.getByText('2 of 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Stop A' })).toBeTruthy();

    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('4 of 4')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skip tour' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('tells the app which stop is showing, as it is shown', () => {
    const onStop = vi.fn();
    render(<Tour stops={STOPS} open onClose={() => {}} onScreen={() => {}} onStop={onStop} />);
    expect(onStop).toHaveBeenLastCalledWith(STOPS[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onStop).toHaveBeenLastCalledWith(STOPS[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onStop).toHaveBeenLastCalledWith(STOPS[0]);
  });

  it('skips with the Skip button and with Escape', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(onClose).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    unmount();

    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves with the arrow keys, stopping at both ends', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    expect(fireEvent.keyDown(document.body, { key: 'ArrowLeft' })).toBe(false); // handled
    expect(screen.getByText('1 of 4')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(screen.getByText('2 of 4')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(screen.getByText('1 of 4')).toBeTruthy();
    for (let i = 0; i < 5; i++) fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(screen.getByText('4 of 4')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(document.body, { key: 'a' })).toBe(true); // other keys are left alone
  });

  it('asks for the right screen only when a stop is on another one, and waits for its target', () => {
    const onScreen = vi.fn();
    render(<Harness onScreen={onScreen} />);
    expect(onScreen.mock.calls).toEqual([[0]]);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onScreen.mock.calls).toEqual([[0]]);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onScreen.mock.calls).toEqual([[0], [1]]);
    // C mounts after the switch: hidden until the next measurement finds it.
    expect(dialog().hasAttribute('data-hidden')).toBe(true);
    expect(screen.queryByTestId('tour-spot')).toBeNull();
    tick(50);
    expect(dialog().hasAttribute('data-hidden')).toBe(false);
    expect(screen.getByTestId('tour-spot')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onScreen.mock.calls).toEqual([[0], [1], [0]]);
  });

  it('centres the dialog over a fully dimmed page when the target never appears', () => {
    render(<Harness />);
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    expect(screen.getByRole('dialog', { name: 'Stop D' }).hasAttribute('data-hidden')).toBe(true);
    tick(950);
    expect(dialog().hasAttribute('data-hidden')).toBe(true);
    tick(100);
    expect(dialog().hasAttribute('data-hidden')).toBe(false);
    expect(dialog().dataset.side).toBe('center');
    expect(screen.queryByTestId('tour-spot')).toBeNull();
    expect(screen.getByTestId('tour-scrim').className).toContain('csl-tour__scrim--dim');
  });

  it('follows the target when the page resizes or scrolls', () => {
    const rects = { a: { top: 100, left: 200, width: 300, height: 40 } };
    mockRects(rects);
    render(<Harness />);
    rects.a = { top: 300, left: 200, width: 300, height: 40 };
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(screen.getByTestId('tour-spot').style.top).toBe('294px');
    rects.a = { top: 50, left: 200, width: 300, height: 40 };
    act(() => void document.body.dispatchEvent(new Event('scroll')));
    expect(screen.getByTestId('tour-spot').style.top).toBe('44px');
    rects.a = { top: 60, left: 200, width: 300, height: 40 };
    tick(50); // and on the regular re-measure
    expect(screen.getByTestId('tour-spot').style.top).toBe('54px');
  });

  it('highlights the visible copy when a target appears more than once', () => {
    mockRects({ shown: { top: 10, left: 10, width: 100, height: 20 } });
    render(
      <>
        <div data-tour="a" />
        <div data-tour="a" id="shown" />
        <Tour stops={STOPS.slice(0, 1)} open onClose={() => {}} onScreen={() => {}} />
      </>,
    );
    expect(screen.getByTestId('tour-spot').style.top).toBe('4px');
  });

  describe('scrolling the target into view', () => {
    const scrollIntoView = vi.fn();
    beforeEach(() => {
      scrollIntoView.mockClear();
      Element.prototype.scrollIntoView = scrollIntoView;
    });
    afterEach(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
      delete (window as Partial<Window>).matchMedia;
    });

    it('scrolls an off-screen target to the middle once, smoothly', () => {
      mockRects({ a: { top: 2000, left: 0, width: 300, height: 40 } });
      render(<Harness />);
      tick(500);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    });

    it('scrolls a target taller than the screen to its top, without animation under reduced motion', () => {
      window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
      mockRects({ a: { top: -50, left: 0, width: 300, height: 2000 } });
      render(<Harness />);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', inline: 'nearest', behavior: 'auto' });
      expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    });

    it('leaves a target that is already on screen alone', () => {
      mockRects({ a: { top: 100, left: 0, width: 300, height: 40 } });
      render(<Harness />);
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

  describe('focus', () => {
    it('moves into the dialog on open and returns to the opener on close', () => {
      render(<Harness initiallyOpen={false} />);
      const help = screen.getByRole('button', { name: 'Help' });
      help.focus();
      fireEvent.click(help);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
      fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
      expect(document.activeElement).toBe(help);
    });

    it('restarts from the first stop when reopened', () => {
      render(<Harness initiallyOpen={false} />);
      fireEvent.click(screen.getByRole('button', { name: 'Help' }));
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      fireEvent.keyDown(document.body, { key: 'Escape' });
      fireEvent.click(screen.getByRole('button', { name: 'Help' }));
      expect(screen.getByText('1 of 4')).toBeTruthy();
    });

    it('stays in the dialog when the focused Back button disappears on the first stop', () => {
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      const back = screen.getByRole('button', { name: 'Back' });
      back.focus();
      fireEvent.click(back);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
    });

    it('keeps Tab inside the dialog', () => {
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      const skip = screen.getByRole('button', { name: 'Skip tour' });
      const back = screen.getByRole('button', { name: 'Back' });
      const next = screen.getByRole('button', { name: 'Next' });

      next.focus();
      expect(fireEvent.keyDown(next, { key: 'Tab' })).toBe(false);
      expect(document.activeElement).toBe(skip);
      expect(fireEvent.keyDown(skip, { key: 'Tab', shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe(next);

      // In the middle, Tab is left to the browser.
      back.focus();
      expect(fireEvent.keyDown(back, { key: 'Tab' })).toBe(true);
      expect(fireEvent.keyDown(back, { key: 'Tab', shiftKey: true })).toBe(true);
      expect(fireEvent.keyDown(back, { key: 'Enter' })).toBe(true);
    });
  });
});

describe('TourButton', () => {
  it('is a labelled "?" button that is also the tour target "help"', () => {
    const onClick = vi.fn();
    render(<TourButton onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Show the guided tour' });
    expect(button.dataset.tour).toBe('help');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
