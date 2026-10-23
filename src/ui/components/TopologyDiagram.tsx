import type { ReactNode } from 'react';
import type { Health, TopologyEdgeView, TopologyNodeView } from './types';

const ARROW_OK = 'var(--csl-arrow)';
const ARROW_BAD = 'var(--csl-bad)';

/** Arrow thickness in px: proportional to requests/s, clamped so thin flows stay visible. */
export function arrowThickness(rps: number): number {
  return Math.round(Math.min(14, Math.max(2, rps / 45)));
}

/** ASSUMPTION: an instance counts as saturated ("hot") once essentially every worker is busy. */
export function instanceColor(busy: number): string {
  return busy >= 0.999 ? 'var(--csl-instance-hot)' : 'var(--csl-instance-calm)';
}

function healthWord(health: Health): string {
  return health === 'bad' ? 'unhealthy' : 'healthy';
}

export function nodeAriaLabel(node: TopologyNodeView): string {
  const count = node.instanceCountLabel ? ` (${node.instanceCountLabel})` : '';
  return `${node.label}${count}: ${node.lines[0]}, ${node.lines[1]}; ${healthWord(node.health)}`;
}

function Node({ node, selected, onSelect, editable }: { node: TopologyNodeView; selected: boolean; onSelect: (id: string) => void; editable: boolean }) {
  return (
    <button
      type="button"
      className={`csl-node${node.health === 'bad' ? ' csl-node--bad' : ''}`}
      style={{ gridColumn: node.col, gridRow: node.row }}
      aria-pressed={editable ? undefined : selected}
      aria-label={editable ? `Edit ${node.label} settings. ${nodeAriaLabel(node)}` : nodeAriaLabel(node)}
      title={editable ? `Edit ${node.label} settings` : undefined}
      onClick={() => onSelect(node.id)}
    >
      <span className="csl-node__head">
        <span className="csl-node__label">{node.label}</span>
        {node.instanceCountLabel && <span className="csl-node__count">{node.instanceCountLabel}</span>}
        {editable && (
          <span className="csl-node__edit" aria-hidden="true">
            ✎
          </span>
        )}
      </span>
      {node.instanceBusy.length > 0 && (
        <span className="csl-node__instances" data-testid={`instances-${node.id}`}>
          {node.instanceBusy.map((busy, i) => (
            <span
              key={i}
              className="csl-instance"
              title={`instance ${i + 1}: ${Math.round(busy * 100)}% of workers busy`}
              style={{ background: instanceColor(busy) }}
            />
          ))}
        </span>
      )}
      <span className="csl-node__line">{node.lines[0]}</span>
      <span className="csl-node__line">{node.lines[1]}</span>
    </button>
  );
}

function Triangle({ dir, color }: { dir: 'right' | 'up' | 'down'; color: string }) {
  if (dir === 'right') {
    return (
      <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
        <path d="M0 0 L10 7 L0 14 Z" style={{ fill: color }} />
      </svg>
    );
  }
  return (
    <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
      <path d={dir === 'up' ? 'M0 10 L7 0 L14 10 Z' : 'M0 0 L7 10 L14 0 Z'} style={{ fill: color }} />
    </svg>
  );
}

function Edge({ edge }: { edge: TopologyEdgeView }) {
  const color = edge.health === 'bad' ? ARROW_BAD : ARROW_OK;
  const thickness = `${arrowThickness(edge.rps)}px`;
  const cls = `csl-edge csl-edge--${edge.orientation}${edge.health === 'bad' ? ' csl-edge--bad' : ''}`;
  const place = { gridColumn: edge.col, gridRow: edge.row };

  if (edge.orientation === 'vertical') {
    // Double-headed: requests go up to the cache and answers come back down.
    return (
      <div className={cls} style={place} data-testid={`edge-${edge.id}`}>
        <span className="csl-edge__vstack">
          <Triangle dir="up" color={color} />
          <span data-testid="edge-shaft" style={{ flex: '1 1 auto', width: thickness, background: color }} />
          <Triangle dir="down" color={color} />
        </span>
        <span className="csl-edge__vtext">
          <span className="csl-edge__label">{edge.label}</span>
          <span className="csl-edge__detail">{edge.detail}</span>
        </span>
      </div>
    );
  }
  return (
    <div className={cls} style={place} data-testid={`edge-${edge.id}`}>
      <span className="csl-edge__label">{edge.label}</span>
      <span className="csl-edge__shaft-row">
        <span className="csl-edge__shaft" data-testid="edge-shaft" style={{ height: thickness, background: color }} />
        <Triangle dir="right" color={color} />
      </span>
      <span className="csl-edge__detail">{edge.detail}</span>
    </div>
  );
}

export interface TopologyDiagramProps {
  nodes: TopologyNodeView[];
  edges: TopologyEdgeView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Extra sentence for the key line, e.g. "Snapshot at t = 60 s. Click a box to edit that tier." */
  note?: string;
  /** Clicking a box edits that tier (shows an edit mark and says so to screen readers). */
  editable?: boolean;
  /** Controls shown beside the key line, e.g. an "Edit all settings" button. */
  actions?: ReactNode;
}

/** System diagram: tiers as selectable cards on a 7×3 grid, flows as arrows between them. */
export function TopologyDiagram({ nodes, edges, selectedId, onSelect, note, editable = false, actions }: TopologyDiagramProps) {
  return (
    <div>
      <div className="csl-topology-scroll">
        <div className="csl-topology-grid">
          {nodes.map((n) => (
            <Node key={n.id} node={n} selected={n.id === selectedId} onSelect={onSelect} editable={editable} />
          ))}
          {edges.map((e) => (
            <Edge key={e.id} edge={e} />
          ))}
        </div>
      </div>
      <div className="csl-topology-key">
        <span>Arrow thickness = requests/s. Orange = mostly retries or failing.</span>
        <span className="csl-topology-key__item">
          Instances:
          <span className="csl-instance" style={{ background: 'var(--csl-instance-calm)' }} />
          idle-ish
          <span className="csl-instance" style={{ background: 'var(--csl-instance-hot)' }} />
          all workers busy
        </span>
        {note && <span>{note}</span>}
        {actions && <span className="csl-topology-key__actions">{actions}</span>}
      </div>
    </div>
  );
}
