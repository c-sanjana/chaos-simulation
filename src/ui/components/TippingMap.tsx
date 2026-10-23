import type { CSSProperties } from 'react';
import type { MapCellView, MapView } from './types';

/** Recovery-time bands for cell colour, in seconds (from the approved mockup). */
export const FAST_BELOW_S = 8;
export const SLOW_BELOW_S = 18;

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

export function cellText(cell: MapCellView): string {
  const text = cell.status === 'pending' ? '…' : cell.status === 'stuck' ? 'stuck' : `${recoverySeconds(cell)}s`;
  return cell.isCurrent ? `◆ ${text}` : text;
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

const LABEL_COL_PX = 52;

/** Grid of simulation outcomes: traffic across, the scenario's second variable up. */
export function TippingMap({ map, selected = null, onSelect }: TippingMapProps) {
  const fmtY = map.formatY ?? String;
  const nx = map.xValues.length;
  const rowStyle: CSSProperties = { gridTemplateColumns: `${LABEL_COL_PX}px repeat(${nx}, minmax(0, 1fr))` };

  return (
    <div className="csl-map-scroll">
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
                <button key={x} type="button" className={cls} style={style} aria-label={label} aria-pressed={isSelected} onClick={() => onSelect(cell)}>
                  {cellText(cell)}
                </button>
              ) : (
                <span key={x} className={cls} style={style} role="img" aria-label={label}>
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
        <div className="csl-map__captions">
          <span>↑ {map.yLabel}</span>
          <span>{map.xLabel} →</span>
        </div>
      </div>
    </div>
  );
}

const LEGEND: Array<[string, string]> = [
  ['var(--csl-map-fast)', 'Recovers fast'],
  ['var(--csl-map-slow)', 'Recovers slowly'],
  ['var(--csl-map-barely)', 'Barely recovers'],
  ['var(--csl-map-stuck)', 'Stuck'],
];

/** Colour key for TippingMap. */
export function MapLegend() {
  return (
    <ul className="csl-map-legend" aria-label="Map legend">
      {LEGEND.map(([bg, label], i) => (
        <li key={label} className="csl-topology-key__item">
          <span className="csl-map-legend__swatch" style={{ background: bg, border: i === 0 ? '1px solid #D0DCEB' : undefined }} />
          {label}
        </li>
      ))}
      <li>◆ = current settings</li>
    </ul>
  );
}
