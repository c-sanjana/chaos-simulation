import { fireEvent, render, screen } from '@testing-library/react';
import { CheckboxField, NumberField } from './Fields';

describe('NumberField', () => {
  it('is a labelled number input showing value and unit', () => {
    render(<NumberField label="User traffic" value={200} unit="req/s" onChange={() => {}} min={1} step={10} />);
    const input = screen.getByRole('spinbutton', { name: 'User traffic req/s' }) as HTMLInputElement;
    expect(input.value).toBe('200');
    expect(input.min).toBe('1');
    expect(input.step).toBe('10');
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

  it('keeps an empty or out-of-range draft without reporting it, then restores the value on blur', () => {
    const onChange = vi.fn();
    render(<NumberField label="Retries" value={3} onChange={onChange} min={0} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input, { target: { value: '-2' } });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(input.value).toBe('3');
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('accepts any number when no minimum is set, and has no unit by default', () => {
    const onChange = vi.fn();
    const { container } = render(<NumberField label="Offset" value={0} onChange={onChange} />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '-4' } });
    expect(onChange).toHaveBeenCalledWith(-4);
    expect(container.querySelector('.csl-field__unit')).toBeNull();
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
