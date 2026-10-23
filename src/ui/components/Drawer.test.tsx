import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Drawer } from './Drawer';

function Harness({ initiallyOpen = false, footer = true }: { initiallyOpen?: boolean; footer?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button onClick={() => setOpen(true)}>Settings</button>
      <Drawer
        open={open}
        title="Settings"
        subtitle="Preset: Retry storm · every value is editable"
        onClose={() => setOpen(false)}
        footer={footer ? <button>Re-run simulation</button> : undefined}
      >
        <input aria-label="User traffic" />
      </Drawer>
    </>
  );
}

describe('Drawer', () => {
  it('renders nothing while closed', () => {
    render(<Drawer open={false} title="Settings" onClose={() => {}}>body</Drawer>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a labelled modal dialog with subtitle, body and footer', () => {
    render(<Harness initiallyOpen />);
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('Preset: Retry storm · every value is editable')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'User traffic' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-run simulation' })).toBeTruthy();
  });

  it('omits the subtitle and footer when not given', () => {
    const { container } = render(<Drawer open title="Settings" onClose={() => {}}>body</Drawer>);
    expect(container.querySelector('.csl-drawer__subtitle')).toBeNull();
    expect(container.querySelector('.csl-drawer__footer')).toBeNull();
  });

  it('focuses the close button on open and returns focus on close', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Settings' });
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByRole('button', { name: 'Close settings' });
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on Escape', () => {
    render(<Harness initiallyOpen />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on a backdrop click but not on a click inside the panel', () => {
    render(<Harness initiallyOpen />);
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('drawer-backdrop'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps Tab focus inside the drawer', () => {
    render(<Harness initiallyOpen />);
    const close = screen.getByRole('button', { name: 'Close settings' });
    const last = screen.getByRole('button', { name: 'Re-run simulation' });
    const input = screen.getByRole('textbox');

    last.focus();
    expect(fireEvent.keyDown(last, { key: 'Tab' })).toBe(false); // default prevented
    expect(document.activeElement).toBe(close);

    expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);

    // In the middle, Tab is left to the browser.
    input.focus();
    expect(fireEvent.keyDown(input, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'a' })).toBe(true);
  });
});
