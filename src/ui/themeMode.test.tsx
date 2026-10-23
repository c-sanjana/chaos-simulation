import { act, fireEvent, render, screen } from '@testing-library/react';
import { applyTheme, cssVar, initialTheme, THEME_KEY, ThemeToggle } from './themeMode';

const store = (saved: string | null) => ({ getItem: vi.fn(() => saved), setItem: vi.fn() });
const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

afterEach(() => {
  delete document.documentElement.dataset.theme;
  localStorage.clear();
});

describe('theme', () => {
  it('is light unless dark was chosen (the system setting is not followed)', () => {
    expect(initialTheme(store('dark'))).toBe('dark');
    expect(initialTheme(store('light'))).toBe('light');
    expect(initialTheme(store('purple'))).toBe('light');
    expect(initialTheme(store(null))).toBe('light');
    expect(initialTheme(null)).toBe('light');
    expect(initialTheme(throwing)).toBe('light'); // blocked storage
    expect(initialTheme()).toBe('light'); // jsdom: empty storage
  });

  it('applies the theme to <html> and remembers it when it can', () => {
    const s = store(null);
    applyTheme('dark', s);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(s.setItem).toHaveBeenCalledWith(THEME_KEY, 'dark');
    expect(() => applyTheme('light', throwing)).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('reads a token, falling back when it is not set', () => {
    expect(cssVar('--nope', '#123')).toBe('#123');
    document.documentElement.style.setProperty('--csl-test', ' #abc ');
    expect(cssVar('--csl-test', '#123')).toBe('#abc');
    document.documentElement.style.removeProperty('--csl-test');
  });

  it('toggles between light and dark from the top bar', async () => {
    const { unmount } = render(<ThemeToggle />);
    // The toggle follows <html data-theme> through a MutationObserver, so let it fire inside act.
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' })));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' })));
    expect(document.documentElement.dataset.theme).toBe('light');
    unmount();
  });
});
