import type { CallPolicy, Fault, TierConfig } from '../engine/config';

/** A system to simulate, plus how to draw it. Plain data. */
export interface TopologyPreset {
  id: string;
  name: string;
  /** How users call the entry tier. */
  clientCall: CallPolicy;
  tiers: TierConfig[];
  /** Grid placement and labels for the topology diagram, by tier id. */
  layout: Record<string, { label: string; col: number; row: number }>;
}

/** A parameter a scenario's tipping-point map can vary. */
export type SweepParam = 'rps' | 'retries' | 'outageMs';

export interface Axis {
  param: SweepParam;
  label: string;
  values: number[];
}

/** A failure to inject into a topology, and how to explore it. Plain data. */
export interface ScenarioPreset {
  id: string;
  title: string;
  blurb: string;
  topology: string;
  rps: number;
  durationMs: number;
  /** Retries per layer for every call policy except cache lookups. */
  retries: number;
  faults: Fault[];
  /** Tipping-point map axes: x is always traffic. */
  map: { x: Axis; y: Axis };
}
