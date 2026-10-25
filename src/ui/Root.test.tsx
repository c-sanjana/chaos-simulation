import { fireEvent, render, screen } from '@testing-library/react';
import { SAVED_SYSTEM_KEY } from './savedSystem';

// An App that breaks while anything is remembered: a damaged save that got past loadSaved's checks.
vi.mock('./App', () => ({
  App: () => {
    if (localStorage.getItem(SAVED_SYSTEM_KEY) !== null) throw new Error('Cannot read properties of undefined (reading medianMs)');
    return <p>The page</p>;
  },
}));

const { Root } = await import('./Root');

afterEach(() => localStorage.clear());

describe('Root', () => {
  it('"Start again" forgets the saved system, so a save that broke the page cannot break it again (code review 3, finding 4)', () => {
    localStorage.setItem(SAVED_SYSTEM_KEY, '{"canvas":"damaged"}');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Root />);
    expect(screen.getByRole('alert', { name: 'Something went wrong' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(localStorage.getItem(SAVED_SYSTEM_KEY)).toBeNull();
    expect(screen.getByText('The page')).toBeTruthy();
    error.mockRestore();
  });
});
