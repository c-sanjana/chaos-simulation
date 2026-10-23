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
}

export interface MapCellView {
  x: number;
  y: number;
  status: 'recovered' | 'stuck' | 'pending';
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
}

