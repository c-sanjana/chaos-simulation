import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { addCell, addNode, connect, emptyGraph, moveNode, removeEdge, removeNode, type Cell } from '../../builder/edit';
import type { BuilderGraph, ComponentKind } from '../../builder/graph';
import type { GraphProblem } from '../../builder/validate';
import { focusField, useInvalidFields, type InvalidField } from '../components/useInvalidFields';
import { exampleGraph } from '../system';
import { BuilderCanvas, type CanvasMark, type CanvasMarks, type Drag, type Selection } from './BuilderCanvas';
import { displayName, edgeEnds, edgeTitle } from './describe';
import { Palette } from './Palette';
import { SettingsPanel } from './SettingsPanel';
import './builder.css';

export interface BuilderScreenProps {
  graph: BuilderGraph;
  onChange: (graph: BuilderGraph) => void;
  /**
   * What stops this graph from being simulated (from `findProblems`): each with the boxes and
   * arrows it is about, which the canvas marks. A plain message marks nothing and counts as wrong.
   */
  problems: ReadonlyArray<GraphProblem | string>;
  /** Simulate this topology. Only offered while there are no problems. */
  onUse: () => void;
  /** More buttons for the toolbar, before "Use this topology" (e.g. Cancel). */
  actions?: ReactNode;
}

/** The last thing that happened, for the status line: a confirmation, or why an edit was refused. */
interface Status {
  text: string;
  refused: boolean;
}

/** Problems listed before "Show all": the list above the canvas stays short, so the canvas stays on screen. */
const PROBLEMS_SHOWN = 3;

/** A problem as the builder lists it: a validator's, or a half-typed field's (which `field` then names). */
interface ListedProblem extends GraphProblem {
  field?: InvalidField;
}

/** "1 problem to fix" / "2 things to finish": problems while anything is wrong, else steps still to take. */
function countText(count: number, wrong: boolean): string {
  return wrong ? `${count} ${count === 1 ? 'problem' : 'problems'} to fix` : `${count} ${count === 1 ? 'thing' : 'things'} to finish`;
}

/** How to draw an arrow, with the mouse and with the keyboard: said once under the list, not in every message. */
const DRAW_ARROW_HINT = 'To draw an arrow, drag from a box’s blue dot to another box. By keyboard: select a box, pick a part under “Calls…”, then press Connect.';

/** Below this width the settings panel sits under the canvas (builder.css), so selecting a box scrolls it into view. */
const PANEL_BELOW_QUERY = '(max-width: 900px)';

/** The chain from the Client, e.g. "Client → Load balancer → App server → DB, with a Cache". */
function exampleChain(graph: BuilderGraph): string {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const names: string[] = [];
  let at = graph.nodes.find((n) => n.settings.kind === 'client');
  while (at) {
    names.push(displayName(at));
    const id: string = at.id;
    const next = graph.edges.find((e) => e.from === id && byId.get(e.to)?.settings.kind !== 'cache');
    at = next ? byId.get(next.to) : undefined;
  }
  const cache = graph.nodes.find((n) => n.settings.kind === 'cache');
  return `${names.join(' → ')}${cache ? `, with a ${displayName(cache)}` : ''}`;
}

/**
 * The topology builder: a palette of components, a canvas to place and connect them on, and a
 * settings panel for whatever is selected. The graph is owned by the parent (`graph`/`onChange`);
 * only the selection, the drag in progress and the status line live here.
 */
export function BuilderScreen({ graph, onChange, problems, onUse, actions }: BuilderScreenProps) {
  const [selection, setSelection] = useState<Selection>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  /** Every problem listed, or only the first few (whole sentences either way; the count is beside "Use this topology"). */
  const [showAll, setShowAll] = useState(false);
  /** The graph as it was before the last Clear, example or removal, so that can be undone. */
  const [undoTo, setUndoTo] = useState<BuilderGraph | null>(null);
  const problemsId = useId();
  const problemsRef = useRef<HTMLDivElement>(null);
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  // Half-typed numbers in the settings panel aren't in the graph yet: they count as problems too.
  const invalid = useInvalidFields(body);

  const hasClient = graph.nodes.some((n) => n.settings.kind === 'client');

  const refuse = (reason: string) => setStatus({ text: reason, refused: true });
  /** Makes a change; `undoable` keeps the graph before it for the status line's Undo. */
  const commit = (next: BuilderGraph, text: string, select?: Selection, undoable = false) => {
    onChange(next);
    if (select !== undefined) setSelection(select);
    setUndoTo(undoable ? graph : null);
    setStatus({ text, refused: false });
  };
  /**
   * An edit in the settings panel (a name, a number, a share). It ends what Undo could bring back:
   * Undo restores the whole graph from before a removal, which would quietly revert this edit too.
   */
  const panelChange = (next: BuilderGraph) => {
    onChange(next);
    if (undoTo) {
      setUndoTo(null);
      setStatus(null);
    }
  };

  /** Where focus goes once the next render is on screen: a box's or arrow's settings, the canvas, the status line, a new box. */
  const [focusNext, setFocusNext] = useState<
    { to: 'panel' } | { to: 'canvas' } | { to: 'status' } | { to: 'node'; id: string } | { to: 'marked'; target: NonNullable<Selection> } | null
  >(null);
  useEffect(() => {
    if (!focusNext || !body) return;
    setFocusNext(null);
    if (focusNext.to === 'panel') body.querySelector<HTMLElement>('[data-panel-title]')?.focus();
    else if (focusNext.to === 'marked') {
      // A problem's "Show": focus its box or arrow on the canvas (marked, and selected so its settings are open).
      const { type, id } = focusNext.target;
      const el = body.querySelector<HTMLElement>(type === 'node' ? `[data-testid="node-${id}"] [role="button"]` : `[data-edge-label="${id}"]`);
      el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      el?.focus({ preventScroll: true });
    }
    else if (focusNext.to === 'canvas') body.querySelector<HTMLElement>('.csl-bcanvas')?.focus();
    else if (focusNext.to === 'status') body.querySelector<HTMLElement>('.csl-builder__status')?.focus();
    // A new box may land outside the canvas's visible part (it scrolls sideways on smaller screens).
    else body.querySelector(`[data-testid="node-${focusNext.id}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [focusNext, body]);
  /** Selects a box or arrow; on a narrow screen, where the settings panel sits below the canvas, it scrolls into view. */
  const select = (next: Selection) => {
    setSelection(next);
    if (next && window.matchMedia?.(PANEL_BELOW_QUERY).matches) body?.querySelector('.csl-bpanel')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  /** Chosen with the keyboard: select it, then focus its settings. */
  const open = (next: NonNullable<Selection>) => {
    setSelection(next);
    setFocusNext({ to: 'panel' });
  };

  const add = (kind: ComponentKind, cell: Cell | null) => {
    // With no free cell, addNode itself explains that the canvas is full.
    const at = cell ?? { col: 1, row: 1 };
    const result = addNode(graph, kind, at.col, at.row);
    if (result.reason) return refuse(result.reason);
    const node = result.graph.nodes.find((n) => n.id === result.id)!;
    commit(result.graph, `Added ${displayName(node)}. Its settings are open in the Settings panel.`, { type: 'node', id: node.id });
    setFocusNext({ to: 'node', id: node.id });
  };

  const move = (id: string, cell: Cell) => {
    const result = moveNode(graph, id, cell.col, cell.row);
    if (result.reason) return refuse(result.reason);
    if (result.graph !== graph) commit(result.graph, `Moved to column ${cell.col}, row ${cell.row}.`);
  };

  const link = (from: string, to: string) => {
    const result = connect(graph, from, to);
    if (result.reason) return refuse(result.reason);
    const edge = result.graph.edges.find((e) => e.id === result.id)!;
    commit(result.graph, `${edgeTitle(result.graph, edge)} now.`, { type: 'edge', id: edge.id });
  };

  /** Removes a box (with its arrows) or an arrow: `target`, or else what is selected. Focus goes to the canvas. */
  const remove = (target: Selection = selection) => {
    if (target?.type === 'node') {
      const node = graph.nodes.find((n) => n.id === target.id);
      if (node) commit(removeNode(graph, node.id), `Removed ${displayName(node)} and its calls.`, null, true);
    } else if (target?.type === 'edge') {
      const edge = graph.edges.find((e) => e.id === target.id);
      if (edge) commit(removeEdge(graph, edge.id), `Removed the call. ${edgeTitle(graph, edge).replace(' calls ', ' no longer calls ')}.`, null, true);
    }
    setSelection(null);
    setFocusNext({ to: 'canvas' });
  };

  const loadExample = () => {
    const example = exampleGraph();
    commit(example, `Loaded the example: ${exampleChain(example)}.`, null, graph.nodes.length > 0);
  };

  // ASSUMPTION: no "are you sure?" dialog; an Undo button on the status line is gentler.
  const clear = () => commit(emptyGraph(), 'Cleared the canvas.', null, true);

  const undo = () => {
    if (undoTo) onChange(undoTo);
    setUndoTo(null);
    setSelection(null);
    setStatus({ text: 'Brought back the previous topology.', refused: false });
    setFocusNext({ to: 'status' }); // the Undo button is gone; the status line says what happened
  };

  // A half-typed field belongs to the part or call whose settings are open: name it, with the field's own message.
  const selected = selection?.type === 'node' ? graph.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedEdge = selection?.type === 'edge' ? graph.edges.find((e) => e.id === selection.id) : undefined;
  const of = selected ? ` on ${displayName(selected)}` : selectedEdge ? ` on ${arrowName(graph, selectedEdge.id)}` : '';
  const fieldProblems: ListedProblem[] = invalid.map((f) => ({
    text: `"${f.label}"${of} isn't valid yet. ${(f.input.validationMessage || 'Type a number.').replace(/([^.])$/, '$1.')}`,
    severity: 'wrong',
    nodes: selected ? [selected.id] : [],
    edges: selectedEdge ? [selectedEdge.id] : [],
    field: f,
  }));
  const allProblems: ListedProblem[] = [...fieldProblems, ...problems.map((p): ListedProblem => (typeof p === 'string' ? { text: p, severity: 'wrong', nodes: [], edges: [] } : p))];
  const ready = allProblems.length === 0;
  // Amber while every problem is a step still to take; red once anything is actually wrong.
  const wrong = allProblems.some((p) => p.severity === 'wrong');
  const tone = wrong ? 'wrong' : 'unfinished';
  const count = countText(allProblems.length, wrong);
  const title = wrong ? `${count} before simulating` : `Not ready yet: ${count}`;
  const marks = canvasMarks(allProblems);

  /** Bumped each time the list is pointed to, to replay its highlight (two animation names take turns, so it restarts). */
  const [flash, setFlash] = useState(0);
  /** "Use this topology" or the count while there are problems: point to the list (and to the field to fix first, if any). */
  const showProblems = () => {
    setFlash((n) => n + 1);
    if (invalid.length > 0) return focusField(invalid[0]);
    problemsRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    problemsRef.current?.focus({ preventScroll: true });
  };

  /** The box or arrow a problem is about (the first one still on the canvas), or null. */
  const targetOf = (p: ListedProblem): NonNullable<Selection> | null => {
    const node = p.nodes.find((id) => graph.nodes.some((n) => n.id === id));
    if (node) return { type: 'node', id: node };
    const edge = p.edges.find((id) => graph.edges.some((e) => e.id === id));
    return edge ? { type: 'edge', id: edge } : null;
  };
  /** A problem's "Show": the field to fix, or its box or arrow, selected (settings open) and focused on the canvas. */
  const showTarget = (p: ListedProblem) => {
    if (p.field) return focusField(p.field);
    const target = targetOf(p);
    if (!target) return;
    setSelection(target);
    setFocusNext({ to: 'marked', target });
  };
  const targetName = (p: ListedProblem) => {
    if (p.field) return `the “${p.field.label}” field`;
    const target = targetOf(p);
    if (target?.type === 'node') return displayName(graph.nodes.find((n) => n.id === target.id)!);
    return target ? arrowName(graph, target.id) : null;
  };

  return (
    <section className="csl-builder" aria-label="Topology builder">
      <div className="csl-builder__bar">
        <div className="csl-builder__titles">
          <h2 className="csl-builder__title">Build your own system</h2>
          <p className="csl-builder__subtitle">
            Place components, connect them, and set how each call times out and retries.
          </p>
        </div>
        <div className="csl-builder__actions">
          <button type="button" className="csl-btn csl-btn--small" onClick={loadExample}>
            Start from the example
          </button>
          <button type="button" className="csl-btn csl-btn--small" onClick={clear} disabled={graph.nodes.length === 0}>
            Clear
          </button>
          {actions}
          {ready ? (
            <span className="csl-builder__badge csl-builder__badge--ready">
              <span aria-hidden="true">✓</span>Ready to simulate
            </span>
          ) : (
            // The count, beside the button it holds back: it takes you to the list.
            <button
              type="button"
              className={`csl-builder__badge csl-builder__badge--${tone}`}
              aria-controls={problemsId}
              onMouseDown={(e) => e.preventDefault()}
              onClick={showProblems}
            >
              <span aria-hidden="true">⚠ </span>
              {count}
            </button>
          )}
          <button
            type="button"
            className="csl-btn csl-btn--primary"
            // aria-disabled, not disabled: it stays clickable and takes you to what needs fixing.
            aria-disabled={ready ? undefined : true}
            aria-describedby={ready ? undefined : problemsId}
            // Keeps the cursor in a half-typed field, so its text isn't swapped for the last valid value first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={ready ? onUse : showProblems}
          >
            Use this topology
          </button>
        </div>
        {/* Says when the count changes (or the drawing becomes ready), without moving focus. */}
        <p className="csl-sr-only" role="status" data-testid="problem-count">
          {ready ? 'Ready to simulate.' : `${count}.`}
        </p>
      </div>

      <div className="csl-builder__body" ref={setBody}>
        <div className="csl-builder__main">
          <Palette
            unavailable={hasClient ? { client: `There is already a Client. One Client stands for all your users.` } : {}}
            onAdd={(kind) => add(kind, addCell(graph, selection?.type === 'node' ? selection.id : undefined))}
            onDragStart={(kind) => setDrag({ type: 'new', kind })}
            onDragEnd={() => setDrag(null)}
          />
          {!ready && (
            // Above the canvas, so it is on screen without scrolling (user feedback, 2026-10-25).
            <div
              className={`csl-builder__problems csl-builder__problems--${tone}${flash > 0 ? ` csl-builder__problems--flash-${flash % 2}` : ''}`}
              id={problemsId}
              ref={problemsRef}
              tabIndex={-1}
              role="group"
              aria-label={title}
            >
              <p className="csl-builder__problems-title">
                <span aria-hidden="true">⚠ </span>
                {title}
              </p>
              <ul className="csl-builder__problem-list">
                {(showAll ? allProblems : allProblems.slice(0, PROBLEMS_SHOWN)).map((p) => {
                  const name = targetName(p);
                  return (
                    <li key={p.text} className={`csl-builder__problem csl-builder__problem--${p.severity}`}>
                      {p.text}
                      {name && (
                        <button type="button" className="csl-btn csl-btn--link csl-builder__problem-show" onMouseDown={(e) => e.preventDefault()} onClick={() => showTarget(p)}>
                          Show<span className="csl-sr-only"> {name}</span>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {allProblems.length > PROBLEMS_SHOWN && (
                <button type="button" className="csl-btn csl-btn--link csl-builder__problems-more" aria-expanded={showAll} onClick={() => setShowAll((x) => !x)}>
                  {showAll ? 'Show fewer' : `Show all ${allProblems.length}`}
                </button>
              )}
              {allProblems.some((p) => p.drawArrow) && <p className="csl-builder__problems-hint">{DRAW_ARROW_HINT}</p>}
            </div>
          )}
          <BuilderCanvas
            graph={graph}
            selection={selection}
            drag={drag}
            marks={marks}
            onSelect={select}
            onOpen={open}
            onDragStart={setDrag}
            onDragEnd={() => setDrag(null)}
            onAdd={add}
            onMove={move}
            onConnect={link}
            onRefused={refuse}
            onDelete={remove}
            emptyHint={
              <>
                <p className="csl-bcanvas__empty-title">Your canvas is empty</p>
                <p>Drag components here from the list above, or press their Add buttons. Requests start at a Client.</p>
                <button type="button" className="csl-btn csl-btn--small" onClick={loadExample}>
                  Start from the example
                </button>
              </>
            }
          />
          <div className="csl-builder__foot">
            <p className={`csl-builder__status${status?.refused ? ' csl-builder__status--refused' : ''}`} role="status" tabIndex={-1}>
              {status && (
                <>
                  {status.refused && <strong>Not possible: </strong>}
                  {status.text}
                  {undoTo && (
                    <button type="button" className="csl-btn csl-btn--link" onClick={undo}>
                      Undo
                    </button>
                  )}
                </>
              )}
            </p>
          </div>
        </div>
        <SettingsPanel graph={graph} selection={selection} onChange={panelChange} onSelect={setSelection} onConnect={link} onDelete={() => remove()} />
      </div>
    </section>
  );
}

/** "the arrow from App server to Database", by names (ids for parts that are gone). */
function arrowName(graph: BuilderGraph, edgeId: string): string {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return 'the arrow';
  const { from, to } = edgeEnds(graph, edge);
  return `the arrow from ${from ? displayName(from) : edge.from} to ${to ? displayName(to) : edge.to}`;
}

/** The marks on the canvas: for each box and arrow with a problem, its messages, red if any is wrong (else amber). */
function canvasMarks(problems: ListedProblem[]): CanvasMarks {
  const marks: CanvasMarks = { nodes: new Map(), edges: new Map() };
  const add = (map: Map<string, CanvasMark>, id: string, p: ListedProblem) => {
    const had = map.get(id);
    map.set(id, had ? { severity: had.severity === 'wrong' ? 'wrong' : p.severity, texts: [...had.texts, p.text] } : { severity: p.severity, texts: [p.text] });
  };
  for (const p of problems) {
    p.nodes.forEach((id) => add(marks.nodes, id, p));
    p.edges.forEach((id) => add(marks.edges, id, p));
  }
  return marks;
}
