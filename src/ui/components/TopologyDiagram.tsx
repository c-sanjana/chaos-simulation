import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
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
 * - Box badges sit on the box border, one job per corner so they never compete for one spot:
 *   top left "⚡ 8× slower" (purple) = the injected failure, i.e. the root cause; top right
 *   "✕ N% errors" (red) = failing; bottom right "⚠ overloaded" (orange) = more work arriving than
 *   the tier can serve; bottom left "🔧 queue limit 93" (outlined blue) = what an applied fix changed.
 *   When a narrow box has two badges on one edge, the right-hand one drops its word ("✕ 62%",
 *   "⚠"), then its number ("✕"); the root cause never shortens. The key explains the symbols and
 *   the box's accessible name always has the words.
 * - The key under the diagram explains all of this in one line, without relying on motion.
 * - Branches: arrows between boxes on different rows (or past empty cells) are drawn over the grid
 *   with right-angle bends (RoutedLines, measured from the boxes), with the same thickness, retry
 *   band, flow dashes and arrowhead colours as straight ones; their text sits in one arrow cell
 *   (RoutedEdge), on the side of the line away from the bend. See ui/edgeRoutes.ts.
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

/** Users' box counts requests not answered (see unansweredShare); a tier counts failed responses. */
const errorWord = (node: TopologyNodeView) => (node.id === 'client' ? 'not answered' : 'errors');

function isFailing(errorShare: number | undefined): boolean {
  return (errorShare ?? 0) > FAILING_ERROR_SHARE;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The text without a leading badge symbol, so view models may pass "⚡ 8× slower" or "8× slower". */
export function withoutIcon(text: string): string {
  return text.replace(/^(?:⚡|⚠|🔧)\uFE0F?\s*/u, '');
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

function changeWords(change: string | undefined): string {
  return change ? `; changed by the fix: ${withoutIcon(change)}` : '';
}

export function nodeAriaLabel(node: TopologyNodeView): string {
  const count = node.instanceCountLabel ? ` (${node.instanceCountLabel})` : '';
  const fault = node.fault ? `; injected failure: ${withoutIcon(node.fault)}` : '';
  const failing = isFailing(node.errorShare) ? `; failing, ${percent(node.errorShare as number)} ${errorWord(node)}` : '';
  const overloaded = node.overloaded ? '; overloaded: more work is arriving than it can serve' : '';
  return `${node.label}${count}: ${node.lines[0]}, ${node.lines[1]}; ${healthWord(node.health)}${fault}${failing}${overloaded}${changeWords(node.change)}`;
}

/** "🔧 queue limit 93": what an applied fix changed, on a box or under an arrow. Screen readers get it from the accessible name. */
function ChangeTag({ change, className }: { change: string; className: string }) {
  const text = withoutIcon(change);
  return (
    <span className={`csl-change ${className}`} title={`Changed by the fix: ${text}`} aria-hidden="true">
      🔧 {text}
    </span>
  );
}

/**
 * The value, except while the element is focused: then the value it had when focus arrived. A
 * focused box's accessible name would otherwise change (and be re-read) every replay frame.
 */
export function useFrozenWhileFocused(value: string): { value: string; onFocus: () => void; onBlur: () => void } {
  const [frozen, setFrozen] = useState<string | null>(null);
  return { value: frozen ?? value, onFocus: () => setFrozen(value), onBlur: () => setFrozen(null) };
}

/** Labels longer than this, in a long chain, keep their start and end ("Payments…service 12"), so parts stay distinguishable. */
export const LONG_CHAIN_LABEL_MAX = 18;

/** "Payments gateway service 12" → "Payments…service 12": the end usually tells numbered parts apart. */
export function keepEnd(label: string, max = LONG_CHAIN_LABEL_MAX): string {
  if (label.length <= max) return label;
  const head = Math.floor((max - 1) / 2);
  const cut = label.length - (max - 1 - head);
  // Start the end part at a word's beginning when one is a few letters away ("service 12", not
  // "ervice 12" or "y service"): first looking back up to 3 letters, then forward up to 4.
  const wordStart = (p: number) => p > 0 && label[p - 1] === ' ' && label[p] !== ' ';
  const near = [0, 1, 2, 3].map((d) => cut - d).find(wordStart) ?? [1, 2, 3, 4].map((d) => cut + d).find((p) => p < label.length && wordStart(p));
  const start = near ?? cut;
  return `${label.slice(0, head).trimEnd()}…${label.slice(start).trimStart()}`;
}

/**
 * One square per copy, coloured by how busy it is. `short` (dense diagrams): one square and the
 * number of copies ("▪ ×4"), so the title row keeps room for the name (every copy is drawn at the
 * tier's average anyway).
 */
function Instances({ node, short = false }: { node: TopologyNodeView; short?: boolean }) {
  const shown = short ? node.instanceBusy.slice(0, 1) : node.instanceBusy;
  return (
    <span className="csl-node__instances" data-testid={`instances-${node.id}`}>
      {shown.map((busy, i) => (
        <span key={i} className="csl-instance" title={`instance ${i + 1}: ${Math.round(busy * 100)}% of workers busy`} style={{ background: instanceColor(busy) }} />
      ))}
      {short && node.instanceBusy.length > 1 && <span className="csl-node__more">×{node.instanceBusy.length}</span>}
    </span>
  );
}

function Node({ node, selected, onSelect, editable, longChain, dense = false }: { node: TopologyNodeView; selected: boolean; onSelect: (id: string) => void; editable: boolean; longChain: boolean; dense?: boolean }) {
  const failing = isFailing(node.errorShare);
  const name = useFrozenWhileFocused(editable ? `Edit ${node.label} settings. ${nodeAriaLabel(node)}` : nodeAriaLabel(node));
  const cls = `csl-node${node.health === 'bad' ? ' csl-node--bad' : ''}${failing ? ' csl-node--failing' : ''}${node.overloaded ? ' csl-node--overloaded' : ''}`;
  const style = { gridColumn: node.col, gridRow: node.row, '--csl-node-wash': `${errorWash(node.errorShare)}%` } as CSSProperties;
  return (
    <button
      type="button"
      className={cls}
      style={style}
      data-node-id={node.id}
      aria-pressed={editable ? undefined : selected}
      aria-label={name.value}
      title={editable ? `Edit ${node.label} settings` : node.label}
      onFocus={name.onFocus}
      onBlur={name.onBlur}
      onClick={() => onSelect(node.id)}
    >
      {(node.fault || failing) && (
        <span className="csl-node__edge csl-node__edge--top" aria-hidden="true">
          {node.fault && <span className="csl-node__fault">⚡ {withoutIcon(node.fault)}</span>}
          {failing && (
            <span className={`csl-node__badge${node.fault ? ' csl-node__tag--crowded' : ''}`}>
              ✕<span className="csl-node__badge-pct"> {percent(node.errorShare as number)}</span>
              <span className="csl-node__badge-word"> {errorWord(node)}</span>
            </span>
          )}
        </span>
      )}
      {(node.change || node.overloaded) && (
        <span className="csl-node__edge csl-node__edge--bottom" aria-hidden="true">
          {node.change && <ChangeTag change={node.change} className="csl-node__change" />}
          {node.overloaded && (
            <span className={`csl-node__overload${node.change ? ' csl-node__tag--crowded' : ''}`}>
              ⚠<span className="csl-node__badge-word"> overloaded</span>
            </span>
          )}
        </span>
      )}
      <span className="csl-node__head">
        <span className="csl-node__label" title={node.label}>
          {longChain ? keepEnd(node.label) : node.label}
        </span>
        {node.instanceCountLabel && <span className="csl-node__count">{node.instanceCountLabel}</span>}
        {dense && node.instanceBusy.length > 0 && <Instances node={node} short />}
        {editable && (
          <span className="csl-node__edit" aria-hidden="true">
            ✎
          </span>
        )}
      </span>
      {!dense && node.instanceBusy.length > 0 && <Instances node={node} />}
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

/**
 * The boxes an arrow joins, read off the grid the way the arrow is drawn: horizontal arrows point
 * from the box on their left to the box on their right; vertical (cache) arrows go up from the
 * caller below to the box above.
 */
export function edgeEnds(edge: TopologyEdgeView, nodes: TopologyNodeView[]): { from?: TopologyNodeView; to?: TopologyNodeView } {
  if (edge.from !== undefined && edge.to !== undefined) return { from: nodes.find((n) => n.id === edge.from), to: nodes.find((n) => n.id === edge.to) };
  const at = (col: number, row: number) => nodes.find((n) => n.col === col && n.row === row);
  return edge.orientation === 'horizontal'
    ? { from: at(edge.col - 1, edge.row), to: at(edge.col + 1, edge.row) }
    : { from: at(edge.col, edge.row + 1), to: at(edge.col, edge.row - 1) };
}

/** e.g. "API to DB: 264 requests a second, including 191 repeats (retries); 100% failing". */
export function edgeAriaLabel(edge: TopologyEdgeView, nodes: TopologyNodeView[]): string {
  const { from, to } = edgeEnds(edge, nodes);
  const ends = from && to ? `${from.label} to ${to.label}: ` : '';
  const rps = Math.round(edge.rps);
  const rate = edge.cache ? `${plural(rps, 'lookup', 'lookups')} a second, ${edge.detail}` : `${plural(rps, 'request', 'requests')} a second`;
  const retries = Math.round(edge.rps * (edge.retryShare ?? 0));
  const repeats = retries > 0 ? `, including ${plural(retries, 'repeat', 'repeats')} (retries)` : '';
  const failing = isFailing(edge.errorShare) ? `; ${percent(edge.errorShare as number)} failing` : '';
  return `${ends}${rate}${repeats}${failing}${changeWords(edge.change)}`;
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

/**
 * An arrow's caption, longest first, for arrows of shrinking width:
 * "incl. 1015 retries" → ["↻ incl. 1015 retries", "↻ 1015 retries", "↻ 1015"], "no retries" →
 * ["no retries", "↻ 0"]; other captions ("62% fail", "19% hits") have one form.
 */
export function detailForms(detail: string, retrying: boolean): string[] {
  const m = /^incl\. ([\d,]+) retries?$/.exec(detail);
  if (m) return [`↻ ${detail}`, `↻ ${m[1]} retries`, `↻ ${m[1]}`];
  if (detail === 'no retries') return ['no retries', '↻ 0'];
  return [retrying ? `↻ ${detail}` : detail];
}

/** An arrow's rate pill, longest first: "1015 rps" → ["1015 rps", "1015"] (the key says arrows are requests/s). */
export function rateForms(label: string): string[] {
  const short = label.replace(/^([\d,.]+k?) (rps|lookups\/s)$/, '$1');
  return short === label ? [label] : [label, short];
}

/** Estimated px per character and extra px (pill padding and border) of arrow captions, at 12 px. */
const FIT_METRICS = { label: { perChar: 7.3, extra: 18 }, detail: { perChar: 6.2, extra: 2 } } as const;

/** The width bucket (px, rounded up to 10, within 40..200) a text needs; see .csl-fit--min/max* in topology.css. */
export function fitBucket(text: string, kind: keyof typeof FIT_METRICS): number {
  const { perChar, extra } = FIT_METRICS[kind];
  return Math.min(200, Math.max(40, Math.ceil((Array.from(text).length * perChar + extra) / 10) * 10));
}

/**
 * A caption with shorter forms for narrow arrows (horizontal arrows are size containers). Every
 * form is rendered; container queries (topology.css) show each one only from the width it needs
 * up to the width the next longer form needs, so exactly one shows and nothing is cut off
 * mid-word. The shortest form has no lower limit.
 */
function Fitted({ forms, kind }: { forms: string[]; kind: keyof typeof FIT_METRICS }) {
  if (forms.length === 1) return <>{forms[0]}</>;
  const buckets = forms.map((f) => fitBucket(f, kind));
  return (
    <>
      {forms.map((f, i) => {
        const min = i < forms.length - 1 ? ` csl-fit--min${buckets[i]}` : '';
        const max = i > 0 ? ` csl-fit--max${buckets[i - 1]}` : '';
        return (
          <span key={f} className={`csl-fit${min}${max}`}>
            {f}
          </span>
        );
      })}
    </>
  );
}

/** The caption under an arrow; only horizontal arrows (size containers) get the shorter forms. */
function Detail({ edge, fit = true }: { edge: TopologyEdgeView; fit?: boolean }) {
  const retries = (edge.retryShare ?? 0) > 0;
  const forms = detailForms(edge.detail, retries);
  return (
    <span className={`csl-edge__detail${retries ? ' csl-edge__detail--retry' : ''}`} aria-hidden="true">
      {fit ? <Fitted forms={forms} kind="detail" /> : forms[0]}
    </span>
  );
}

/** One arrow. It is a single image to assistive tech, named from its source, target and numbers; its visible text is hidden from it. */
function Edge({ edge, nodes }: { edge: TopologyEdgeView; nodes: TopologyNodeView[] }) {
  const kind = edgeKind(edge);
  const head = kind === 'failing' ? ARROW_FAIL : kind === 'retrying' ? ARROW_RETRY : ARROW_OK;
  const cls = `csl-edge csl-edge--${edge.orientation} csl-edge--${kind}${edge.health === 'bad' ? ' csl-edge--bad' : ''}${edge.rps > 0 ? '' : ' csl-edge--still'}${edge.clearStart ? ' csl-edge--clear-start' : ''}${edge.clearEnd ? ' csl-edge--clear-end' : ''}`;
  const a11y = { role: 'img', 'aria-label': edgeAriaLabel(edge, nodes), 'data-testid': `edge-${edge.id}` };
  const place = { gridColumn: edge.col, gridRow: edge.row };
  const change = edge.change && <ChangeTag change={edge.change} className="csl-edge__change" />;

  if (edge.orientation === 'routed') return <RoutedEdge edge={edge} cls={cls} a11y={a11y} place={place} kind={kind} change={change} />;
  if (edge.orientation === 'vertical') {
    // Double-headed: requests go up to the cache and answers come back down.
    return (
      <div className={cls} style={place} {...a11y}>
        <span className="csl-edge__vstack" aria-hidden="true">
          <Triangle dir="up" color={head} />
          <Shaft edge={edge} vertical kind={kind} />
          <Triangle dir="down" color={head} />
        </span>
        <span className="csl-edge__vtext" aria-hidden="true">
          <span className="csl-edge__label">{edge.label}</span>
          <Detail edge={edge} fit={false} />
          {kind === 'failing' && <FailPill edge={edge} />}
          {change}
        </span>
      </div>
    );
  }
  return (
    <div className={cls} style={place} {...a11y}>
      <span className="csl-edge__label" aria-hidden="true">
        <Fitted forms={rateForms(edge.label)} kind="label" />
      </span>
      <span className="csl-edge__shaft-row" aria-hidden="true">
        <Shaft edge={edge} vertical={false} kind={kind} />
        <Triangle dir="right" color={head} />
        {kind === 'failing' && <FailPill edge={edge} />}
      </span>
      <Detail edge={edge} />
      {change}
    </div>
  );
}

/**
 * A routed arrow's text, in its arrow cell: rate and retries stacked on the side of the line away
 * from its bend (or above and below it, for a long straight line), and the fail pill on the line.
 * The line itself is drawn by RoutedLines. One image to assistive tech, like a straight arrow.
 */
function RoutedEdge({ edge, cls, a11y, place, kind, change }: { edge: TopologyEdgeView; cls: string; a11y: Record<string, string>; place: CSSProperties; kind: EdgeKind; change: ReactNode }) {
  const side = edge.route?.text ?? 'straight';
  const label = (
    <span className="csl-edge__label">
      <Fitted forms={rateForms(edge.label)} kind="label" />
    </span>
  );
  return (
    <div className={`${cls} csl-edge--text-${side}`} style={place} {...a11y}>
      {side === 'straight' ? (
        <>
          <span className="csl-edge__rtext csl-edge__rtext--above" aria-hidden="true">
            {label}
          </span>
          <span className="csl-edge__rtext csl-edge__rtext--below" aria-hidden="true">
            <Detail edge={edge} />
            {change}
          </span>
        </>
      ) : (
        <span className={`csl-edge__rtext csl-edge__rtext--${side}`} aria-hidden="true">
          {label}
          <Detail edge={edge} />
          {change}
        </span>
      )}
      {kind === 'failing' && (
        <span className="csl-edge__rpill" aria-hidden="true">
          <FailPill edge={edge} />
        </span>
      )}
    </div>
  );
}

/** A box's position and size inside the grid, in px. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Gap between a box and the start or tip of an arrow (the straight arrows' cell padding). */
const ARROW_GAP = 6;
/** Arrowhead length (as on straight arrows). */
const HEAD = 10;
/** Where a bend runs: this far after the caller's edge, or before the callee's (leaving room for the arrowhead). */
export const TRUNK_AFTER_SOURCE = ARROW_GAP + 8;
export const TRUNK_BEFORE_TARGET = ARROW_GAP + HEAD + 4;

/**
 * The corners of a routed arrow's line, from the caller's right edge (middle) to the callee's left
 * edge (middle), the arrowhead's tip last. Straight when both are level or the route has no bend.
 */
export function routePoints(route: NonNullable<TopologyEdgeView['route']>, a: Box, b: Box): Array<[number, number]> {
  const x1 = a.x + a.w + ARROW_GAP;
  const y1 = a.y + a.h / 2;
  const x2 = b.x - ARROW_GAP;
  const y2 = b.y + b.h / 2;
  if (route.trunk === 'none' || Math.abs(y1 - y2) < 0.5) return [[x1, y1], [x2, y2]];
  const xt = route.trunk === 'source' ? a.x + a.w + TRUNK_AFTER_SOURCE : b.x - TRUNK_BEFORE_TARGET;
  return [[x1, y1], [xt, y1], [xt, y2], [x2, y2]];
}

/** An SVG path through the points, stopping `HEAD` px short of the last (where the arrowhead starts). */
function shaftPath(points: Array<[number, number]>): string {
  const [x2, y2] = points[points.length - 1];
  const body = points.slice(0, -1).map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`);
  return `${body.join(' ')} L${x2 - HEAD} ${y2}`;
}

/**
 * The boxes' positions in the grid (by node id), measured after layout and again when anything
 * resizes. `layer` is an element placed directly in the grid (its parent is the grid; the grid's
 * own ref is not attached yet when a child's layout effect runs).
 */
function useBoxes(layer: RefObject<Element>, key: string): Record<string, Box> {
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  useLayoutEffect(() => {
    const el = layer.current?.parentElement;
    if (!el) return;
    const measure = () => {
      const next: Record<string, Box> = {};
      el.querySelectorAll<HTMLElement>('[data-node-id]').forEach((n) => {
        next[n.dataset.nodeId!] = { x: n.offsetLeft, y: n.offsetTop, w: n.offsetWidth, h: n.offsetHeight };
      });
      setBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(el);
    el.querySelectorAll('[data-node-id]').forEach((n) => observer?.observe(n));
    return () => observer?.disconnect();
  }, [layer, key]);
  return boxes;
}

/**
 * The lines of routed arrows, drawn over the grid under the boxes and the arrows' text: a shaft as
 * thick as the requests/s (red when failing), an orange dashed band inside it for the retry share,
 * the moving flow dashes, and the arrowhead (orange when retrying, red when failing).
 */
function RoutedLines({ edges, layoutKey }: { edges: TopologyEdgeView[]; layoutKey: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const boxes = useBoxes(svg, layoutKey);
  return (
    <svg ref={svg} className="csl-routes" aria-hidden="true" data-testid="routed-lines">
      {edges.map((edge) => {
        const a = boxes[edge.from ?? ''];
        const b = boxes[edge.to ?? ''];
        if (!a || !b || !edge.route) return null;
        const points = routePoints(edge.route, a, b);
        const d = shaftPath(points);
        const kind = edgeKind(edge);
        const thickness = arrowThickness(edge.rps);
        const duration = flowDurationS(edge.rps);
        const retry = edge.retryShare ?? 0;
        const [x2, y2] = points[points.length - 1];
        const head = kind === 'failing' ? ARROW_FAIL : kind === 'retrying' ? ARROW_RETRY : ARROW_OK;
        return (
          <g key={edge.id} data-testid={`route-${edge.id}`} className={`csl-route csl-route--${kind}`}>
            <path d={d} className="csl-route__shaft" style={{ stroke: kind === 'failing' ? ARROW_FAIL : ARROW_OK, strokeWidth: thickness }} />
            {retry > 0 && <path d={d} className="csl-route__retry" data-testid="route-retry" style={{ strokeWidth: Math.max(1, Math.round(thickness * retry)) }} />}
            {duration !== null && <path d={d} className="csl-route__flow" style={{ strokeWidth: thickness, animationDuration: `${duration}s` }} />}
            <path d={`M${x2 - HEAD} ${y2 - 7} L${x2} ${y2} L${x2 - HEAD} ${y2 + 7} Z`} style={{ fill: head }} />
          </g>
        );
      })}
    </svg>
  );
}

/**
 * The one-line key, followed by the note in the same wrapping row: at ~1000px the key fills one
 * line and the note the next; on narrower layouts the note packs in after the key's last item, so
 * the key costs no extra height. Plain words with small swatches; nothing about motion, so it
 * reads the same with reduced motion. The 🔧 entry only appears when a fix changed something shown.
 */
function Key({ showChange, note }: { showChange: boolean; note?: string }) {
  return (
    <div className="csl-topology-legend">
      <span className="csl-topology-legend__title">Key:</span>
      <span className="csl-topology-legend__item">
        <span className="csl-key-arrow" aria-hidden="true" />
        arrow width = requests/s
      </span>
      <span className="csl-topology-legend__item">
        <span className="csl-key-arrow csl-key-arrow--retry" aria-hidden="true" />
        stripes, ↻ = retries (repeats)
      </span>
      <span className="csl-topology-legend__item">
        <span className="csl-key-fail" aria-hidden="true">
          ✕
        </span>
        red = failing
      </span>
      <span className="csl-topology-legend__item">
        <span className="csl-key-chip csl-key-chip--overload">⚠</span> = overloaded
      </span>
      <span className="csl-topology-legend__item">
        <span className="csl-key-chip csl-key-chip--fault">⚡</span> = injected failure
      </span>
      <span className="csl-topology-legend__item">
        <span className="csl-key-squares" aria-hidden="true">
          <span className="csl-instance" style={{ background: 'var(--csl-instance-calm)' }} />
          <span className="csl-instance" style={{ background: 'var(--csl-instance-hot)' }} />
        </span>
        squares = server copies
      </span>
      {showChange && (
        <span className="csl-topology-legend__item">
          <span className="csl-key-chip csl-key-chip--change">🔧</span> = changed by the fix
        </span>
      )}
      {note && <span className="csl-topology-foot__note">{note}</span>}
    </div>
  );
}

export interface TopologyDiagramProps {
  nodes: TopologyNodeView[];
  edges: TopologyEdgeView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Extra sentence for the key line, e.g. "Snapshot at t = 60 s. Select a box to edit that tier." */
  note?: string;
  /** Clicking a box edits that tier (shows an edit mark and says so to screen readers). */
  editable?: boolean;
  /** Controls shown beside the key line, e.g. an "Edit all settings" button. */
  actions?: ReactNode;
  /** Smaller boxes and arrows, for side-by-side layouts. */
  compact?: boolean;
}

/** Narrowest box in a long chain: below this the diagram scrolls sideways rather than squeezing names to a letter or two. */
export const LONG_CHAIN_BOX_MIN_PX = 76;

/**
 * Columns for a chain longer than the presets' 7: boxes and arrows alternate, sharing the width
 * (the presets keep their tuned 7-column template from the stylesheet). Rows for a branched system
 * (boxes below row 3): boxes as tall as they need, a cache arrow's row as on the presets, a small
 * gap between other rows of boxes (routed lines pass through it), and nothing for empty rows.
 */
export function gridStyle(nodes: TopologyNodeView[], edges: TopologyEdgeView[] = [], compact = false): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (isLongChain(nodes)) {
    const cols = Math.max(0, ...nodes.map((n) => n.col));
    style.gridTemplateColumns = Array.from({ length: cols }, (_, i) => (i % 2 === 0 ? `minmax(${LONG_CHAIN_BOX_MIN_PX}px, 1fr)` : 'minmax(40px, 0.55fr)')).join(' ');
    style.minWidth = 0;
  }
  const rows = Math.max(0, ...nodes.map((n) => n.row));
  if (rows > 3) {
    const boxesOn = (r: number) => nodes.some((n) => n.row === r);
    style.gridTemplateRows = Array.from({ length: rows }, (_, i) => {
      const r = i + 1;
      if (r % 2 === 1) return 'auto';
      if (edges.some((e) => e.orientation === 'vertical' && e.row === r)) return compact ? '40px' : '56px';
      return boxesOn(r - 1) && boxesOn(r + 1) ? (compact ? '4px' : '12px') : '0px';
    }).join(' ');
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

/** How many rows of boxes the diagram has (the presets: 2, a cache row and the chain). */
export function boxRowCount(nodes: Array<{ row: number }>): number {
  return new Set(nodes.map((n) => n.row)).size;
}

/**
 * Three or more rows of boxes (a branched system): boxes get a little shorter (their copy squares
 * move into the title row), so the diagram still fits beside the chart at 1440×900.
 */
export function isDense(nodes: Array<{ row: number }>): boolean {
  return boxRowCount(nodes) >= 3;
}

/** More columns than the presets' 7: a built chain, drawn with smaller, two-line names. */
export function isLongChain(nodes: TopologyNodeView[]): boolean {
  return Math.max(0, ...nodes.map((n) => n.col)) > 7;
}

/** Whether a scroll box has more content to its left / right (re-checked on scroll and resize). */
export function useSideScroll<T extends HTMLElement>(): { ref: RefObject<T>; more: { left: boolean; right: boolean } } {
  const ref = useRef<T>(null);
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, []);
  return { ref, more };
}

/**
 * System diagram: tiers as selectable cards on a grid (7×3 for the presets), flows as arrows
 * between them. When it is wider than the screen (phones) it scrolls sideways inside its frame,
 * with a fade on the side that has more and a one-line hint.
 */
export function TopologyDiagram({ nodes, edges, selectedId, onSelect, note, editable = false, actions, compact = false }: TopologyDiagramProps) {
  const longChain = isLongChain(nodes);
  const dense = isDense(nodes);
  const scroll = useSideScroll<HTMLDivElement>();
  const routed = edges.filter((e) => e.orientation === 'routed');
  // Boxes are re-measured when the layout (or the set of arrows) changes; resizes are observed.
  const layoutKey = `${compact}|${nodes.map((n) => `${n.id}@${n.col},${n.row}`).join(';')}|${routed.map((e) => e.id).join(';')}`;
  const scrolls = scroll.more.left || scroll.more.right;
  return (
    <div>
      {scrolls && (
        <p className="csl-topology-hint">
          Scroll sideways to see every part <span aria-hidden="true">{scroll.more.right ? '→' : '←'}</span>
        </p>
      )}
      <div className={`csl-topology-fade${scroll.more.left ? ' csl-topology-fade--left' : ''}${scroll.more.right ? ' csl-topology-fade--right' : ''}`}>
      <div className="csl-topology-scroll" ref={scroll.ref}>
        <div className={`csl-topology-grid${compact ? ' csl-topology-grid--compact' : ''}${longChain ? ' csl-topology-grid--long' : ''}${dense ? ' csl-topology-grid--dense' : ''}`} style={gridStyle(nodes, edges, compact)}>
          {routed.length > 0 && <RoutedLines edges={routed} layoutKey={layoutKey} />}
          {nodes.map((n) => (
            <Node key={n.id} node={n} selected={n.id === selectedId} onSelect={onSelect} editable={editable} longChain={longChain} dense={dense} />
          ))}
          {edges.map((e) => (
            <Edge key={e.id} edge={e} nodes={nodes} />
          ))}
        </div>
      </div>
      </div>
      <div className={`csl-topology-key csl-topology-foot${actions ? ' csl-topology-foot--actions' : ''}`}>
        <Key showChange={nodes.some((n) => n.change) || edges.some((e) => e.change)} note={note} />
        {actions && <span className="csl-topology-foot__actions">{actions}</span>}
      </div>
    </div>
  );
}
