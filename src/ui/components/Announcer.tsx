import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/** Least time between two messages, ms: a replay at 16× can reveal several story steps a second. */
export const ANNOUNCE_INTERVAL_MS = 2000;

/**
 * Posts a message to the page's live region. A message with a `key` replaces a queued one with
 * the same key (e.g. "Simulating…" then "Simulation ready" become just the latter).
 */
export type Announce = (text: string, key?: string) => void;

const AnnounceContext = createContext<Announce>(() => {});

/** The page's announcer (a no-op outside an AnnouncerProvider, e.g. in a component's own test). */
export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}

interface Queued {
  text: string;
  key?: string;
}

/**
 * One polite, atomic live region for the whole page, mounted before anything is posted to it (a
 * region that appears together with its text is often not read). Messages are throttled to one
 * every `intervalMs`: whatever queues up meanwhile is read together in the next message, so
 * nothing is dropped and screen readers are not flooded.
 */
export function AnnouncerProvider({ children, intervalMs = ANNOUNCE_INTERVAL_MS }: { children: ReactNode; intervalMs?: number }) {
  const [message, setMessage] = useState('');
  const queue = useRef<Queued[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAt = useRef(-Infinity);

  const flush = useCallback(() => {
    timer.current = null;
    if (queue.current.length === 0) return;
    const text = queue.current.map((m) => m.text).join(' ');
    queue.current = [];
    lastAt.current = Date.now();
    setMessage(text);
  }, []);

  const announce = useCallback<Announce>(
    (text, key) => {
      if (!text) return;
      const q = queue.current;
      const i = key === undefined ? -1 : q.findIndex((m) => m.key === key);
      if (i >= 0) q[i] = { text, key };
      else q.push({ text, key });
      if (timer.current !== null) return;
      const wait = Math.max(0, lastAt.current + intervalMs - Date.now());
      timer.current = setTimeout(flush, wait);
    },
    [flush, intervalMs],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const value = useMemo(() => announce, [announce]);
  return (
    <AnnounceContext.Provider value={value}>
      {children}
      <div className="csl-sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="announcer">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}
