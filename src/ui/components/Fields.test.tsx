import { fireEvent, render, screen } from '@testing-library/react';
import { CheckboxField, limitsMessage, NumberField } from './Fields';

describe('NumberField', () => {
  it('is a labelled number input showing value and unit', () => {
    render(<NumberField label="User traffic" value={200} unit="req/s" onChange={() => {}} min={1} integer />);
    const input = screen.getByRole('spinbutton', { name: 'User traffic req/s' }) as HTMLInputElement;
    expect(input.value).toBe('200');
    expect(input.min).toBe('1');
    expect(input.step).toBe('1');
    fireEvent.change(input, { target: { value: '80' } });
    expect(input.validity.valid).toBe(true); // the browser agrees with the field's own check
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(screen.getByText('req/s')).toBeTruthy();
  });

  it('reports valid numbers as they are typed', () => {
    const onChange = vi.fn();
    render(<NumberField label="Retries" value={3} onChange={onChange} min={0} />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith(5);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it('keeps an empty or out-of-range entry visible and marked, without reporting it, even after leaving the field', () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberField label="Retries" value={3} onChange={onChange} min={0} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.validity.valid).toBe(false); // blocks its form
    fireEvent.change(input, { target: { value: '-2' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input.value).toBe('-2'); // no silent snap back
    expect(input.getAttribute('aria-invalid')).toBe('true');
    // A new value from outside (a reset) replaces the invalid entry.
    rerender(<NumberField label="Retries" value={4} onChange={onChange} min={0} />);
    expect(input.value).toBe('4');
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('tidies a valid entry when leaving the field', () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberField label="Retries" value={3} onChange={onChange} min={0} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '05' } });
    expect(onChange).toHaveBeenCalledWith(5);
    rerender(<NumberField label="Retries" value={5} onChange={onChange} min={0} />);
    expect(input.value).toBe('05');
    fireEvent.blur(input);
    expect(input.value).toBe('5');
  });

  it('accepts any number when no minimum is set, and has no unit by default', () => {
    const onChange = vi.fn();
    const { container } = render(<NumberField label="Offset" value={0} onChange={onChange} />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-4' } });
    expect(onChange).toHaveBeenCalledWith(-4);
    expect(container.querySelector('.csl-field__unit')).toBeNull();
  });
});

describe('NumberField limits', () => {
  it('explains an out-of-range or fractional value under the field, linked for screen readers', () => {
    const onChange = vi.fn();
    render(<NumberField label="Retries" value={3} onChange={onChange} min={0} max={10} integer />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(input.step).toBe('1');
    expect(input.max).toBe('10');
    for (const bad of ['11', '2.5', '-1']) {
      fireEvent.change(input, { target: { value: bad } });
      expect(input.getAttribute('aria-invalid')).toBe('true');
    }
    expect(onChange).not.toHaveBeenCalled();
    const message = screen.getByText('Enter a whole number from 0 to 10');
    expect(input.getAttribute('aria-describedby')).toBe(message.id);
    fireEvent.change(input, { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith(7);
    expect(screen.queryByText(/Enter a whole number/)).toBeNull();
  });

  it('words every kind of limit, and allows any step for decimals', () => {
    expect(limitsMessage({ min: 1 })).toBe('Enter a number of at least 1');
    expect(limitsMessage({ max: 5, integer: true })).toBe('Enter a whole number of at most 5');
    expect(limitsMessage({})).toBe('Enter a number');
    render(<NumberField label="Skew" value={0.8} onChange={() => {}} min={0} />);
    expect((screen.getByRole('spinbutton') as HTMLInputElement).step).toBe('any');
  });
});

describe('NumberField above', () => {
  it('must be above a floor (not equal to it), explained in its own words, and blocks the form', () => {
    const onChange = vi.fn();
    render(
      <form aria-label="f">
        <NumberField label="Slowest 1% take" value={20} onChange={onChange} min={0.01} above={4} aboveMessage="Must take longer than the typical time (4 ms)" />
      </form>,
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '4' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Must take longer than the typical time (4 ms)')).toBeTruthy();
    expect((screen.getByRole('form') as HTMLFormElement).checkValidity()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith(5);
    expect((screen.getByRole('form') as HTMLFormElement).checkValidity()).toBe(true);
  });

  it('has a plain default message', () => {
    render(<NumberField label="x" value={1} onChange={() => {}} above={1} />);
    expect(screen.getByText('Enter a number above 1')).toBeTruthy();
  });
});

describe('CheckboxField', () => {
  it('is a labelled checkbox that reports its new state', () => {
    const onChange = vi.fn();
    const { rerender } = render(<CheckboxField label="Jitter on retries" checked={false} onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Jitter on retries' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<CheckboxField label="Jitter on retries" checked onChange={onChange} />);
    expect(box.checked).toBe(true);
  });
});
