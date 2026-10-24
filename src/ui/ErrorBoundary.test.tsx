import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

let broken = true;
function Fragile() {
  const [n] = useState(1);
  if (broken) throw new Error('toLocaleString exploded');
  return <p>Working page {n}</p>;
}

describe('ErrorBoundary', () => {
  it('shows a plain message instead of a blank page, and starts again on request', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onReset = vi.fn();
    broken = true;
    render(
      <ErrorBoundary onReset={onReset}>
        <Fragile />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert', { name: 'Something went wrong' });
    expect(alert.textContent).toMatch(/toLocaleString exploded/);
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(onReset).toHaveBeenCalled();
    expect(screen.getByText('Working page 1')).toBeTruthy();
    quiet.mockRestore();
  });

  it('turns a thrown non-error into a message', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Throws(): never {
      throw 'plain string';
    }
    render(
      <ErrorBoundary>
        <Throws />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/plain string/);
    quiet.mockRestore();
  });
});
