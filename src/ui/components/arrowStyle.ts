import type { TopologyEdgeView } from './types';

/*
 * How an arrow on the run diagram looks, shared by the straight arrows (TopologyDiagram.tsx) and
 * the bent ones (RoutedLines.tsx).
 */

export const ARROW_OK = 'var(--csl-arrow)';
export const ARROW_RETRY = 'var(--csl-retry)';
export const ARROW_FAIL = 'var(--csl-fail)';

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

export function isFailing(errorShare: number | undefined): boolean {
  return (errorShare ?? 0) > FAILING_ERROR_SHARE;
}

export type EdgeKind = 'ok' | 'retrying' | 'failing';

/** Failing wins over retrying; an unhealthy arrow without a failure is mostly retries. */
export function edgeKind(edge: TopologyEdgeView): EdgeKind {
  if (isFailing(edge.errorShare)) return 'failing';
  if (edge.health === 'bad' || (edge.retryShare ?? 0) > RETRYING_SHARE) return 'retrying';
  return 'ok';
}
