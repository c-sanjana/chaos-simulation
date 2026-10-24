import { useCallback, useEffect, useRef } from 'react';

interface Pending {
  selector: string;
  /** Wait until the caller says it is ready (e.g. a re-run has finished), then focus. */
  waitForReady: boolean;
}

/**
 * Moves focus somewhere sensible after a big change (a screen swapped, a re-run, a dialog
 * closed) so keyboard and screen-reader users don't land on the page body.
 *
 * `request(selector)` remembers where focus should go; after each render the first element
 * matching the selector is focused as soon as it exists (and, with `waitForReady`, once `ready`
 * is true). Headings and other non-focusable targets get tabindex="-1" so they can take focus
 * without becoming tab stops. A click or key press before then cancels the request, so focus is
 * never pulled away from where the viewer has gone meanwhile.
 */
export function usePendingFocus(ready = true): (selector: string, waitForReady?: boolean) => void {
  const pending = useRef<Pending | null>(null);

  useEffect(() => {
    const p = pending.current;
    if (!p || (p.waitForReady && !ready)) return;
    const el = document.querySelector<HTMLElement>(p.selector);
    if (!el) return;
    pending.current = null;
    if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus();
  });

  useEffect(() => {
    const cancel = () => (pending.current = null);
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
    };
  }, []);

  return useCallback((selector: string, waitForReady = false) => {
    pending.current = { selector, waitForReady };
  }, []);
}
