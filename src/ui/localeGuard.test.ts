import { formatCount } from './format';
import { guardLocale, usableLanguage } from './localeGuard';

describe('usableLanguage', () => {
  it('keeps a valid tag, strips a malformed suffix, and falls back to en-US', () => {
    expect(usableLanguage('de-DE')).toBe('de-DE');
    expect(usableLanguage('en-US@posix')).toBe('en-US');
    expect(usableLanguage('en_GB.UTF-8')).toBe('en-GB');
    expect(usableLanguage('@@@')).toBe('en-US');
    expect(usableLanguage('')).toBe('en-US');
  });
});

describe('guardLocale', () => {
  it('makes a malformed navigator.language usable, and leaves a good one alone', () => {
    const bad = { language: 'en-US@posix', languages: ['en-US@posix', 'fr-FR'] as readonly string[] };
    expect(guardLocale(bad)).toBe(true);
    expect(bad.language).toBe('en-US');
    expect(bad.languages).toEqual(['en-US', 'fr-FR']);
    expect(() => new Intl.NumberFormat(bad.language)).not.toThrow(); // what the chart library does on load
    const good = { language: 'en-GB', languages: ['en-GB'] as readonly string[] };
    expect(guardLocale(good)).toBe(false);
    expect(good.language).toBe('en-GB');
    expect(guardLocale(undefined)).toBe(false);
  });
});

describe('formatCount', () => {
  it('formats with thousands separators in English, whatever the default locale', () => {
    expect(formatCount(12561)).toBe('12,561');
    expect(formatCount(3.6)).toBe('4');
  });

  it('falls back to plain digits if Intl is unusable', () => {
    const spy = vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(() => {
      throw new RangeError('Incorrect locale information provided');
    });
    expect(formatCount(12561)).toBe('12561');
    spy.mockRestore();
  });
});
