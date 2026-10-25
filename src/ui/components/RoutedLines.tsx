import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ARROW_FAIL, ARROW_OK, ARROW_RETRY, arrowThickness, edgeKind, flowDurationS } from './arrowStyle';
import type { TopologyEdgeView } from './types';

/*
 * The lines of the run diagram's bent ("routed") arrows, drawn in one SVG over the grid. Their text
 * sits in an arrow cell of the grid (RoutedEdge in TopologyDiagram.tsx); where they run is decided
 * by ui/edgeRoutes.ts.
 *
 * ASSUMPTION: the boxes' offsets and the SVG share one origin, the grid's padding box. That holds
 * because the grid (.csl-topology-grid) is `position: relative` and the boxes (.csl-node) are its
 * children; both rules are in topology.css.
 */

/** A box's position and size inside the grid, in px. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How far the routed arrows' text reaches past the grid's top and bottom, in px (0 when inside). */
export interface Room {
  top: number;
  bottom: number;
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
 * The boxes' positions in the grid (by node id), and how far the routed arrows' text reaches past
 * the grid, measured after layout and again when anything resizes. `layer` is an element placed
 * directly in the grid (its parent is the grid; the grid's own ref is not attached yet when a
 * child's layout effect runs).
 */
function useBoxes(layer: RefObject<Element>, key: string, onRoom?: (room: Room) => void): Record<string, Box> {
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
      // The text of a routed arrow sits beside its line, out of the grid's flow: in the top or
      // bottom row it can reach past the grid, where the scroll frame would cut it off.
      // The scroll frame's own padding already gives some room.
      const grid = el.getBoundingClientRect();
      const frame = el.parentElement ? getComputedStyle(el.parentElement) : null;
      const room = { top: 0, bottom: 0 };
      el.querySelectorAll('.csl-edge__rtext').forEach((t) => {
        const r = t.getBoundingClientRect();
        if (r.height === 0) return;
        room.top = Math.max(room.top, Math.ceil(grid.top - r.top - (parseFloat(frame?.paddingTop ?? '') || 0)));
        room.bottom = Math.max(room.bottom, Math.ceil(r.bottom - grid.bottom - (parseFloat(frame?.paddingBottom ?? '') || 0)));
      });
      onRoom?.(room);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(el);
    el.querySelectorAll('[data-node-id], .csl-edge__rtext').forEach((n) => observer?.observe(n));
    return () => observer?.disconnect();
  }, [layer, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return boxes;
}

/**
 * The lines of routed arrows, drawn over the grid under the boxes and the arrows' text: a shaft as
 * thick as the requests/s (red when failing), an orange dashed band inside it for the retry share,
 * the moving flow dashes, and the arrowhead (orange when retrying, red when failing). `onRoom`
 * hears how far their text reaches past the grid, so the diagram can make room for it.
 */
export function RoutedLines({ edges, layoutKey, onRoom }: { edges: TopologyEdgeView[]; layoutKey: string; onRoom?: (room: Room) => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const boxes = useBoxes(svg, layoutKey, onRoom);
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
