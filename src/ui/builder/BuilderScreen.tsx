import { useId, useState } from 'react';
import { addNode, connect, emptyGraph, firstFreeCell, moveNode, removeEdge, removeNode, starterGraph, type Cell } from '../../builder/edit';
import type { BuilderGraph, ComponentKind } from '../../builder/graph';
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
}

/** The last thing that happened, for the status line: a confirmation, or why an edit was refused. */
interface Status {
  text: string;
  refused: boolean;
}

/**
 * The topology builder: a palette of components, a canvas to place and connect them on, and a
 * settings panel for whatever is selected. The graph is owned by the parent (`graph`/`onChange`);
 * only the selection, the drag in progress and the status line live here.
 */
export function BuilderScreen({ graph, onChange, problems, onUse }: BuilderScreenProps) {
  const [selection, setSelection] = useState<Selection>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  /** The graph as it was before "Clear", so the clear can be undone. */
  const [cleared, setCleared] = useState<BuilderGraph | null>(null);
  const problemsId = useId();

  const hasClient = graph.nodes.some((n) => n.settings.kind === 'client');

  const refuse = (reason: string) => setStatus({ text: reason, refused: true });
  const commit = (next: BuilderGraph, text: string, select?: Selection) => {
    onChange(next);
    if (select) setSelection(select);
    setCleared(null);
    setStatus({ text, refused: false });
  };

  const add = (kind: ComponentKind, cell: Cell | null) => {
    // With no free cell, addNode itself explains that the canvas is full.
    const at = cell ?? { col: 1, row: 1 };
    const result = addNode(graph, kind, at.col, at.row);
    if (result.reason) return refuse(result.reason);
    const node = result.graph.nodes.find((n) => n.id === result.id)!;
    commit(result.graph, `Added ${displayName(node)}. Its settings are on the right.`, { type: 'node', id: node.id });
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
      if (node) {
        onChange(removeNode(graph, node.id));
        setStatus({ text: `Removed ${displayName(node)} and its calls.`, refused: false });
      }
    } else if (selection?.type === 'edge') {
      const edge = graph.edges.find((e) => e.id === selection.id);
      if (edge) {
        onChange(removeEdge(graph, edge.id));
        setStatus({ text: `Removed the call: ${edgeTitle(graph, edge)} no longer.`, refused: false });
      }
    }
    setSelection(null);
  };

  const loadExample = () => {
    setCleared(graph.nodes.length > 0 ? graph : null);
    onChange(starterGraph());
    setSelection(null);
    setStatus({ text: 'Loaded the example: Client → Load balancer → Server → Database, with a Cache.', refused: false });
  };

  // ASSUMPTION: no "are you sure?" dialog; an Undo button on the status line is gentler.
  const clear = () => {
    setCleared(graph);
    onChange(emptyGraph());
    setSelection(null);
    setStatus({ text: 'Cleared the canvas.', refused: false });
  };

  const undo = () => {
    if (cleared) onChange(cleared);
    setCleared(null);
    setStatus({ text: 'Brought back the previous topology.', refused: false });
  };

  const ready = problems.length === 0;

  return (
    <section className="csl-builder" aria-label="Topology builder">
      <div className="csl-builder__bar">
        <div className="csl-builder__titles">
          <h2 className="csl-builder__title">Build your own system</h2>
          <p className="csl-builder__subtitle">Place components, connect them, and set how each call times out and retries.</p>
        </div>
        <div className="csl-builder__actions">
          <button type="button" className="csl-btn csl-btn--small" onClick={loadExample}>
            Start from the example
          </button>
          <button type="button" className="csl-btn csl-btn--small" onClick={clear} disabled={graph.nodes.length === 0}>
            Clear
          </button>
          <button type="button" className="csl-btn csl-btn--primary" disabled={!ready} aria-describedby={ready ? undefined : problemsId} onClick={onUse}>
            Use this topology
          </button>
        </div>
      </div>

      <div className="csl-builder__body">
        <div className="csl-builder__main">
          <Palette
            unavailable={hasClient ? { client: `There is already a Client. One Client stands for all your users.` } : {}}
            onAdd={(kind) => add(kind, firstFreeCell(graph))}
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
                  {cleared && (
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
              <div className="csl-builder__problems" id={problemsId}>
                <p className="csl-builder__problems-title">
                  <span aria-hidden="true">⚠ </span>
                  {problems.length === 1 ? 'One thing to fix' : `${problems.length} things to fix`} before simulating:
                </p>
                <ul className="csl-builder__problem-list">
                  {problems.map((p) => (
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
