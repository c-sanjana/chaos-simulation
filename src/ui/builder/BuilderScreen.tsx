import { useId, useRef, useState, type ReactNode } from 'react';
import { addCell, addNode, connect, emptyGraph, moveNode, removeEdge, removeNode, type Cell } from '../../builder/edit';
import type { BuilderGraph, ComponentKind } from '../../builder/graph';
import { focusField, useInvalidFields } from '../components/useInvalidFields';
import { exampleGraph } from '../system';
import { BuilderCanvas, type Drag, type Selection } from './BuilderCanvas';
import { displayName, edgeTitle } from './describe';
import { Palette } from './Palette';
import { SettingsPanel } from './SettingsPanel';
import './builder.css';

export interface BuilderScreenProps {
  graph: BuilderGraph;
  onChange: (graph: BuilderGraph) => void;
  /** What stops this graph from being simulated, in plain words (from the validator). */
  problems: string[];
  /** Simulate this topology. Only offered while there are no problems. */
  onUse: () => void;
  /** More buttons for the toolbar, before "Use this topology" (e.g. Cancel). */
  actions?: ReactNode;
  /** A line under the subtitle (e.g. what the builder supports for now). */
  note?: string;
}

/** The last thing that happened, for the status line: a confirmation, or why an edit was refused. */
interface Status {
  text: string;
  refused: boolean;
}

/** The chain from the Client, e.g. "Client → Gateway → App server → DB, with a Cache". */
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
export function BuilderScreen({ graph, onChange, problems, onUse, actions, note }: BuilderScreenProps) {
  const [selection, setSelection] = useState<Selection>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
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

  const add = (kind: ComponentKind, cell: Cell | null) => {
    // With no free cell, addNode itself explains that the canvas is full.
    const at = cell ?? { col: 1, row: 1 };
    const result = addNode(graph, kind, at.col, at.row);
    if (result.reason) return refuse(result.reason);
    const node = result.graph.nodes.find((n) => n.id === result.id)!;
    commit(result.graph, `Added ${displayName(node)}. Its settings are open in the Settings panel.`, { type: 'node', id: node.id });
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

  const remove = () => {
    if (selection?.type === 'node') {
      const node = graph.nodes.find((n) => n.id === selection.id);
      if (node) commit(removeNode(graph, node.id), `Removed ${displayName(node)} and its calls.`, null, true);
    } else if (selection?.type === 'edge') {
      const edge = graph.edges.find((e) => e.id === selection.id);
      if (edge) commit(removeEdge(graph, edge.id), `Removed the call. ${edgeTitle(graph, edge).replace(' calls ', ' no longer calls ')}.`, null, true);
    }
    setSelection(null);
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
  };

  const fieldProblems = invalid.map((f) => `"${f.label}" isn't a number that can be used yet: fix the field marked in red.`);
  const allProblems = [...fieldProblems, ...problems];
  const ready = allProblems.length === 0;
  const toFix = allProblems.length === 1 ? 'One thing to fix' : `${allProblems.length} things to fix`;

  /** "Use this topology" while there are problems: show them (or the field to fix) instead. */
  const showProblems = () => {
    if (invalid.length > 0) return focusField(invalid[0]);
    problemsRef.current?.scrollIntoView?.({ block: 'nearest' });
    problemsRef.current?.focus();
  };

  return (
    <section className="csl-builder" aria-label="Topology builder">
      <div className="csl-builder__bar">
        <div className="csl-builder__titles">
          <h2 className="csl-builder__title">Build your own system</h2>
          <p className="csl-builder__subtitle">
            Place components, connect them, and set how each call times out and retries.{note && <span className="csl-builder__note"> {note}</span>}
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
            {!ready && <span className="csl-builder__use-count"> · {allProblems.length} {allProblems.length === 1 ? 'thing' : 'things'} to fix</span>}
          </button>
        </div>
      </div>

      <div className="csl-builder__body" ref={setBody}>
        <div className="csl-builder__main">
          <Palette
            unavailable={hasClient ? { client: `There is already a Client. One Client stands for all your users.` } : {}}
            onAdd={(kind) => add(kind, addCell(graph, selection?.type === 'node' ? selection.id : undefined))}
            onDragStart={(kind) => setDrag({ type: 'new', kind })}
            onDragEnd={() => setDrag(null)}
          />
          <BuilderCanvas
            graph={graph}
            selection={selection}
            drag={drag}
            onSelect={setSelection}
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
            <p className={`csl-builder__status${status?.refused ? ' csl-builder__status--refused' : ''}`} role="status">
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
            {ready ? (
              <p className="csl-builder__ready">
                <span aria-hidden="true">✓ </span>Ready to simulate.
              </p>
            ) : (
              <div className="csl-builder__problems" id={problemsId} ref={problemsRef} tabIndex={-1} aria-label={`${toFix} before simulating`}>
                <p className="csl-builder__problems-title">
                  <span aria-hidden="true">⚠ </span>
                  {toFix} before simulating:
                </p>
                <ul className="csl-builder__problem-list">
                  {allProblems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
        <SettingsPanel graph={graph} selection={selection} onChange={onChange} onSelect={setSelection} onConnect={link} onDelete={remove} />
      </div>
    </section>
  );
}
