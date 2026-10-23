import { useCallback, useState } from 'react';

/** Bump the version to show the tour again to everyone after it changes substantially. */
export const TOUR_SEEN_KEY = 'csl-tour-seen-v1';

type TourStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Reading `window.localStorage` can itself throw, so this is only called inside try blocks. */
const orLocal = (storage?: TourStorage): TourStorage => storage ?? window.localStorage;

/**
 * Whether the guided tour is open. It opens by itself on the first visit and is remembered as
 * seen once closed, whether finished or skipped; `start()` replays it (the "?" button).
 *
 * Storage can throw (private browsing, blocked site data). Then the tour counts as unseen, so it
 * opens once per page load, and closing it simply isn't remembered.
 */
export function useTour(storage?: TourStorage): { open: boolean; start(): void; close(completed: boolean): void } {
  const [open, setOpen] = useState(() => {
    try {
      return orLocal(storage).getItem(TOUR_SEEN_KEY) === null;
    } catch {
      return true;
    }
  });

  const start = useCallback(() => setOpen(true), []);
  const close = useCallback(
    (completed: boolean) => {
      setOpen(false);
      try {
        orLocal(storage).setItem(TOUR_SEEN_KEY, completed ? 'completed' : 'skipped');
      } catch {
        // Not remembered; the tour will open again on the next load.
      }
    },
    [storage],
  );
  return { open, start, close };
}
