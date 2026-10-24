import { useId, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { connect, connectRefusal, GRID_COLS, GRID_ROWS, nodeAt, type Cell } from '../../builder/edit';
import { KIND_LABELS, type BuilderGraph, type BuilderNode, type ComponentKind } from '../../builder/graph';
import { callLabel, callSentence, displayName, edgeTitle, nodeLines, nodeSummary } from './describe';
import { BOX_H, BOX_W, CELL_H, CELL_W, cellCenter, edgeLines, type Point } from './geometry';
import { KindIcon } from './KindIcon';
import { PALETTE_KINDS, startDrag } from './Palette';

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
  /** Delete whatever is selected. */
  onDelete: () => void;
  /** Shown in the middle of an empty canvas. */
  emptyHint: ReactNode;
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
 * arrow label and press Enter to select it, arrow keys to move the selected box, Delete or
 * Backspace to remove the selection, Escape to clear it. Connecting by keyboard is done from the
 * settings panel ("Calls…").
 *
 * Drags use HTML5 drag and drop. What is being dragged is kept in React state (not read back from
 * dataTransfer), because browsers hide the dragged data until the drop.
 */
export function BuilderCanvas({ graph, selection, drag, onSelect, onDragStart, onDragEnd, onAdd, onMove, onConnect, onDelete, emptyHint }: BuilderCanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  const markerId = `csl-arrow-${useId().replace(/:/g, '')}`;
  /** The box under a dragged call or box, and why it can't be dropped on (if it can't). */
  const [hover, setHover] = useState<{ id: string; reason?: string } | null>(null);
  const [hoverCell, setHoverCell] = useState<Cell | null>(null);
  /** Where the pointer is while drawing a call, for the dashed preview line. */
  const [pointer, setPointer] = useState<Point | null>(null);

  const isSelected = (type: 'node' | 'edge', id: string) => selection?.type === type && selection.id === id;
  const endDrag = () => {
    setHover(null);
    setHoverCell(null);
    setPointer(null);
    onDragEnd();
  };

  const onCanvasKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
      e.preventDefault();
      onDelete();
      ref.current?.focus();
    } else if (e.key === 'Escape' && selection) {
      onSelect(null);
    }
  };

  const onCanvasDragOver = (e: DragEvent) => {
    if (drag?.type !== 'connect' || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
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
    endDrag();
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
    endDrag();
  };

  const onBoxKeyDown = (e: KeyboardEvent, node: BuilderNode) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect({ type: 'node', id: node.id });
      return;
    }
    const step = ARROW_KEYS[e.key];
    if (!step) return;
    e.preventDefault();
    onSelect({ type: 'node', id: node.id });
    onMove(node.id, { col: node.col + step[0], row: node.row + step[1] });
  };

  const lines = edgeLines(graph);
  const from = drag?.type === 'connect' ? graph.nodes.find((n) => n.id === drag.from) : undefined;
  const style = { '--csl-cell-w': `${CELL_W}px`, '--csl-cell-h': `${CELL_H}px`, '--csl-box-w': `${BOX_W}px`, '--csl-box-h': `${BOX_H}px`, '--csl-cols': GRID_COLS, '--csl-rows': GRID_ROWS } as CSSProperties;

  return (
    <div className="csl-bcanvas-scroll">
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
            const d = `M${line.start.x} ${line.start.y} L${line.end.x} ${line.end.y}`;
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
            className="csl-bcanvas__edge-label"
            style={{ left: line.mid.x, top: line.mid.y }}
            aria-pressed={isSelected('edge', edge.id)}
            aria-label={`${edgeTitle(graph, edge)}: ${callSentence(edge.call)}`}
            title="Edit this call"
            onClick={() => onSelect({ type: 'edge', id: edge.id })}
          >
            {callLabel(edge.call)}
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
                title="Drag to move; click to edit"
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
                <span className="csl-bnode__kind">{KIND_LABELS[node.settings.kind]}</span>
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
                <span className={`csl-bnode__verdict${target.reason ? ' csl-bnode__verdict--no' : ''}`} role="status">
                  {target.reason ? `✕ ${target.reason}` : '✓ Drop to connect'}
                </span>
              )}
            </div>
          );
        })}

        {graph.nodes.length === 0 && <div className="csl-bcanvas__empty">{emptyHint}</div>}
      </div>
    </div>
  );
}
