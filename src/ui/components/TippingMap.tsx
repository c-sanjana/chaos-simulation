import type { CSSProperties } from 'react';
import type { MapCellView, MapView } from './types';

/** Recovery-time bands for cell colour, in seconds (shown in MapLegend). */
export const FAST_BELOW_S = 4;
export const SLOW_BELOW_S = 9;

// ASSUMPTION: a recovered cell without a recovery time never deviated from the control run.
function recoverySeconds(cell: MapCellView): number {
  return Math.round(cell.recoverySeconds ?? 0);
}

export function cellColor(cell: MapCellView): string {
  if (cell.status === 'pending') return 'var(--csl-map-pending)';
  if (cell.status === 'stuck') return 'var(--csl-map-stuck)';
  const s = recoverySeconds(cell);
  if (s < FAST_BELOW_S) return 'var(--csl-map-fast)';
  if (s < SLOW_BELOW_S) return 'var(--csl-map-slow)';
  return 'var(--csl-map-barely)';
}

/** Cells carry no text (the legend explains the colours); only the current settings get a marker. */
export function cellText(cell: MapCellView): string {
  return cell.isCurrent ? '◆' : '';
}

/**
 * e.g. "200 requests per second, 3 retries: stuck".
 * ASSUMPTION: the x axis is always traffic in requests/s (true for every scenario's map).
 * A trailing unit in brackets is dropped from the y label, so "outage length (s)" reads
 * "10s outage length".
 */
export function cellAriaLabel(cell: MapCellView, map: MapView): string {
  const fmtY = map.formatY ?? String;
  const yName = map.yLabel.replace(/\s*\([^)]*\)\s*$/, '');
  const status =
    cell.status === 'pending' ? 'not run yet' : cell.status === 'stuck' ? 'stuck' : `recovers in ${recoverySeconds(cell)} s`;
  return `${cell.x} requests per second, ${fmtY(cell.y)} ${yName}: ${status}${cell.isCurrent ? ' (current settings)' : ''}`;
}

export interface TippingMapProps {
  map: MapView;
  selected?: { x: number; y: number } | null;
  /** Omit for a read-only map (cells render as plain boxes rather than buttons). */
  onSelect?: (cell: MapCellView) => void;
}

/** Width of the y tick-label column; small maps narrow it with --csl-map-label. */
const LABEL_COL = 'var(--csl-map-label, 40px)';

/** Grid of simulation outcomes: traffic across, the scenario's second variable up. */
export function TippingMap({ map, selected = null, onSelect }: TippingMapProps) {
  const fmtY = map.formatY ?? String;
  const nx = map.xValues.length;
  const rowStyle: CSSProperties = { gridTemplateColumns: `${LABEL_COL} repeat(${nx}, var(--csl-map-cell))` };

  return (
    <div className="csl-map-scroll">
      <div className="csl-map-frame">
      <span className="csl-map__yaxis" aria-hidden="true">
        {map.yLabel} →
      </span>
      <div className="csl-map" role="group" aria-label={map.title}>
        {map.yValues.map((y, r) => (
          <div key={y} className="csl-map__row" style={rowStyle}>
            <span className="csl-map__ylabel">{fmtY(y)}</span>
            {map.xValues.map((x, c) => {
              // Cells are row-major; a missing cell is shown as not run yet.
              const cell = map.cells[r * nx + c] ?? { x, y, status: 'pending', isCurrent: false };
              const isSelected = selected !== null && selected.x === cell.x && selected.y === cell.y;
              const cls = `csl-map__cell${cell.status === 'pending' ? ' csl-map__cell--pending' : ''}`;
              const style = { background: cellColor(cell) };
              const label = cellAriaLabel(cell, map);
              return onSelect ? (
                <button key={x} type="button" className={cls} style={style} aria-label={label} title={label} aria-pressed={isSelected} onClick={() => onSelect(cell)}>
                  {cellText(cell)}
                </button>
              ) : (
                <span key={x} className={cls} style={style} role="img" aria-label={label} title={label}>
                  {cellText(cell)}
                </span>
              );
            })}
          </div>
        ))}
        <div className="csl-map__row" style={rowStyle} aria-hidden="true">
          <span />
          {map.xValues.map((x) => (
            <span key={x} className="csl-map__xlabel">
              {x}
            </span>
          ))}
        </div>
        <div className="csl-map__xaxis" aria-hidden="true" style={{ paddingLeft: LABEL_COL }}>
          {map.xLabel} →
        </div>
      </div>
      </div>
    </div>
  );
}

const LEGEND: Array<[string, string]> = [
  ['var(--csl-map-fast)', `Recovers fast (< ${FAST_BELOW_S} s)`],
  ['var(--csl-map-slow)', `Recovers in ${FAST_BELOW_S}–${SLOW_BELOW_S} s`],
  ['var(--csl-map-barely)', `Recovers slowly (${SLOW_BELOW_S} s+)`],
  ['var(--csl-map-stuck)', 'Stuck'],
  ['var(--csl-map-pending)', 'Not run yet'],
];

/** Colour key for TippingMap (cells have no text, so this carries the meaning). */
export function MapLegend({ showSelected = true }: { showSelected?: boolean }) {
  return (
    <ul className="csl-map-legend" aria-label="Map legend">
      {LEGEND.map(([bg, label]) => (
        <li key={label} className="csl-topology-key__item">
          <span className="csl-map-legend__swatch" style={{ background: bg }} />
          {label}
        </li>
      ))}
      <li>◆ current settings</li>
      {showSelected && (
        <li className="csl-topology-key__item">
          <span className="csl-map-legend__swatch" style={{ boxShadow: '0 0 0 2px var(--csl-card), 0 0 0 4px var(--csl-ink)', width: 10, height: 10, margin: '0 2px' }} />
          replaying
        </li>
      )}
    </ul>
  );
}
