import { buildRunConfig } from '../data/buildConfig';
import type { BuilderGraph } from '../builder/graph';
import { KIND_LABELS } from '../builder/graph';
import { validateGraph } from '../builder/validate';
import { validateConfig } from '../engine/validate';
import { draftProblems, type Draft } from './draft';
import { customSystem, PRESET_SYSTEM, scenarioCatalog, systemDraft, type System } from './system';

/**
 * Remembering a built system in this browser (user decision, 2026-10-24: "save it in that session,
 * remember in the browser"), so a reload doesn't lose it. Bump the version if the saved shape
 * changes; an old or damaged save is ignored, never trusted.
 */
export const SAVED_SYSTEM_KEY = 'csl-built-system-v1';

type SystemStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Reading `window.localStorage` can itself throw, so this is only called inside try blocks. */
const orLocal = (storage?: SystemStorage): SystemStorage => storage ?? window.localStorage;

/** What is saved: plain data only (a built system is compiled again on load). */
interface Saved {
  /** The built system's graph, as last used; null while the example is in use. */
  system: BuilderGraph | null;
  scenarioId: string;
  /** What is simulated on the built system (failure, traffic, settings edits); null for the example. */
  applied: Draft | null;
  /** The drawing on the canvas, open or kept after Cancel; null when there is none. */
  canvas: BuilderGraph | null;
  canvasOpen: boolean;
}

/** The app's state as restored from a save. */
export interface Restored {
  system: System;
  scenarioId: string;
  applied: Draft;
  /** The drawing to reopen in the builder, and whether it was open. */
  canvas: BuilderGraph | null;
  canvasOpen: boolean;
}

const KINDS = new Set(Object.keys(KIND_LABELS));

/** Whether a value has the shape of a builder graph (not whether it can run: `validateGraph` says that). */
export function isGraph(g: unknown): g is BuilderGraph {
  if (typeof g !== 'object' || g === null) return false;
  const { nodes, edges } = g as BuilderGraph;
  return (
    Array.isArray(nodes) &&
    Array.isArray(edges) &&
    nodes.every((n) => typeof n?.id === 'string' && typeof n.label === 'string' && Number.isInteger(n.col) && Number.isInteger(n.row) && KINDS.has(n.settings?.kind)) &&
    edges.every((e) => typeof e?.id === 'string' && typeof e.from === 'string' && typeof e.to === 'string' && typeof e.call === 'object' && e.call !== null)
  );
}

/** A saved draft is used only if it belongs to this system and still makes a valid run. */
function fits(d: Draft | null, system: System): d is Draft {
  if (!d || system.kind !== 'custom') return false;
  const ids = (t: Draft['topology']) => t.tiers.map((x) => x.id).join('|');
  try {
    if (ids(d.topology) !== ids(system.topology) || draftProblems(d).length > 0) return false;
    validateConfig(buildRunConfig(d.topology, d.scenario));
    return true;
  } catch {
    return false;
  }
}

/** The saved state, or null when there is nothing (usable) saved. */
export function loadSaved(storage?: SystemStorage): Restored | null {
  try {
    const raw = orLocal(storage).getItem(SAVED_SYSTEM_KEY);
    if (raw === null) return null;
    const saved = JSON.parse(raw) as Partial<Saved>;
    const system = isGraph(saved.system) && validateGraph(saved.system).length === 0 ? customSystem(saved.system) : PRESET_SYSTEM;
    const known = scenarioCatalog(system).some((s) => s.id === saved.scenarioId);
    const scenarioId = known ? saved.scenarioId! : scenarioCatalog(system)[0].id;
    const applied = fits(saved.applied ?? null, system) ? saved.applied! : systemDraft(system, scenarioId);
    const canvas = isGraph(saved.canvas) ? saved.canvas : null;
    return { system, scenarioId, applied, canvas, canvasOpen: canvas !== null && saved.canvasOpen === true };
  } catch {
    return null;
  }
}

/** Saves the state (a built system with what is simulated on it, the scenario, the drawing). */
export function saveState(state: { system: System; scenarioId: string; applied: Draft; canvas: BuilderGraph | null; canvasOpen: boolean }, storage?: SystemStorage): void {
  const custom = state.system.kind === 'custom';
  const saved: Saved = {
    system: state.system.kind === 'custom' ? state.system.graph : null,
    scenarioId: state.scenarioId,
    applied: custom ? state.applied : null,
    canvas: state.canvas,
    canvasOpen: state.canvasOpen,
  };
  try {
    const s = orLocal(storage);
    // Nothing worth remembering: the example system and no drawing.
    if (!custom && state.canvas === null) s.removeItem(SAVED_SYSTEM_KEY);
    else s.setItem(SAVED_SYSTEM_KEY, JSON.stringify(saved));
  } catch {
    // Not remembered (private browsing, blocked or full storage); the page works as before.
  }
}
