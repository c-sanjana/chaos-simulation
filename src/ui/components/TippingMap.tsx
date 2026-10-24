import type { CSSProperties } from 'react';
import type { MapCellView, MapView } from './types';

/** Recovery-time bands for cell colour, in seconds (shown in MapLegend). */
export const FAST_BELOW_S = 4;
export const SLOW_BELOW_S = 9;

/** The legend's words for an overloaded cell (also its spoken status). */
export const OVERLOADED_TEXT = 'Too much traffic even without the failure';

// ASSUMPTION: a recovered cell without a recovery time never deviated from the control run.
function recoverySeconds(cell: MapCellView): number {
  return Math.round(cell.recoverySeconds ?? 0);
}

export function cellColor(cell: MapCellView): string {
  if (cell.status === 'pending') return 'var(--csl-map-pending)';
  if (cell.status === 'stuck') return 'var(--csl-map-stuck)';
  if (cell.status === 'overloaded') return 'var(--csl-map-overloaded)';
  const s = recoverySeconds(cell);
  if (s < FAST_BELOW_S) return 'var(--csl-map-fast)';
  if (s < SLOW_BELOW_S) return 'var(--csl-map-slow)';
  return 'var(--csl-map-barely)';
}

/**
 * The mark inside a cell, so that the outcome never depends on colour alone: ◆ on the marked cell
 * (usually the current settings), ✕ on a stuck cell. Overloaded cells are hatched instead (CSS),
 * and recovered cells carry no mark (the legend explains their shades).
 */
export function cellText(cell: MapCellView): string {
  if (cell.isCurrent) return '◆';
  return cell.status === 'stuck' ? '✕' : '';
}

/**
 * e.g. "200 requests per second, 3 retries: stuck".
 * ASSUMPTION: the x axis is always traffic in requests/s (true for every scenario's map).
 * A trailing unit in brackets is dropped from the y label, so "outage length (s)" reads
 * "10s outage length".
 */
export function cellAriaLabel(cell: MapCellView, map: MapView, tip = false): string {
  const fmtY = map.formatY ?? String;
  const yName = map.yLabel.replace(/\s*\([^)]*\)\s*$/, '');
  const status =
    cell.status === 'pending'
      ? 'not run yet'
      : cell.status === 'stuck'
        ? 'stuck'
        : cell.status === 'overloaded'
          ? OVERLOADED_TEXT.toLowerCase()
          : `recovers in ${recoverySeconds(cell)} s`;
  return `${cell.x} requests per second, ${fmtY(cell.y)} ${yName}: ${status}${tip ? ', the tipping point' : ''}${cell.isCurrent ? ` (${map.markLabel ?? 'current settings'})` : ''}`;
}

export interface TippingMapProps {
  map: MapView;
  selected?: { x: number; y: number } | null;
  /** Omit for a read-only map (cells render as plain boxes rather than buttons). */
  onSelect?: (cell: MapCellView) => void;
  /**
   * Each row's tipping point (the traffic at which it starts getting stuck; null = none), drawn as
   * a line on the left edge of that cell: together the rows trace the boundary.
   */
  tips?: Array<{ y: number; tipsAtX: number | null }>;
}

/** Width of the y tick-label column; small maps narrow it with --csl-map-label. */
const LABEL_COL = 'var(--csl-map-label, 40px)';

/** Grid of simulation outcomes: traffic across, the scenario's second variable up. */
export function TippingMap({ map, selected = null, onSelect, tips = [] }: TippingMapProps) {
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
              const tip = tips.some((t) => t.y === cell.y && t.tipsAtX === cell.x);
              const cls = `csl-map__cell csl-map__cell--${cell.status}${tip ? ' csl-map__cell--tip' : ''}`;
              const style = { backgroundColor: cellColor(cell) };
              const label = cellAriaLabel(cell, map, tip);
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

const RECOVERED: Array<[string, string]> = [
  ['var(--csl-map-fast)', `< ${FAST_BELOW_S} s`],
  ['var(--csl-map-slow)', `${FAST_BELOW_S}–${SLOW_BELOW_S} s`],
  ['var(--csl-map-barely)', `${SLOW_BELOW_S} s+`],
];

export interface MapLegendProps {
  /** Show the ring marking the cell being replayed (default true; off for read-only maps). */
  showSelected?: boolean;
  /** Show the tipping-point line (default true). */
  showTip?: boolean;
  /** What the ◆ marks (default "your settings"). */
  markLabel?: string;
  /** Show the ◆ entry (default true; off where the panel already explains it). */
  showMark?: boolean;
  /** Show the "not run yet" entry (default true; off once every cell has run). */
  showPending?: boolean;
}

/**
 * Key for TippingMap. Every failing outcome has a mark besides its colour (✕ stuck, hatching for
 * overloaded), and the key shows the mark in its swatch too.
 */
export function MapLegend({ showSelected = true, showTip = true, markLabel = 'your settings', showMark = true, showPending = true }: MapLegendProps) {
  return (
    <ul className="csl-map-legend" aria-label="Map legend">
      <li className="csl-map-legend__group">
        Recovers in
        {RECOVERED.map(([bg, label]) => (
          <span key={label} className="csl-map-legend__item">
            <span className="csl-map-legend__swatch" style={{ background: bg }} />
            {label}
          </span>
        ))}
      </li>
      <li className="csl-map-legend__item">
        <span className="csl-map-legend__swatch csl-map-legend__swatch--stuck" style={{ backgroundColor: 'var(--csl-map-stuck)' }} aria-hidden="true">
          ✕
        </span>
        Stuck
      </li>
      <li className="csl-map-legend__item">
        <span className="csl-map-legend__swatch csl-map__cell--overloaded" style={{ backgroundColor: 'var(--csl-map-overloaded)' }} />
        {OVERLOADED_TEXT}
      </li>
      {showPending && (
        <li className="csl-map-legend__item">
          <span className="csl-map-legend__swatch" style={{ background: 'var(--csl-map-pending)' }} />
          Not run yet
        </li>
      )}
      {showTip && (
        <li className="csl-map-legend__item">
          <span className="csl-map-legend__tip" />
          tipping point
        </li>
      )}
      {showMark && <li className="csl-map-legend__item">◆ {markLabel}</li>}
      {showSelected && (
        <li className="csl-map-legend__item">
          <span className="csl-map-legend__swatch" style={{ boxShadow: '0 0 0 2px var(--csl-card), 0 0 0 4px var(--csl-ink)', width: 10, height: 10, margin: '0 2px' }} />
          replaying
        </li>
      )}
    </ul>
  );
}
