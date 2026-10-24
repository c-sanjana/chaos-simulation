import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import './tour.css';

export type TourScreen = 0 | 1 | 2;
export type TourPlacement = 'top' | 'bottom' | 'left' | 'right' | 'auto';

export interface TourStop {
  /** Value of the `data-tour` attribute on the element to highlight. */
  target: string;
  /** Which step tab the target lives on. */
  screen: TourScreen;
  title: string;
  /** One or two plain sentences. */
  body: string;
  /** Preferred side for the popover; it flips to another side when there is no room. Default 'auto'. */
  placement?: TourPlacement;
  /** For a demo: the replay moment (ms into the run) this stop shows; see `onStop`. */
  atMs?: number;
}

export interface TourProps {
  stops: TourStop[];
  open: boolean;
  /** `completed` is true for Done on the last stop, false for Skip or Escape. */
  onClose: (completed: boolean) => void;
  /** Called before showing a stop on another screen so the app can switch tabs. */
  onScreen: (screen: TourScreen) => void;
  /** Called as each stop is shown (e.g. to move the replay to its `atMs`). */
  onStop?: (stop: TourStop) => void;
}

/** Space between the target's edge and the highlight ring, px. */
const SPOT_PADDING = 6;
/** Space between the highlight and the popover, px. */
const GAP = 12;
/** The popover keeps at least this far from the viewport edges (the page's 16px gutter), px. */
const MARGIN = 16;
/** How often the target is re-located and re-measured while a stop is shown, ms. */
const POLL_MS = 50;
/** After switching screens the target may mount late; after this long the popover is shown centred, ms. */
const FIND_TIMEOUT_MS = 1000;

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}
type Side = 'top' | 'bottom' | 'left' | 'right';
export interface PopoverPosition {
  top: number;
  left: number;
  side: Side | 'center';
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const AUTO_ORDER: Side[] = ['bottom', 'top', 'right', 'left'];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/**
 * Where to put a popover of size `pop` next to `target` (viewport coordinates) inside `view`.
 * Tries the preferred side, then its opposite, then the rest; if no side has room (a target
 * nearly as big as the screen), uses whichever of below/above has more. The result is always
 * clamped inside the viewport, so on a phone the popover may overlap the target rather than
 * leave the screen. With no target the popover is centred.
 */
export function placePopover(target: Box | null, pop: { width: number; height: number }, view: { width: number; height: number }, placement: TourPlacement = 'auto'): PopoverPosition {
  const fitTop = (t: number) => clamp(t, MARGIN, view.height - pop.height - MARGIN);
  const fitLeft = (l: number) => clamp(l, MARGIN, view.width - pop.width - MARGIN);
  if (!target) return { side: 'center', top: fitTop((view.height - pop.height) / 2), left: fitLeft((view.width - pop.width) / 2) };

  const bottom = target.top + target.height;
  const right = target.left + target.width;
  // Room left over on each side once the popover is placed there (negative: it does not fit).
  const room: Record<Side, number> = {
    top: target.top - GAP - MARGIN - pop.height,
    bottom: view.height - bottom - GAP - MARGIN - pop.height,
    left: target.left - GAP - MARGIN - pop.width,
    right: view.width - right - GAP - MARGIN - pop.width,
  };
  const order = placement === 'auto' ? AUTO_ORDER : [placement, OPPOSITE[placement], ...AUTO_ORDER.filter((s) => s !== placement && s !== OPPOSITE[placement])];
  const side = order.find((s) => room[s] >= 0) ?? (room.bottom >= room.top ? 'bottom' : 'top');

  const centreX = target.left + target.width / 2 - pop.width / 2;
  const centreY = target.top + target.height / 2 - pop.height / 2;
  const raw =
    side === 'bottom'
      ? { top: bottom + GAP, left: centreX }
      : side === 'top'
        ? { top: target.top - GAP - pop.height, left: centreX }
        : side === 'right'
          ? { top: centreY, left: right + GAP }
          : { top: centreY, left: target.left - GAP - pop.width };
  return { side, top: fitTop(raw.top), left: fitLeft(raw.left) };
}

/** The first visible element with `data-tour="<name>"` (the same component can appear more than once). */
function findTarget(name: string): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('[data-tour]')).filter((el) => el.dataset.tour === name);
  return all.find((el) => el.getBoundingClientRect().width > 0) ?? all[0] ?? null;
}

function viewport() {
  // clientWidth leaves out a vertical scrollbar; jsdom reports 0, hence the fallback.
  return { width: document.documentElement.clientWidth || window.innerWidth, height: document.documentElement.clientHeight || window.innerHeight };
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function scrollIntoViewIfNeeded(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const view = viewport();
  if (r.top >= 0 && r.left >= 0 && r.bottom <= view.height && r.right <= view.width) return;
  // A target taller than the screen is scrolled to its top; anything else to the middle,
  // which leaves room above or below for the popover.
  el.scrollIntoView?.({ block: r.height > view.height ? 'start' : 'center', inline: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

function spotBox(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return {
    top: Math.round(r.top - SPOT_PADDING),
    left: Math.round(r.left - SPOT_PADDING),
    width: Math.round(r.width + 2 * SPOT_PADDING),
    height: Math.round(r.height + 2 * SPOT_PADDING),
  };
}

/** finding: not located yet (popover hidden); found: highlighted; missing: gave up, popover centred. */
type Spot = { kind: 'finding' } | { kind: 'found'; box: Box } | { kind: 'missing' };
interface Measure {
  spot: Spot;
  view: { width: number; height: number };
}

const FOCUSABLE = 'button:not([disabled])';

/**
 * Spotlight walkthrough. Dims the page, rings the current stop's `[data-tour]` element and shows
 * a small dialog beside it with Back / Next (Done on the last stop) and Skip tour.
 *
 * - Before a stop on another screen it calls `onScreen`, then keeps looking for the target
 *   (it may mount a moment later); after ~1 s without it, the dialog is shown centred.
 * - The target is re-measured every 50 ms and on resize/scroll, so the ring follows layout
 *   changes, and it is scrolled into view the first time it is found.
 * - Keyboard: Escape skips, ←/→ go back/next (they stop at the ends; only Done finishes).
 *   Focus moves to Next, Tab stays inside the dialog, and focus returns to where it was on close.
 * - Page clicks are blocked while the tour is open. Motion is dropped under prefers-reduced-motion.
 */
export function Tour({ open, ...rest }: TourProps) {
  // Mounting a fresh run each time the tour opens resets it to the first stop.
  return open && rest.stops.length > 0 ? createPortal(<TourRun {...rest} />, document.body) : null;
}

function TourRun({ stops, onClose, onScreen, onStop }: Omit<TourProps, 'open'>) {
  const [index, setIndex] = useState(0);
  const [measure, setMeasure] = useState<Measure>(() => ({ spot: { kind: 'finding' }, view: viewport() }));
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const popRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const screenRef = useRef<TourScreen | null>(null);
  // Callbacks in refs so a parent re-render doesn't restart the effects below.
  const onScreenRef = useRef(onScreen);
  const onCloseRef = useRef(onClose);
  const onStopRef = useRef(onStop);
  onScreenRef.current = onScreen;
  onCloseRef.current = onClose;
  onStopRef.current = onStop;

  const stop = stops[index];
  const last = index === stops.length - 1;
  const next = () => (last ? onClose(true) : setIndex(index + 1));
  const back = () => setIndex(Math.max(0, index - 1));

  // Give focus back to whatever had it (usually the ? button) when the tour closes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => previous?.focus?.();
  }, []);

  // Keep focus inside the dialog; Back disappears on the first stop, so focus may need a new home.
  useEffect(() => {
    if (!popRef.current?.contains(document.activeElement)) nextRef.current?.focus();
  }, [index]);

  // Switch screens if needed, then locate and keep measuring the target.
  const { target, screen } = stop;
  useLayoutEffect(() => {
    if (screen !== screenRef.current) {
      screenRef.current = screen;
      onScreenRef.current(screen);
    }
    onStopRef.current?.(stops[index]);
    const deadline = Date.now() + FIND_TIMEOUT_MS;
    let scrolled = false;
    let lastKey = '';
    const update = () => {
      const el = findTarget(target);
      if (el && !scrolled) {
        scrolled = true;
        scrollIntoViewIfNeeded(el);
      }
      const spot: Spot = el ? { kind: 'found', box: spotBox(el) } : Date.now() >= deadline ? { kind: 'missing' } : { kind: 'finding' };
      const measured = { spot, view: viewport() };
      const key = JSON.stringify(measured);
      if (key !== lastKey) {
        lastKey = key;
        setMeasure(measured);
      }
    };
    update();
    const timer = setInterval(update, POLL_MS);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true); // capture: also scrolling inside panels
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [index, target, screen]);

  // Place the dialog once its size for this stop is known (before paint, so it never jumps).
  const box = measure.spot.kind === 'found' ? measure.spot.box : null;
  useLayoutEffect(() => {
    const pop = popRef.current!;
    setPos(placePopover(box, { width: pop.offsetWidth, height: pop.offsetHeight }, measure.view, stop.placement));
    // `box` is derived from `measure`, so it is not listed.
  }, [measure, index, stop.placement]);

  // Keyboard shortcuts work wherever focus is while the tour is open.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current(false);
      else if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, stops.length - 1));
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0));
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [stops.length]);

  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const items = Array.from(popRef.current!.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const lastItem = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      first.focus();
    }
  };

  const hidden = measure.spot.kind === 'finding' || pos === null;
  return (
    <div className="csl-tour">
      {/* Blocks clicks on the page; dims it itself only when there is no highlight to do so. */}
      <div className={`csl-tour__scrim${box ? '' : ' csl-tour__scrim--dim'}`} data-testid="tour-scrim" aria-hidden="true" />
      {box && <div className="csl-tour__spot" data-testid="tour-spot" aria-hidden="true" style={box} />}
      <div
        ref={popRef}
        className="csl-tour__popover"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-side={pos?.side}
        data-hidden={hidden || undefined}
        style={{ top: pos?.top ?? 0, left: pos?.left ?? 0 }}
        onKeyDown={trapTab}
      >
        {/* Focus stays on the buttons, so announce each new stop politely. */}
        <div aria-live="polite">
          <p className="csl-tour__progress">
            {index + 1} of {stops.length}
          </p>
          <h2 id={titleId} className="csl-tour__title">
            {stop.title}
          </h2>
          <p id={bodyId} className="csl-tour__body">
            {stop.body}
          </p>
        </div>
        <div className="csl-tour__actions">
          {!last && (
            <button type="button" className="csl-btn csl-btn--link csl-tour__skip" onClick={() => onClose(false)}>
              Skip tour
            </button>
          )}
          {index > 0 && (
            <button type="button" className="csl-btn" onClick={back}>
              Back
            </button>
          )}
          <button ref={nextRef} type="button" className="csl-btn csl-btn--primary" onClick={next}>
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The round "?" button for the top right of the page; it is also the tour's last stop (`data-tour="help"`). */
export function TourButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="csl-tour-button" data-tour="help" aria-label="Show the guided tour" title="Show the guided tour" onClick={onClick}>
      <span aria-hidden="true">?</span>
    </button>
  );
}
