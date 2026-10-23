import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

/** localStorage key for the viewer's choice; index.html reads it too (same rule as initialTheme), before first paint. */
export const THEME_KEY = 'csl-theme';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function safeStorage(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Light unless the viewer chose dark (the system setting is deliberately not followed: light is
 * the default look). ASSUMPTION: storage can be missing or throw (private windows).
 */
export function initialTheme(storage: Store | null = safeStorage()): Theme {
  let saved: string | null = null;
  try {
    saved = storage?.getItem(THEME_KEY) ?? null;
  } catch {
    saved = null;
  }
  return saved === 'dark' ? 'dark' : 'light';
}

/** The theme on <html data-theme>, which every colour token keys off. */
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme, storage: Store | null = safeStorage()): void {
  document.documentElement.dataset.theme = theme;
  try {
    storage?.setItem(THEME_KEY, theme);
  } catch {
    // Not remembered across visits; the toggle still works for this page.
  }
}

/** Follows <html data-theme>, so canvas drawing (which can't use CSS variables) can redraw on a change. */
export function useThemeValue(): Theme {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** A colour token's current value, or the fallback when it isn't set (e.g. in jsdom). */
export function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Light/dark switch for the top bar. */
export function ThemeToggle() {
  const theme = useThemeValue();
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="csl-icon-button" aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`} onClick={() => applyTheme(next)}>
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
    </button>
  );
}
