import type { CSSProperties, ReactNode } from 'react';
import type { Health, TopologyEdgeView, TopologyNodeView } from './types';
import './topology.css';

/*
 * How the diagram shows what is happening (styles in topology.css):
 * - Arrows: thickness = requests/s; light dashes travel from caller to callee, faster for more
 *   requests/s. An orange striped band along the shaft is the share of calls that are retries
 *   ("↻ incl. N retries"); a red shaft with a "✕ N%" pill (just "✕" when compact) means the
 *   callee is failing calls.
 * - Boxes: a failing tier (over 5% errors) gets a red wash, red border, a slow pulsing ring and a
 *   "✕ N% errors" badge. Orange border = stressed (saturated or slow) but not failing.
 */

const ARROW_OK = 'var(--csl-arrow)';
const ARROW_RETRY = 'var(--csl-retry)';
const ARROW_FAIL = 'var(--csl-fail)';

/** Error share above which a box or arrow is drawn as failing. Matches BAD_ERROR_SHARE in viewModels.ts. */
export const FAILING_ERROR_SHARE = 0.05;
/** Retry share above which an arrow is drawn as retrying (orange label and arrowhead). */
export const RETRYING_SHARE = 0.05;

/** Arrow thickness in px: proportional to requests/s, clamped so thin flows stay visible. */
export function arrowThickness(rps: number): number {
  return Math.round(Math.min(14, Math.max(2, rps / 45)));
}

/**
 * Seconds for the flow dashes to move one pattern length, or null for no motion (no requests).
 * Speed grows with the logarithm of requests/s so that 50 rps and 1,000 rps both look sensible;
 * it is clamped to 0.4..2.4 s and rounded to 0.1 s so small changes between replay frames
 * don't make the dashes jump.
 */
export function flowDurationS(rps: number): number | null {
  if (!(rps > 0)) return null;
  const seconds = Math.min(2.4, Math.max(0.4, 2.6 - 0.7 * Math.log10(rps)));
  return Math.round(seconds * 10) / 10;
}

/** ASSUMPTION: an instance counts as saturated ("hot") once essentially every worker is busy. */
export function instanceColor(busy: number): string {
  return busy >= 0.999 ? 'var(--csl-instance-hot)' : 'var(--csl-instance-calm)';
}

function isFailing(errorShare: number | undefined): boolean {
  return (errorShare ?? 0) > FAILING_ERROR_SHARE;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * How strongly a box is washed red, as a percentage of the wash colour: none while healthy,
 * then 40% at the failing threshold rising to 100% when every response fails.
 */
export function errorWash(errorShare: number | undefined): number {
  return isFailing(errorShare) ? Math.round(40 + 60 * (errorShare as number)) : 0;
}

function healthWord(health: Health): string {
  return health === 'bad' ? 'unhealthy' : 'healthy';
}

export function nodeAriaLabel(node: TopologyNodeView): string {
  const count = node.instanceCountLabel ? ` (${node.instanceCountLabel})` : '';
  const failing = isFailing(node.errorShare) ? `; failing, ${percent(node.errorShare as number)} errors` : '';
  return `${node.label}${count}: ${node.lines[0]}, ${node.lines[1]}; ${healthWord(node.health)}${failing}`;
}

function Node({ node, selected, onSelect, editable }: { node: TopologyNodeView; selected: boolean; onSelect: (id: string) => void; editable: boolean }) {
  const failing = isFailing(node.errorShare);
  const cls = `csl-node${node.health === 'bad' ? ' csl-node--bad' : ''}${failing ? ' csl-node--failing' : ''}`;
  const style = { gridColumn: node.col, gridRow: node.row, '--csl-node-wash': `${errorWash(node.errorShare)}%` } as CSSProperties;
  return (
    <button
      type="button"
      className={cls}
      style={style}
      aria-pressed={editable ? undefined : selected}
      aria-label={editable ? `Edit ${node.label} settings. ${nodeAriaLabel(node)}` : nodeAriaLabel(node)}
      title={editable ? `Edit ${node.label} settings` : undefined}
      onClick={() => onSelect(node.id)}
    >
      {failing && (
        <span className="csl-node__badge" aria-hidden="true">
          ✕ {percent(node.errorShare as number)} errors
        </span>
      )}
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

type EdgeKind = 'ok' | 'retrying' | 'failing';

/** Failing wins over retrying; an unhealthy arrow without a failure is mostly retries. */
export function edgeKind(edge: TopologyEdgeView): EdgeKind {
  if (isFailing(edge.errorShare)) return 'failing';
  if (edge.health === 'bad' || (edge.retryShare ?? 0) > RETRYING_SHARE) return 'retrying';
  return 'ok';
}

/**
 * The arrow's shaft: a track (red when failing), an orange band for the retry share, and the
 * moving flow dashes. The band runs along the shaft and its thickness is the retry share of the
 * arrow's thickness, so thick retry storms show a thick orange band.
 */
function Shaft({ edge, vertical, kind }: { edge: TopologyEdgeView; vertical: boolean; kind: EdgeKind }) {
  const thickness = `${arrowThickness(edge.rps)}px`;
  const duration = flowDurationS(edge.rps);
  const retryShare = edge.retryShare ?? 0;
  const size = vertical ? { width: thickness } : { height: thickness };
  return (
    <span className="csl-edge__shaft" data-testid="edge-shaft" style={{ ...size, background: kind === 'failing' ? ARROW_FAIL : ARROW_OK }}>
      {retryShare > 0 && (
        <span className="csl-edge__retry" data-testid="edge-retry" style={vertical ? { width: percent(retryShare) } : { height: percent(retryShare) }} />
      )}
      {duration !== null && <span className="csl-edge__flow" data-testid="edge-flow" style={{ animationDuration: `${duration}s` }} />}
    </span>
  );
}

function FailPill({ edge }: { edge: TopologyEdgeView }) {
  return (
    <span className="csl-edge__fail">
      <span aria-hidden="true">✕ </span>
      <span className="csl-edge__fail-pct">{percent(edge.errorShare as number)}</span>
      <span className="csl-edge__fail-word"> fail</span>
    </span>
  );
}

function Detail({ edge }: { edge: TopologyEdgeView }) {
  const retries = (edge.retryShare ?? 0) > 0;
  return (
    <span className={`csl-edge__detail${retries ? ' csl-edge__detail--retry' : ''}`}>
      {retries && <span aria-hidden="true">↻ </span>}
      {edge.detail}
    </span>
  );
}

function Edge({ edge }: { edge: TopologyEdgeView }) {
  const kind = edgeKind(edge);
  const head = kind === 'failing' ? ARROW_FAIL : kind === 'retrying' ? ARROW_RETRY : ARROW_OK;
  const cls = `csl-edge csl-edge--${edge.orientation} csl-edge--${kind}${edge.health === 'bad' ? ' csl-edge--bad' : ''}${edge.rps > 0 ? '' : ' csl-edge--still'}`;
  const place = { gridColumn: edge.col, gridRow: edge.row };

  if (edge.orientation === 'vertical') {
    // Double-headed: requests go up to the cache and answers come back down.
    return (
      <div className={cls} style={place} data-testid={`edge-${edge.id}`}>
        <span className="csl-edge__vstack">
          <Triangle dir="up" color={head} />
          <Shaft edge={edge} vertical kind={kind} />
          <Triangle dir="down" color={head} />
        </span>
        <span className="csl-edge__vtext">
          <span className="csl-edge__label">{edge.label}</span>
          <Detail edge={edge} />
          {kind === 'failing' && <FailPill edge={edge} />}
        </span>
      </div>
    );
  }
  return (
    <div className={cls} style={place} data-testid={`edge-${edge.id}`}>
      <span className="csl-edge__label">{edge.label}</span>
      <span className="csl-edge__shaft-row">
        <Shaft edge={edge} vertical={false} kind={kind} />
        <Triangle dir="right" color={head} />
        {kind === 'failing' && <FailPill edge={edge} />}
      </span>
      <Detail edge={edge} />
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
  /** Smaller boxes and arrows, for side-by-side layouts. */
  compact?: boolean;
}

/** System diagram: tiers as selectable cards on a 7×3 grid, flows as arrows between them. */
export function TopologyDiagram({ nodes, edges, selectedId, onSelect, note, editable = false, actions, compact = false }: TopologyDiagramProps) {
  return (
    <div>
      <div className="csl-topology-scroll">
        <div className={`csl-topology-grid${compact ? ' csl-topology-grid--compact' : ''}`}>
          {nodes.map((n) => (
            <Node key={n.id} node={n} selected={n.id === selectedId} onSelect={onSelect} editable={editable} />
          ))}
          {edges.map((e) => (
            <Edge key={e.id} edge={e} />
          ))}
        </div>
      </div>
      <div className="csl-topology-key">
        <span className="csl-topology-key__item csl-topology-key__legend">
          <span className="csl-key-arrow" aria-hidden="true" />
          Arrow thickness = requests/s; dashes move faster with more traffic.
        </span>
        <span className="csl-topology-key__item csl-topology-key__legend">
          <span className="csl-key-arrow csl-key-arrow--retry" aria-hidden="true" />
          Orange band ↻ = retries.
        </span>
        <span className="csl-topology-key__item csl-topology-key__legend">
          <span className="csl-key-fail" aria-hidden="true">
            ✕
          </span>
          Red = failing (boxes: over 5% errors).
        </span>
        <span className="csl-topology-key__item csl-topology-key__legend">
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
