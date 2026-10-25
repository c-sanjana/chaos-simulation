import { useId, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { connect, connectRefusal, GRID_COLS, GRID_ROWS, nodeAt, type Cell } from '../../builder/edit';
import { KIND_LABELS, type BuilderGraph, type BuilderNode, type ComponentKind } from '../../builder/graph';
import { displayName, edgeLabel, edgeLabelName, nodeLines, nodeSummary } from './describe';
import { BOX_H, BOX_W, CELL_H, CELL_W, cellCenter, edgeLines, wrapLabel, type Point } from './geometry';
import { KindIcon } from './KindIcon';
import { PALETTE_KINDS, startDrag } from './Palette';
import { useSideScroll } from '../components/TopologyDiagram';

/** What is being dragged: a new component from the palette, a box being moved, or a call being drawn. */
export type Drag = { type: 'new'; kind: ComponentKind } | { type: 'move'; id: string } | { type: 'connect'; from: string };

export type Selection = { type: 'node' | 'edge'; id: string } | null;

export interface BuilderCanvasProps {
  graph: BuilderGraph;
  selection: Selection;
  drag: Drag | null;
  onSelect: (selection: Selection) => void;
  onDragStart: (drag: Drag) => void;
  onDragEnd: () => void;
  /** Place a new component on (or as near as possible to) a cell. */
  onAdd: (kind: ComponentKind, cell: Cell) => void;
  onMove: (id: string, cell: Cell) => void;
  onConnect: (from: string, to: string) => void;
  /** A drag ended over a box it couldn't be dropped on: why, for the status line. */
  onRefused: (reason: string) => void;
  /** Delete a box or arrow (the one the keyboard is on), or whatever is selected. */
  onDelete: (target?: Selection) => void;
  /**
   * A box or arrow was chosen with the keyboard (Enter or Space): select it and move focus to its
   * settings, so they are the next thing a keyboard user reaches.
   */
  onOpen: (selection: NonNullable<Selection>) => void;
  /** Shown in the middle of an empty canvas. */
  emptyHint: ReactNode;
}

/** A label on two lines; the " · " between them is kept in its text (hidden), so it reads as on one line. */
function WrappedLabel({ text }: { text: string }) {
  const [first, second] = wrapLabel(text);
  return (
    <>
      <span>{first}</span>
      {second !== undefined && (
        <>
          <span className="csl-bcanvas__edge-sep"> · </span>
          <span>{second}</span>
        </>
      )}
    </>
  );
}

/** Whether a component of this kind can call anything at all (so it gets a connection handle). */
export function canCallAnything(kind: ComponentKind): boolean {
  return PALETTE_KINDS.some((to) => connectRefusal(kind, to) === null);
}

const ARROW_KEYS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

const cells: Cell[] = Array.from({ length: GRID_COLS * GRID_ROWS }, (_, i) => ({ col: (i % GRID_COLS) + 1, row: Math.floor(i / GRID_COLS) + 1 }));

/**
 * The canvas: a grid of cells, boxes on it, and arrows between them.
 *
 * Mouse: drag a palette item onto a cell to add it; drag a box to move it; drag from a box's
 * round handle (right edge) to another box to make it call that box. Keyboard: Tab to a box or an
 * arrow label, Enter or Space to open its settings (focus moves to them), arrow keys to move the
 * box, Delete or Backspace to remove the box or arrow the keyboard is on, Escape to clear the
 * selection. Focusing alone selects nothing: Tab passes over the boxes without changing what the
 * settings panel shows (code review 3: selecting on focus made every box but the last unreachable).
 * Connecting by keyboard is done from the settings panel ("Calls…" and Connect).
 *
 * Drags use HTML5 drag and drop. What is being dragged is kept in React state (not read back from
 * dataTransfer), because browsers hide the dragged data until the drop.
 */
export function BuilderCanvas({ graph, selection, drag, onSelect, onDragStart, onDragEnd, onAdd, onMove, onConnect, onRefused, onDelete, onOpen, emptyHint }: BuilderCanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = useSideScroll<HTMLDivElement>();
  const markerId = `csl-arrow-${useId().replace(/:/g, '')}`;
  /** The box under a dragged call or box, and why it can't be dropped on (if it can't). */
  const [hover, setHover] = useState<{ id: string; reason?: string } | null>(null);
  const [hoverCell, setHoverCell] = useState<Cell | null>(null);
  /** Where the pointer is while drawing a call, for the dashed preview line. */
  const [pointer, setPointer] = useState<Point | null>(null);

  const isSelected = (type: 'node' | 'edge', id: string) => selection?.type === type && selection.id === id;
  /** Clears the drag's hover state; `refusedHere` puts a refused target's reason on the status line. */
  const finishDrag = (refusedHere: boolean) => {
    // A refused target gets no drop event (the browser only drops where it was allowed), so when a
    // drag ends over one, the reason shown under the box goes to the status line, where it stays.
    if (refusedHere && hover?.reason) onRefused(hover.reason);
    setHover(null);
    setHoverCell(null);
    setPointer(null);
    onDragEnd();
  };
  /** The dragged item was let go (dragend): over a refused box, say why. */
  const endDrag = () => finishDrag(true);

  /** Delete or Backspace on a box or arrow label removes that one; on the canvas itself, the selection. */
  const deleteKey = (e: KeyboardEvent, target?: NonNullable<Selection>) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
    e.preventDefault();
    e.stopPropagation();
    onDelete(target);
    ref.current?.focus();
    return true;
  };
  const onCanvasKeyDown = (e: KeyboardEvent) => {
    if (selection && deleteKey(e)) return;
    if (e.key === 'Escape' && selection) onSelect(null);
  };

  const onCanvasDragOver = (e: DragEvent) => {
    // Some environments (tests) send drag events without pointer coordinates.
    if (drag?.type !== 'connect' || !Number.isFinite(e.clientX)) return;
    const rect = ref.current!.getBoundingClientRect();
    setPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  // ----- Cells: drop targets for new and moved boxes -----
  const onCellDragOver = (e: DragEvent, cell: Cell) => {
    if (drag?.type !== 'new' && drag?.type !== 'move') return;
    e.preventDefault();
    if (hoverCell?.col !== cell.col || hoverCell.row !== cell.row) setHoverCell(cell);
    setHover(null);
  };
  const onCellDrop = (e: DragEvent, cell: Cell) => {
    e.preventDefault();
    if (drag?.type === 'new') onAdd(drag.kind, cell);
    else if (drag?.type === 'move') onMove(drag.id, cell);
    finishDrag(false);
  };

  // ----- Boxes: drop targets for calls (and for new boxes, which go to the nearest free cell) -----
  const onNodeDragOver = (e: DragEvent, node: BuilderNode) => {
    setHoverCell(null);
    if (drag?.type === 'new') {
      e.preventDefault();
      return;
    }
    if (drag?.type === 'move' && drag.id === node.id) {
      e.preventDefault(); // dropping a box back where it was is allowed, and changes nothing
      setHover(null);
      return;
    }
    let reason: string | undefined;
    if (drag?.type === 'connect') reason = connect(graph, drag.from, node.id).reason;
    else if (drag?.type === 'move') reason = `That spot is taken by ${displayName(node)}.`;
    else return;
    if (!reason) e.preventDefault();
    if (hover?.id !== node.id || hover.reason !== reason) setHover({ id: node.id, reason });
  };
  const onNodeDrop = (e: DragEvent, node: BuilderNode) => {
    e.preventDefault();
    if (drag?.type === 'new') onAdd(drag.kind, { col: node.col, row: node.row });
    else if (drag?.type === 'connect') onConnect(drag.from, node.id);
    finishDrag(false);
  };

  const onBoxKeyDown = (e: KeyboardEvent, node: BuilderNode) => {
    if (deleteKey(e, { type: 'node', id: node.id })) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen({ type: 'node', id: node.id });
      return;
    }
    const step = ARROW_KEYS[e.key];
    if (!step) return;
    e.preventDefault();
    onSelect({ type: 'node', id: node.id });
    onMove(node.id, { col: node.col + step[0], row: node.row + step[1] });
  };

  const lines = edgeLines(graph, (edge) => edgeLabel(graph, edge));
  const from = drag?.type === 'connect' ? graph.nodes.find((n) => n.id === drag.from) : undefined;
  const style = { '--csl-cell-w': `${CELL_W}px`, '--csl-cell-h': `${CELL_H}px`, '--csl-box-w': `${BOX_W}px`, '--csl-box-h': `${BOX_H}px`, '--csl-cols': GRID_COLS, '--csl-rows': GRID_ROWS } as CSSProperties;

  return (
    <>
    {(scroll.more.left || scroll.more.right) && (
      // Narrower windows (1280 px and below) show only part of the canvas: say so, as the run diagram does.
      <p className="csl-topology-hint">
        Scroll sideways to see the whole canvas <span aria-hidden="true">{scroll.more.right ? '→' : '←'}</span>
      </p>
    )}
    <div className="csl-bcanvas-scroll" ref={scroll.ref}>
      <div
        ref={ref}
        className={`csl-bcanvas${drag ? ` csl-bcanvas--dragging csl-bcanvas--${drag.type}` : ''}`}
        style={style}
        role="group"
        aria-label={`Canvas, ${GRID_COLS} columns by ${GRID_ROWS} rows. Select a box or arrow to edit it; arrow keys move the selected box; Delete removes it.`}
        tabIndex={-1}
        onKeyDown={onCanvasKeyDown}
        onDragOver={onCanvasDragOver}
      >
        {cells.map((cell) => (
          <div
            key={`${cell.col}-${cell.row}`}
            className={`csl-bcanvas__cell${hoverCell?.col === cell.col && hoverCell.row === cell.row && !nodeAt(graph, cell.col, cell.row) ? ' csl-bcanvas__cell--drop' : ''}`}
            style={{ gridColumn: cell.col, gridRow: cell.row }}
            data-testid={`cell-${cell.col}-${cell.row}`}
            onDragOver={(e) => onCellDragOver(e, cell)}
            onDragLeave={() => setHoverCell(null)}
            onDrop={(e) => onCellDrop(e, cell)}
            onClick={() => onSelect(null)}
          />
        ))}

        <svg className="csl-bcanvas__edges" width={GRID_COLS * CELL_W} height={GRID_ROWS * CELL_H} aria-hidden="true">
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 Z" className="csl-bcanvas__head" />
            </marker>
            <marker id={`${markerId}-sel`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 Z" className="csl-bcanvas__head csl-bcanvas__head--selected" />
            </marker>
          </defs>
          {lines.map(({ edge, line }) => {
            const selected = isSelected('edge', edge.id);
            const head = `url(#${selected ? `${markerId}-sel` : markerId})`;
            // Cache lookups are drawn like the preset's cache link: double-headed (asked, answered).
            const cache = graph.nodes.find((n) => n.id === edge.to)?.settings.kind === 'cache';
            const d = line.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
            return (
              <g key={edge.id} data-testid={`line-${edge.id}`}>
                <path d={d} className="csl-bcanvas__hit" onClick={() => onSelect({ type: 'edge', id: edge.id })} />
                <path
                  d={d}
                  className={`csl-bcanvas__line${selected ? ' csl-bcanvas__line--selected' : ''}${cache ? ' csl-bcanvas__line--cache' : ''}`}
                  markerEnd={head}
                  markerStart={cache ? head : undefined}
                />
              </g>
            );
          })}
          {from && pointer && (
            <line className="csl-bcanvas__preview" data-testid="connect-preview" x1={cellCenter(from.col, from.row).x + BOX_W / 2} y1={cellCenter(from.col, from.row).y} x2={pointer.x} y2={pointer.y} />
          )}
        </svg>

        {lines.map(({ edge, line }) => (
          <button
            key={edge.id}
            type="button"
            className={`csl-bcanvas__edge-label csl-bcanvas__edge-label--${line.labelSide}${line.labelWrap ? ' csl-bcanvas__edge-label--wrap' : ''}`}
            style={{ left: line.mid.x, top: line.mid.y }}
            aria-pressed={isSelected('edge', edge.id)}
            aria-label={edgeLabelName(graph, edge)}
            title="Edit this call"
            onKeyDown={(e) => deleteKey(e, { type: 'edge', id: edge.id })}
            // A click from the keyboard (Enter or Space: no pointer, so detail 0) also moves focus to the settings.
            onClick={(e) => (e.detail === 0 ? onOpen({ type: 'edge', id: edge.id }) : onSelect({ type: 'edge', id: edge.id }))}
          >
            {line.labelWrap ? <WrappedLabel text={edgeLabel(graph, edge)} /> : edgeLabel(graph, edge)}
          </button>
        ))}

        {graph.nodes.map((node) => {
          const selected = isSelected('node', node.id);
          const target = hover?.id === node.id ? hover : null;
          let cls = 'csl-bnode';
          if (drag?.type === 'connect' && drag.from !== node.id) cls += connect(graph, drag.from, node.id).reason ? ' csl-bnode--no' : ' csl-bnode--ok';
          if (drag?.type === 'connect' && drag.from === node.id) cls += ' csl-bnode--source';
          if (drag?.type === 'move' && drag.id === node.id) cls += ' csl-bnode--moving';
          return (
            <div
              key={node.id}
              className={cls}
              style={{ gridColumn: node.col, gridRow: node.row }}
              data-testid={`node-${node.id}`}
              onDragOver={(e) => onNodeDragOver(e, node)}
              onDragLeave={() => setHover(null)}
              onDrop={(e) => onNodeDrop(e, node)}
            >
              <div
                role="button"
                tabIndex={0}
                className={`csl-bnode__box csl-bnode__box--${node.settings.kind}`}
                aria-pressed={selected}
                aria-label={nodeSummary(node)}
                title={`${nodeSummary(node)}. Drag to move; click to edit.`}
                draggable
                onDragStart={(e) => {
                  startDrag(e, node.id, 'move');
                  onSelect({ type: 'node', id: node.id });
                  onDragStart({ type: 'move', id: node.id });
                }}
                onDragEnd={endDrag}
                onClick={() => onSelect({ type: 'node', id: node.id })}
                onKeyDown={(e) => onBoxKeyDown(e, node)}
              >
                <span className="csl-bnode__head">
                  <KindIcon kind={node.settings.kind} size={14} />
                  <span className="csl-bnode__label">{displayName(node)}</span>
                </span>
                {/* The kind, unless the name already says it ("Database", not "Database / Database"). */}
                {displayName(node) !== KIND_LABELS[node.settings.kind] && <span className="csl-bnode__kind">{KIND_LABELS[node.settings.kind]}</span>}
                {nodeLines(node.settings).map((line) => (
                  <span key={line} className="csl-bnode__line">
                    {line}
                  </span>
                ))}
              </div>
              {canCallAnything(node.settings.kind) && (
                <span
                  className="csl-bnode__handle"
                  data-testid={`handle-${node.id}`}
                  draggable
                  title={`Drag to another box to make ${displayName(node)} call it`}
                  aria-hidden="true"
                  onDragStart={(e) => {
                    startDrag(e, node.id, 'link');
                    onDragStart({ type: 'connect', from: node.id });
                  }}
                  onDragEnd={endDrag}
                />
              )}
              {target && (
                // Under the box, except on the bottom row, where it goes above so it stays on the canvas.
                <span className={`csl-bnode__verdict${target.reason ? ' csl-bnode__verdict--no' : ''}${node.row === GRID_ROWS ? ' csl-bnode__verdict--above' : ''}`} role="status">
                  {target.reason ? `✕ ${target.reason}` : '✓ Drop to connect'}
                </span>
              )}
            </div>
          );
        })}

        {graph.nodes.length === 0 && <div className="csl-bcanvas__empty">{emptyHint}</div>}
      </div>
    </div>
    </>
  );
}
