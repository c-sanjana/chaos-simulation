/**
 * Keeps a malformed browser language from blanking the page (REVIEW2 2.7). Measured in Chromium
 * with the language set to "en-US@posix": `navigator.language` reports that tag, and the chart
 * library (uPlot) runs `new Intl.NumberFormat(navigator.language)` when it loads, which throws
 * "Invalid language tag" before anything renders, so not even an error boundary can show a
 * message. This module is imported first (main.tsx) and, only when the tag is unusable, makes
 * `navigator.language(s)` report a usable one: the tag without its "@…"/".…" suffix, else 'en-US'.
 */

/** `tag` if Intl accepts it; otherwise the tag without its suffix if that works; otherwise 'en-US'. */
export function usableLanguage(tag: string): string {
  const works = (t: string) => {
    try {
      new Intl.NumberFormat(t);
      return t !== '';
    } catch {
      return false;
    }
  };
  if (works(tag)) return tag;
  const base = tag.split(/[@.]/)[0].replace(/_/g, '-');
  return works(base) ? base : 'en-US';
}

/** Makes `nav.language` and `nav.languages` report usable tags; returns whether it had to. */
export function guardLocale(nav: Pick<Navigator, 'language' | 'languages'> | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  if (!nav) return false;
  const language = usableLanguage(nav.language ?? '');
  if (language === nav.language) return false;
  const languages = [language, ...(nav.languages ?? []).map(usableLanguage).filter((l) => l !== language)];
  Object.defineProperty(nav, 'language', { configurable: true, get: () => language });
  Object.defineProperty(nav, 'languages', { configurable: true, get: () => languages });
  return true;
}

guardLocale();
