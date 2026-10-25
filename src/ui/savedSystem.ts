import { buildRunConfig } from '../data/buildConfig';
import type { BuilderGraph } from '../builder/graph';
import { KIND_LABELS } from '../builder/graph';
import { validateGraph } from '../builder/validate';
import { validateConfig } from '../engine/validate';
import { draftProblems, type Draft } from './draft';
import { inGrid } from '../builder/edit';
import { customSystem, PRESET_SYSTEM, resolveScenarioId, systemDraft, withTrafficAxis, type System } from './system';

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
  /** What of the save had to be left out (damaged, or from another version), in plain words; absent when nothing was. */
  notice?: string;
}

const KINDS = new Set(Object.keys(KIND_LABELS));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
/** A number JSON can hold (never NaN or infinite). */
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numberOrNull = (v: unknown) => v === null || isNumber(v);
const hasNumbers = (o: Record<string, unknown>, keys: string[]) => keys.every((k) => isNumber(o[k]));

/** Whether `s` holds every setting its kind needs, each of the right type (ranges are `validateGraph`'s job). */
function isSettings(s: unknown): boolean {
  if (!isObject(s) || !KINDS.has(s.kind as string)) return false;
  if (s.kind === 'client') return isNumber(s.rps);
  if (!isObject(s.service) || !hasNumbers(s.service, ['medianMs', 'p99Ms'])) return false;
  if (s.kind === 'queue') return hasNumbers(s, ['maxDepth', 'consumers']);
  if (!hasNumbers(s, ['instances', 'workersPerInstance', 'coresPerInstance'])) return false;
  if (s.kind === 'cache') return hasNumbers(s, ['capacity', 'keys', 'skew']) && numberOrNull(s.ttlMs);
  return numberOrNull(s.queueLimit) && typeof s.dropExpired === 'boolean' && (s.fanOut === undefined || typeof s.fanOut === 'string');
}

/** Whether `c` holds every call setting, each of the right type. */
function isCall(c: unknown): boolean {
  return isObject(c) && numberOrNull(c.timeoutMs) && isNumber(c.retries) && isNumber(c.backoffBaseMs) && typeof c.jitter === 'boolean' && (c.share === undefined || isNumber(c.share));
}

const unique = (ids: string[]) => new Set(ids).size === ids.length;

/**
 * Whether a value is a builder graph the page can show: every field the canvas, the descriptions
 * and the compiler read is there with the right type, every box is on the canvas's grid, and ids
 * are unique. Not whether it can run: `validateGraph` says that (and names what to fix).
 * ASSUMPTION: anything else is a damaged or hand-edited save (or one from a future version). It is
 * left out rather than repaired: guessing a missing setting could simulate something never drawn.
 */
export function isGraph(g: unknown): g is BuilderGraph {
  if (!isObject(g) || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return false;
  const nodes: unknown[] = g.nodes;
  const edges: unknown[] = g.edges;
  const nodesOk = nodes.every((n) => isObject(n) && typeof n.id === 'string' && typeof n.label === 'string' && inGrid(n.col as number, n.row as number) && isSettings(n.settings));
  const edgesOk = edges.every((e) => isObject(e) && typeof e.id === 'string' && typeof e.from === 'string' && typeof e.to === 'string' && isCall(e.call));
  const graph = g as unknown as BuilderGraph;
  return nodesOk && edgesOk && unique(graph.nodes.map((n) => n.id)) && unique(graph.edges.map((e) => e.id));
}

/**
 * The graph without arrows to or from parts that aren't in it. The canvas never makes these, and
 * they can't be selected (nothing draws them), so a damaged save's would be problems nobody can
 * fix short of removing the part they belong to.
 */
function withoutLooseArrows(g: BuilderGraph): BuilderGraph {
  const ids = new Set(g.nodes.map((n) => n.id));
  return g.edges.every((e) => ids.has(e.from) && ids.has(e.to)) ? g : { ...g, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

/**
 * A drawing saved before the example's "Gateway" was renamed "Load balancer" (user decision,
 * 2026-10-25: one name everywhere) says "Gateway" on its load balancer: it is renamed as it loads.
 * A name the viewer typed is kept.
 */
function withTodaysNames(g: BuilderGraph): BuilderGraph {
  if (!g.nodes.some((n) => n.label === 'Gateway' && n.settings.kind === 'loadBalancer')) return g;
  const taken = new Set(g.nodes.map((n) => n.label));
  return { ...g, nodes: g.nodes.map((n) => (n.label === 'Gateway' && n.settings.kind === 'loadBalancer' && !taken.has('Load balancer') ? { ...n, label: 'Load balancer' } : n)) };
}

/** A saved drawing as today's page draws it. */
const upgraded = (g: BuilderGraph) => withTodaysNames(withoutLooseArrows(g));

/**
 * A saved built system, compiled again, or null when it can't run: its drawing has problems, or
 * (a safety net, should the two ever disagree) the engine refuses its first scenario.
 */
function restoreSystem(saved: unknown): Extract<System, { kind: 'custom' }> | null {
  if (!isGraph(saved)) return null;
  const g = upgraded(saved);
  if (validateGraph(g).length > 0) return null;
  try {
    const system = customSystem(g) as Extract<System, { kind: 'custom' }>;
    validateConfig(buildRunConfig(system.topology, system.scenarios[0]));
    return system;
  } catch {
    return null;
  }
}

/** The notice when part of a save is left out, or undefined when nothing was. */
function leftOut(system: boolean, canvas: boolean): string | undefined {
  if (!system && !canvas) return undefined;
  const what = system && canvas ? 'Your saved system and drawing' : system ? 'Your saved system' : 'Your saved drawing';
  return `${what} couldn't be restored (the save is damaged or from another version of this page), so ${system ? 'the example system is shown' : 'it was left out'}.`;
}

/** The save as stored, or null when it isn't one (damaged). */
function parse(raw: string): Partial<Saved> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isObject(value) ? (value as Partial<Saved>) : null;
  } catch {
    return null;
  }
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

/**
 * The saved state, or null when nothing is saved (or storage can't be read). Whatever of the save
 * can't be used is left out, and `notice` says so; the next save replaces it.
 * A drawing is reopened even with problems (the builder lists them); a built system only when it
 * can run.
 */
export function loadSaved(storage?: SystemStorage): Restored | null {
  let raw: string | null;
  try {
    raw = orLocal(storage).getItem(SAVED_SYSTEM_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  // An unreadable save counts as a system that could not be restored (so the notice says so).
  const saved = parse(raw) ?? { system: {} as BuilderGraph };
  const built = saved.system == null ? null : restoreSystem(saved.system);
  const system: System = built ?? PRESET_SYSTEM;
  // Every system starts on its default failure, the database slowing down where there is one (user
  // decision, 2026-10-25: a remembered "load balancer slows down" greeted returning visitors). A
  // built system keeps the settings edits and traffic simulated on it; its names always come from
  // the drawing as loaded (a save from before a rename carried the old ones in its copy).
  const scenarioId = resolveScenarioId(system, '');
  const fresh = systemDraft(system, scenarioId);
  const kept = fits(saved.applied ?? null, system) ? saved.applied! : null;
  const applied = kept === null ? fresh : restoredDraft(fresh, kept);
  const canvas = isGraph(saved.canvas) ? upgraded(saved.canvas) : null;
  const notice = leftOut(saved.system != null && built === null, saved.canvas != null && canvas === null);
  return { system, scenarioId, applied, canvas, canvasOpen: canvas !== null && saved.canvasOpen === true, ...(notice ? { notice } : {}) };
}

/**
 * The default draft with the settings edits and traffic of a saved one; the default itself when
 * nothing was edited, so the summary doesn't say "(edited)" (the app compares drafts as JSON, in
 * systemDraft's key order).
 */
function restoredDraft(fresh: Draft, kept: Draft): Draft {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const edited = !same(kept.topology.tiers, fresh.topology.tiers) || !same(kept.topology.clientCall, fresh.topology.clientCall);
  const topology = edited ? { ...fresh.topology, tiers: kept.topology.tiers, clientCall: kept.topology.clientCall } : fresh.topology;
  const scenario = kept.scenario.rps === fresh.scenario.rps ? fresh.scenario : { ...fresh.scenario, rps: kept.scenario.rps };
  return withTrafficAxis({ scenario, topology });
}

/** Forgets the saved state ("Start again" after the page broke: the save might be what broke it). */
export function forgetSaved(storage?: SystemStorage): void {
  try {
    orLocal(storage).removeItem(SAVED_SYSTEM_KEY);
  } catch {
    // Storage is blocked: nothing was remembered.
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
