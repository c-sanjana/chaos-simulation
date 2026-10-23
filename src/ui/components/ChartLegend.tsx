import type { ReactNode } from 'react';
import { AREA_ALPHA, withAlpha } from './color';
import type { TimeSeries } from './types';

export interface ChartLegendProps {
  series: TimeSeries[];
  /** Extra legend items rendered after the series (each should be an <li>). */
  extra?: ReactNode;
  /** Show the "Failure window" swatch (default true; turn off for a run with no failure). */
  failureWindow?: boolean;
}

function Swatch({ s }: { s: TimeSeries }) {
  if (s.area) {
    return <span className="csl-legend__swatch" style={{ height: 12, background: withAlpha(s.color, AREA_ALPHA) }} />;
  }
  return <span className="csl-legend__swatch" style={{ height: 0, borderTop: `3px ${s.dashed ? 'dashed' : 'solid'} ${s.color}` }} />;
}

/** HTML legend for TimeSeriesChart; swatches match how each series is drawn. */
export function ChartLegend({ series, extra, failureWindow = true }: ChartLegendProps) {
  return (
    <ul className="csl-legend" aria-label="Legend">
      {series.map((s) => (
        <li key={s.label} className="csl-legend__item">
          <Swatch s={s} />
          {s.label}
        </li>
      ))}
      {failureWindow && (
        <li className="csl-legend__item">
          <span className="csl-legend__swatch" style={{ width: 14, height: 12, background: 'var(--csl-failure-tint)' }} />
          Failure window
        </li>
      )}
      {extra}
    </ul>
  );
}
