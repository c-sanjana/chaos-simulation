import { fireEvent, render, screen } from '@testing-library/react';
import { MetricTabs } from './MetricTabs';

const tabs = [
  { id: 'throughput', label: 'Throughput' },
  { id: 'latency', label: 'Latency' },
];

describe('MetricTabs', () => {
  it('marks the selected tab and shows the scope pill', () => {
    render(<MetricTabs tabs={tabs} selected="latency" onSelect={() => {}} scopeLabel="end to end" />);
    expect(screen.getByRole('button', { name: 'Latency' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Throughput' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('Showing: end to end')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Chart' })).toBeTruthy();
  });

  it('reports the clicked tab id', () => {
    const onSelect = vi.fn();
    render(<MetricTabs tabs={tabs} selected="latency" onSelect={onSelect} scopeLabel="DB" />);
    fireEvent.click(screen.getByRole('button', { name: 'Throughput' }));
    expect(onSelect).toHaveBeenCalledWith('throughput');
  });
});
