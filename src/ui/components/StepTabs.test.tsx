import { fireEvent, render, screen } from '@testing-library/react';
import { StepTabs } from './StepTabs';

const steps = [
  { title: 'What happened', sub: 'Stuck after the failure ended' },
  { title: "Where's the tipping point?", sub: '60 runs' },
  { title: 'Does a fix help?', sub: '4 fixes tested' },
];

describe('StepTabs', () => {
  it('numbers the steps and marks only the current one', () => {
    render(<StepTabs steps={steps} current={1} onSelect={() => {}} />);
    expect(screen.getByRole('navigation', { name: 'Steps' })).toBeTruthy();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    expect(buttons[2].textContent).toBe('3Does a fix help?4 fixes tested');
  });

  it('reports the clicked step index', () => {
    const onSelect = vi.fn();
    render(<StepTabs steps={steps} current={0} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Does a fix help/ }));
    expect(onSelect).toHaveBeenCalledWith(2);
  });
});
