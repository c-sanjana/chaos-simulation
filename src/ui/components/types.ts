// View-model types for the presentational components in this folder.
// Components take these as props; the page that owns the simulation data builds them.

export type Health = 'ok' | 'bad';

export interface TopologyNodeView {
  id: string;
  label: string;
  col: number;
  row: number;
  instanceCountLabel: string;
  /** one entry per instance; 0..1 share of workers busy */
  instanceBusy: number[];
  lines: [string, string];
  health: Health;
  /** 0..1 share of this tier's responses that failed this second (client: share of user requests). */
  errorShare?: number;
  /** Requests per second arriving (client: sent). */
  rps?: number;
  /** 0..1 share of workers busy (tiers only). */
  busy?: number;
  /** The injected failure, while it is active on this tier, e.g. "⚡ 8× slower". */
  fault?: string;
  /** More work is arriving than this tier can serve right now (shown as an "overloaded" badge, not just colour). */
  overloaded?: boolean;
  /** What the applied fix changed on this tier (compare mode, "after" side), e.g. "queue limit 93". */
  change?: string;
}

export interface TopologyEdgeView {
  id: string;
  /** grid placement of the arrow cell */
  col: number;
  row: number;
  orientation: 'horizontal' | 'vertical';
  label: string;
  detail: string;
  rps: number;
  health: Health;
  /** 0..1 share of the calls on this arrow that were retries this second. */
  retryShare?: number;
  /** 0..1 share of the calls on this arrow that failed this second. */
  errorShare?: number;
  /** This arrow carries cache lookups. */
  cache?: boolean;
  /** What the applied fix changed on this call (compare mode, "after" side), e.g. "retry budget 10%". */
  change?: string;
}

export interface TimeSeries {
  label: string;
  values: number[];
  color: string;
  dashed?: boolean;
  /** draw as a filled area stacked on the previous 'area' series */
  area?: boolean;
}

export interface ChartSpec {
  xsSeconds: number[];
  series: TimeSeries[];
  unit: string;
  yMax?: number;
  failureWindows: Array<[number, number]>;
  /** seconds */
  playheadS?: number;
  ariaLabel: string;
  /** Plot height in px (default CHART_HEIGHT); compact layouts use less. */
  height?: number;
  /** Draw data only up to this time (s), so lines grow as a replay plays. Omit to draw everything. */
  revealS?: number;
}

export interface TimelineEntryView {
  tMs: number;
  endMs?: number;
  text: string;
  kind: 'fault' | 'tip' | 'bad' | 'good' | 'info';
  /** Known only once the run has ended: labelled "end of run" instead of a time. */
  atEnd?: boolean;
}

export interface MapCellView {
  x: number;
  y: number;
  /** 'overloaded': too much traffic even without the failure (not the same as stuck). */
  status: 'recovered' | 'stuck' | 'overloaded' | 'pending';
  recoverySeconds?: number;
  isCurrent: boolean;
}

export interface MapView {
  title: string;
  xLabel: string;
  yLabel: string;
  xValues: number[];
  yValues: number[];
  /** row-major, yValues[0] is the TOP row */
  cells: MapCellView[];
  formatY?: (y: number) => string;
  /** What the ◆ cell (isCurrent) is, for screen readers; default "current settings". */
  markLabel?: string;
}

