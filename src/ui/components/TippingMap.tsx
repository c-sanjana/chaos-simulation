import { useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { MapCellView, MapView } from './types';

/** Recovery-time bands for cell colour, in seconds (shown in MapLegend). */
export const FAST_BELOW_S = 4;
export const SLOW_BELOW_S = 9;

/** The legend's words for an overloaded cell (also its spoken status). */
export const OVERLOADED_TEXT = 'Too much traffic even without the failure';
/** The same, in the one-line legend under step 3's heading. */
const OVERLOADED_SHORT = 'Too much traffic anyway';

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
 * The mark inside a cell: ◆ on the marked cell (usually the current settings), nothing elsewhere.
 * Stuck cells are told by colour and by their accessible name ("…: stuck"); overloaded cells are
 * also hatched (CSS). ASSUMPTION: no ✕ in stuck cells (user decision, 2026-10-24: the marks made
 * the grid busier and harder to read).
 */
export function cellText(cell: MapCellView): string {
  return cell.isCurrent ? '◆' : '';
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

/**
 * The cell index a key moves to in a grid of `rows` × `cols` (row-major), or null for other keys:
 * arrows by one cell, Home/End to the row's ends, Ctrl+Home/End to the corners, Page Up/Down to the
 * top/bottom row. Moves stop at the edges.
 */
export function gridMove(key: string, index: number, rows: number, cols: number, ctrl = false): number | null {
  const r = Math.floor(index / cols);
  const c = index % cols;
  const at = (row: number, col: number) => Math.min(rows - 1, Math.max(0, row)) * cols + Math.min(cols - 1, Math.max(0, col));
  switch (key) {
    case 'ArrowRight':
      return at(r, c + 1);
    case 'ArrowLeft':
      return at(r, c - 1);
    case 'ArrowUp':
      return at(r - 1, c);
    case 'ArrowDown':
      return at(r + 1, c);
    case 'Home':
      return ctrl ? 0 : at(r, 0);
    case 'End':
      return ctrl ? rows * cols - 1 : at(r, cols - 1);
    case 'PageUp':
      return at(0, c);
    case 'PageDown':
      return at(rows - 1, c);
    default:
      return null;
  }
}

/**
 * Grid of simulation outcomes: traffic across, the scenario's second variable up.
 * To assistive tech it is an ARIA grid with the axes' values as row and column headers. It is a
 * single tab stop: arrow keys (and Home/End, Page Up/Down) move between cells, Enter or Space
 * replays the focused cell. The column headers come first in the DOM (headers lead a grid) but are
 * drawn under the rows.
 */
export function TippingMap({ map, selected = null, onSelect, tips = [] }: TippingMapProps) {
  const fmtY = map.formatY ?? String;
  const yName = map.yLabel.replace(/\s*\([^)]*\)\s*$/, '');
  const nx = map.xValues.length;
  const ny = map.yValues.length;
  const rowStyle: CSSProperties = { gridTemplateColumns: `${LABEL_COL} repeat(${nx}, var(--csl-map-cell))` };
  // Cells are row-major; a missing cell is shown as not run yet.
  const cellAt = (r: number, c: number): MapCellView => map.cells[r * nx + c] ?? { x: map.xValues[c], y: map.yValues[r], status: 'pending', isCurrent: false };
  const isSelected = (cell: MapCellView) => selected !== null && selected.x === cell.x && selected.y === cell.y;

  // Roving tab stop: the cell last moved to, else the selected cell, else the marked one, else the first.
  const all = map.yValues.flatMap((_, r) => map.xValues.map((__, c) => cellAt(r, c)));
  const picked = all.findIndex(isSelected);
  const fallback = Math.max(0, picked >= 0 ? picked : all.findIndex((c) => c.isCurrent));
  const [active, setActive] = useState<number | null>(null);
  const tabStop = active !== null && active < all.length ? active : fallback;
  const gridRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = gridMove(e.key, tabStop, ny, nx, e.ctrlKey || e.metaKey);
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${next}"]`)?.focus();
  };

  return (
    <div className="csl-map-scroll">
      <div className="csl-map-frame">
      <span className="csl-map__yaxis" aria-hidden="true">
        {map.yLabel} →
      </span>
      <div ref={gridRef} className="csl-map" role="grid" aria-label={map.title} aria-readonly={onSelect ? undefined : true} onKeyDown={onKeyDown}>
        <div className="csl-map__row csl-map__row--xlabels" role="row" style={rowStyle}>
          <span role="columnheader" className="csl-map__corner">
            <span className="csl-sr-only">{map.yLabel}</span>
          </span>
          {map.xValues.map((x) => (
            <span key={x} role="columnheader" className="csl-map__xlabel">
              <span>{x}</span>
              <span className="csl-sr-only"> requests per second</span>
            </span>
          ))}
        </div>
        {map.yValues.map((y, r) => (
          <div key={y} className="csl-map__row" role="row" style={rowStyle}>
            <span className="csl-map__ylabel" role="rowheader">
              <span>{fmtY(y)}</span>
              <span className="csl-sr-only"> {yName}</span>
            </span>
            {map.xValues.map((x, c) => {
              const cell = cellAt(r, c);
              const i = r * nx + c;
              const tip = tips.some((t) => t.y === cell.y && t.tipsAtX === cell.x);
              const cls = `csl-map__cell csl-map__cell--${cell.status}${tip ? ' csl-map__cell--tip' : ''}`;
              const style = { backgroundColor: cellColor(cell) };
              const label = cellAriaLabel(cell, map, tip);
              const roving = { 'data-cell': i, tabIndex: i === tabStop ? 0 : -1, onFocus: () => setActive(i) };
              return onSelect ? (
                <span key={x} role="gridcell" className="csl-map__gridcell" aria-selected={isSelected(cell)}>
                  <button type="button" className={cls} style={style} aria-label={label} title={label} aria-pressed={isSelected(cell)} onClick={() => onSelect(cell)} {...roving}>
                    {cellText(cell)}
                  </button>
                </span>
              ) : (
                <span key={x} role="gridcell" className="csl-map__gridcell" {...roving}>
                  <span className={cls} style={style} role="img" aria-label={label} title={label}>
                    {cellText(cell)}
                  </span>
                </span>
              );
            })}
          </div>
        ))}
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
  /** One line with shorter words, for step 3 where two maps share the panel (default false). */
  compact?: boolean;
}

/**
 * Key for TippingMap. Overloaded cells are hatched besides their colour, and the key shows the
 * hatching in its swatch too.
 */
export function MapLegend({ showSelected = true, showTip = true, markLabel = 'your settings', showMark = true, showPending = true, compact = false }: MapLegendProps) {
  return (
    <ul className={`csl-map-legend${compact ? ' csl-map-legend--compact' : ''}`} aria-label="Map legend">
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
        <span className="csl-map-legend__swatch csl-map-legend__swatch--stuck" style={{ backgroundColor: 'var(--csl-map-stuck)' }} aria-hidden="true" />
        Stuck
      </li>
      <li className="csl-map-legend__item">
        <span className="csl-map-legend__swatch csl-map__cell--overloaded" style={{ backgroundColor: 'var(--csl-map-overloaded)' }} />
        {compact ? OVERLOADED_SHORT : OVERLOADED_TEXT}
      </li>
      {showPending && (
        <li className="csl-map-legend__item">
          <span className="csl-map-legend__swatch csl-map-legend__swatch--pending" style={{ background: 'var(--csl-map-pending)' }} />
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
