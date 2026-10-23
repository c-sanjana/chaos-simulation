import { render, screen } from '@testing-library/react';
import { ChartLegend } from './ChartLegend';

describe('ChartLegend', () => {
  it('shows a swatch per series matching how it is drawn, then the failure window', () => {
    render(
      <ChartLegend
        series={[
          { label: 'p99', values: [], color: '#1F6FEB' },
          { label: 'Timeout (1 s)', values: [], color: '#8C939D', dashed: true },
          { label: 'Retries', values: [], color: '#E8590C', area: true },
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['p99', 'Timeout (1 s)', 'Retries', 'Failure window']);
    const swatch = (i: number) => items[i].querySelector('span') as HTMLElement;
    expect(swatch(0).style.borderTop).toBe('3px solid rgb(31, 111, 235)');
    expect(swatch(1).style.borderTop).toBe('3px dashed rgb(140, 147, 157)');
    expect(swatch(2).style.background).toBe('rgba(232, 89, 12, 0.55)');
    expect(swatch(2).style.height).toBe('12px');
  });

  it('can hide the failure-window item and append extra items', () => {
    render(<ChartLegend series={[]} failureWindow={false} extra={<li>Extra</li>} />);
    expect(screen.getAllByRole('listitem').map((i) => i.textContent)).toEqual(['Extra']);
  });
});
