import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { useMediaQuery, usePrefersReducedMotion } from './useMediaQuery';
import { usePendingFocus } from './usePendingFocus';

/** Opens a panel (focus goes to its heading) or re-runs (focus waits until `ready`). */
function Harness() {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(true);
  const focusAfter = usePendingFocus(ready);
  return (
    <>
      <button type="button" id="open" onClick={() => (setOpen(true), focusAfter('#panel h2'))}>
        Open
      </button>
      <button type="button" onClick={() => (setOpen(false), focusAfter('#open'))}>
        Close
      </button>
      <button type="button" onClick={() => (setReady(false), focusAfter('#result', true))}>
        Re-run
      </button>
      <button type="button" onClick={() => setReady(true)}>
        Finish
      </button>
      {open && (
        <section id="panel">
          <h2>Panel</h2>
        </section>
      )}
      <h2 id="result" tabIndex={-1}>
        Result
      </h2>
    </>
  );
}

describe('usePendingFocus', () => {
  it('focuses a heading that appears after the action, making it focusable without a tab stop', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const heading = screen.getByRole('heading', { name: 'Panel' });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open' }));
  });

  it('waits until ready when asked to', () => {
    render(<Harness />);
    const rerun = screen.getByRole('button', { name: 'Re-run' });
    rerun.focus();
    fireEvent.click(rerun);
    expect(document.activeElement).toBe(rerun);
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Result' }));
  });

  it('gives up when the viewer clicks or types somewhere else first', () => {
    render(<Harness />);
    const rerun = screen.getByRole('button', { name: 'Re-run' });
    fireEvent.click(rerun);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    const finish = screen.getByRole('button', { name: 'Finish' });
    finish.focus();
    fireEvent.click(finish);
    expect(document.activeElement).toBe(finish);
    fireEvent.click(rerun);
    fireEvent.pointerDown(document.body);
    fireEvent.click(finish);
    expect(document.activeElement).toBe(finish);
  });
});

describe('useMediaQuery', () => {
  function Probe() {
    return <p>{`${useMediaQuery('(max-width: 1200px)')} ${usePrefersReducedMotion()}`}</p>;
  }

  it('is false without matchMedia (jsdom)', () => {
    render(<Probe />);
    expect(screen.getByText('false false')).toBeTruthy();
  });

  it('follows matchMedia and its changes', () => {
    const listeners: Array<() => void> = [];
    let matches = true;
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() {
        return query.includes('1200') ? matches : false;
      },
      addEventListener: (_: string, l: () => void) => listeners.push(l),
      removeEventListener: () => {},
    }));
    const { unmount } = render(<Probe />);
    expect(screen.getByText('true false')).toBeTruthy();
    matches = false;
    act(() => listeners.forEach((l) => l()));
    expect(screen.getByText('false false')).toBeTruthy();
    unmount();
    vi.unstubAllGlobals();
  });
});
