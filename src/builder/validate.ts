import { listed } from '../analysis/helpers';
import { MAX_RETRIES } from '../engine/config';
import { connectRefusal } from './edit';
import { aKind, displayName as nameOf, type BuilderEdge, type BuilderGraph, type BuilderNode } from './graph';

/** "A database only answers…" → "a database only answers…", to follow a colon. */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Something that stops a drawing from being simulated: the message, how serious it is, and the
 * boxes and arrows it is about (so the canvas can mark them).
 */
export interface GraphProblem {
  /** One or two short sentences: what is wrong, then what to do. */
  text: string;
  /**
   * 'unfinished': a step still to take (no Client yet, a part with nothing behind it, a part that
   * nothing sends to, a blank name). 'wrong': something drawn or set that can't work (a loop, two
   * Clients, a bad setting). The builder shows the first in amber and the second in red.
   */
  severity: 'unfinished' | 'wrong';
  /** Ids of the boxes it is about. */
  nodes: string[];
  /** Ids of the arrows it is about. */
  edges: string[];
  /** The fix is to draw an arrow: the builder then says once, under the list, how to draw one (mouse and keyboard). */
  drawArrow?: boolean;
}

function problem(severity: GraphProblem['severity'], text: string, nodes: string[] = [], edges: string[] = [], drawArrow = false): GraphProblem {
  return { text, severity, nodes, edges, ...(drawArrow ? { drawArrow } : {}) };
}

/** What stops a drawn topology from being simulated, as messages (empty = it can run). See `findProblems`. */
export function validateGraph(graph: BuilderGraph): string[] {
  return findProblems(graph).map((p) => p.text);
}

/**
 * What stops a drawn topology from being simulated (empty = it can run). Each message leads with
 * what is wrong in a few words, naming parts by their names, then says what to do on the canvas,
 * in one or two short sentences (user feedback, 2026-10-25: the longer messages were hard to
 * follow). How to draw an arrow by keyboard is said once, by the builder, not in every message.
 *
 * Branching is allowed (user decision, 2026-10-24): a load balancer spreads requests over several
 * parts (each arrow's share of traffic), and an app server may call several parts (one after
 * another, or all at once), plus at most one cache. Several parts may call the same part (two app
 * servers sharing a database). The Client sends to one part, a queue hands its messages to one
 * part, and calls may not go round in a loop.
 */
export function findProblems(graph: BuilderGraph): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // A guard: only a damaged save could have these. The canvas gives every part its own id, and
  // saves are loaded through ui/savedSystem's isGraph, which refuses a drawing with repeated ids.
  for (const id of new Set(graph.nodes.filter((n, i) => graph.nodes.findIndex((m) => m.id === n.id) < i).map((n) => n.id))) {
    problems.push(problem('wrong', 'This saved drawing is damaged: two parts are mixed up. Press Clear and draw it again, or start from the example.', [id]));
  }
  const clients = graph.nodes.filter((n) => n.settings.kind === 'client');
  if (clients.length === 0) {
    return [problem('unfinished', 'No Client yet. Add one from the list above: requests start there.')];
  }
  if (clients.length > 1) {
    const others = clients.length === 2 ? 'the other' : 'the others';
    problems.push(problem('wrong', `Too many Clients: ${listed(clients.map(nameOf))}. Keep one and remove ${others}, since one Client stands for all your users.`, clients.map((n) => n.id)));
  }

  // Calls that aren't allowed at all, or that point at a part that is gone (the canvas refuses
  // these). The checks for arrows to a missing part are a guard: saves are loaded through
  // ui/savedSystem's withoutLooseArrows, which drops such arrows.
  for (const e of graph.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from && !to) problems.push(problem('wrong', 'An arrow joins two parts that no longer exist. Press Clear and draw the system again, or start from the example.', [], [e.id]));
    else if (!to) problems.push(problem('wrong', `${nameOf(from!)} has an arrow to a part that no longer exists. Remove ${nameOf(from!)} and add it again.`, [from!.id], [e.id]));
    else if (!from) problems.push(problem('wrong', `${nameOf(to)} has an arrow from a part that no longer exists. Remove ${nameOf(to)} and add it again.`, [to.id], [e.id]));
    else {
      const why = connectRefusal(from.settings.kind, to.settings.kind);
      if (why) problems.push(problem('wrong', `${nameOf(from)} can't send requests to ${nameOf(to)}: ${lowerFirst(why)} Remove that arrow.`, [], [e.id]));
      problems.push(...callProblems(e, nameOf(from), nameOf(to)));
    }
  }

  // The same call drawn twice (the canvas refuses it; a loaded graph might not).
  const first = new Map<string, string>();
  for (const e of graph.edges) {
    const key = `${e.from}>${e.to}`;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    const earlier = first.get(key);
    if (earlier !== undefined && from && to) problems.push(problem('wrong', `There are two arrows from ${nameOf(from)} to ${nameOf(to)}. Remove one of them.`, [], [earlier, e.id]));
    if (earlier === undefined) first.set(key, e.id);
  }

  for (const n of graph.nodes) {
    const outEdges = graph.edges.filter((e) => e.from === n.id && byId.has(e.to));
    const toCache = (e: BuilderEdge) => byId.get(e.to)!.settings.kind === 'cache';
    const cacheEdges = outEdges.filter(toCache);
    const callEdges = outEdges.filter((e) => !toCache(e));
    const caches = cacheEdges.map((e) => byId.get(e.to)!);
    const calls = callEdges.map((e) => byId.get(e.to)!);
    const kind = n.settings.kind;
    const who = nameOf(n);
    if (kind === 'client' && calls.length > 1) {
      problems.push(
        problem('wrong', `${who} sends to ${calls.length} parts: ${listed(calls.map(nameOf))}. A Client sends to one part, so keep one arrow, or put a load balancer in front of them.`, [n.id], callEdges.map((e) => e.id)),
      );
    }
    if (kind === 'queue' && calls.length > 1) {
      problems.push(
        problem('wrong', `${who} passes messages to ${calls.length} parts: ${listed(calls.map(nameOf))}. A queue passes each message to one part, so keep one arrow, or add a queue for each.`, [n.id], callEdges.map((e) => e.id)),
      );
    }
    if (caches.length > 1) {
      problems.push(problem('wrong', `${who} uses ${caches.length} caches: ${listed(caches.map(nameOf))}. An app server can use only one cache, so keep one arrow.`, [n.id], cacheEdges.map((e) => e.id)));
    }
    if (caches.length > 0 && calls.length === 0) {
      problems.push(problem('unfinished', `${who} has a cache but nothing behind it. Draw an arrow from ${who} to a database, for when the cache doesn't have the answer.`, [n.id], [], true));
    }
    // Only the first Client is checked: any other is to be removed (see "Too many Clients"), not connected.
    if (kind === 'client' && n.id === clients[0].id && outEdges.length === 0) {
      problems.push(problem('unfinished', `${who} isn't connected to anything. Draw an arrow from it to the first part users talk to, usually a load balancer.`, [n.id], [], true));
    }
    if (kind === 'queue' && calls.length === 0) {
      problems.push(problem('unfinished', `${who} doesn't pass its messages on. Draw an arrow from it to the part that should work through them.`, [n.id], [], true));
    }
    if (kind === 'loadBalancer' && calls.length === 0) {
      problems.push(problem('unfinished', `${who} has nothing to send requests to. Draw an arrow from it to an app server.`, [n.id], [], true));
    }
    if (kind === 'loadBalancer' && calls.length > 1) {
      for (const e of callEdges) {
        const share = e.call.share;
        if (share === undefined || (Number.isFinite(share) && share > 0)) continue;
        const to = nameOf(byId.get(e.to)!);
        const what = share === 0 ? `${who} sends 0% of its traffic to ${to}.` : `The share of traffic from ${who} to ${to} isn't a number above 0.`;
        problems.push(problem('wrong', `${what} Select that arrow and give it a share above 0%, or remove it.`, [], [e.id]));
      }
    }
    problems.push(...settingsProblems(n));
  }

  const cycle = findCycle(graph);
  if (cycle) {
    const names = cycle.map((id) => (byId.has(id) ? nameOf(byId.get(id)!) : id));
    const loop = cycle.slice(1).flatMap((to, i) => graph.edges.find((e) => e.from === cycle[i] && e.to === to)?.id ?? []);
    problems.push(problem('wrong', `These arrows go round in a loop: ${names.join(' → ')}. Remove one, for example the arrow from ${names[names.length - 2]} to ${names[names.length - 1]}.`, [], loop));
  }

  // Names are how the story, the timeline and the charts refer to each part.
  // Names that differ only in case clash too ("Database" and "DATABASE"): one problem per clash, naming each spelling.
  const spellings = new Map<string, BuilderNode[]>();
  for (const n of graph.nodes) {
    const key = n.label.trim().toLowerCase();
    if (key === '') problems.push(problem('unfinished', `${aKind(n.settings.kind, true)} has no name. Select it and type one in Name.`, [n.id]));
    else spellings.set(key, [...(spellings.get(key) ?? []), n]);
  }
  for (const same of spellings.values()) {
    if (same.length < 2) continue;
    const count = same.length === 2 ? 'Two' : String(same.length);
    const names = [...new Set(same.map((n) => n.label.trim()))];
    const what = names.length === 1 ? `are called "${names[0]}"` : `have the same name: ${listed(names.map((x) => `"${x}"`))}`;
    problems.push(problem('wrong', `${count} parts ${what}. Give each its own name.`, same.map((n) => n.id)));
  }

  // While the Client calls nothing, every part is unreached: the Client's own problem is the one step to take.
  const reached = reachable(graph, clients[0].id);
  const clientCalls = graph.edges.some((e) => e.from === clients[0].id && byId.has(e.to));
  for (const n of graph.nodes) {
    // A second Client can't be drawn to (nothing may send to a Client): "Too many Clients" covers it.
    if (reached.has(n.id) || !clientCalls || n.settings.kind === 'client') continue;
    problems.push(problem('unfinished', `Nothing sends requests to ${nameOf(n)}. Draw an arrow to it from the part before it, or remove it.`, [n.id], [], true));
  }
  return merged(problems);
}

/** One problem per message: the same message twice becomes one, about the parts of both. */
function merged(problems: GraphProblem[]): GraphProblem[] {
  const byText = new Map<string, GraphProblem>();
  for (const p of problems) {
    const had = byText.get(p.text);
    byText.set(p.text, had ? { ...had, nodes: [...new Set([...had.nodes, ...p.nodes])], edges: [...new Set([...had.edges, ...p.edges])] } : p);
  }
  return [...byText.values()];
}

/** A number above 0 (and not infinite). */
const positive = (v: number) => Number.isFinite(v) && v > 0;

/**
 * A call's settings that can't be simulated (the forms prevent these; a loaded graph might not).
 * The same rules (and the engine's own cap on retries, MAX_RETRIES) as the engine's
 * `validateConfig` checks for every call, so a graph without problems always compiles to a config
 * the engine runs.
 */
function callProblems(e: BuilderEdge, from: string, to: string): GraphProblem[] {
  const c = e.call;
  const bad: string[] = [];
  const arrow = `The arrow from ${from} to ${to}`;
  if (!(c.timeoutMs === null || positive(c.timeoutMs))) bad.push(`${arrow} needs a timeout above 0 ms. Select it and change "Timeout", or untick "Give up after a timeout".`);
  if (!(Number.isInteger(c.retries) && c.retries >= 0 && c.retries <= MAX_RETRIES)) {
    bad.push(`${arrow} needs a whole number of retries, from 0 to ${MAX_RETRIES}. Select it and change "Retries".`);
  }
  if (!(Number.isFinite(c.backoffBaseMs) && c.backoffBaseMs >= 0)) bad.push(`${arrow} needs a wait before retrying of 0 ms or more. Select it and change "Wait before retrying".`);
  return bad.map((text) => problem('wrong', text, [], [e.id]));
}

/**
 * Settings that can't be simulated (the forms prevent these; a loaded graph might not): the same
 * rules as the engine's `validateConfig` checks for a tier.
 */
function settingsProblems(n: BuilderNode): GraphProblem[] {
  const s = n.settings;
  const bad: string[] = [];
  const who = nameOf(n);
  const change = `Select ${who} and change it.`;
  const whole = (v: number, field: string) => {
    if (!(Number.isInteger(v) && v > 0)) bad.push(`${who}'s "${field}" must be a whole number above 0. ${change}`);
  };
  const result = () => bad.map((text) => problem('wrong', text, [n.id]));
  if (s.kind === 'client') {
    if (!positive(s.rps)) bad.push(`${who}'s "Requests per second" must be above 0. ${change}`);
    return result();
  }
  if (!positive(s.service.medianMs)) bad.push(`${who}'s typical time must be above 0 ms. ${change}`);
  else if (!(s.service.p99Ms > s.service.medianMs && Number.isFinite(s.service.p99Ms))) {
    bad.push(`${who}'s slowest 1% must take longer than its typical time. Select ${who} and raise "Slowest 1% take" above ${s.service.medianMs} ms.`);
  }
  // Only an app server chooses how it calls its parts (a load balancer always splits, and a
  // database calls nothing), so only a server's choice is compiled, and checked.
  if (s.kind === 'server' && s.fanOut !== undefined && s.fanOut !== 'sequence' && s.fanOut !== 'parallel') {
    bad.push(`${who} doesn't say how it calls its parts. Select ${who} and choose under "Calls its parts".`);
  }
  if (s.kind === 'queue') {
    whole(s.maxDepth, 'Messages it can hold');
    whole(s.consumers, 'Messages handled at once (consumers)');
    return result();
  }
  whole(s.instances, 'Copies (instances)');
  whole(s.workersPerInstance, 'Requests each copy handles at once');
  whole(s.coresPerInstance, 'CPU cores per copy');
  if (s.kind === 'cache') {
    whole(s.capacity, 'Keys it can hold');
    whole(s.keys, 'Different keys requested');
    if (!(s.ttlMs === null || positive(s.ttlMs))) bad.push(`${who}'s "Expire after" must be above 0 s. Select ${who} and change it, or untick "Entries expire".`);
    if (!(Number.isFinite(s.skew) && s.skew >= 0)) bad.push(`${who}'s "Popularity skew" must be 0 or more. ${change}`);
  } else if (!(s.queueLimit === null || (Number.isInteger(s.queueLimit) && s.queueLimit >= 0))) {
    bad.push(`${who}'s "Requests allowed to wait, per copy" must be a whole number, 0 or more. Select ${who} and change it, or untick "Limit the waiting line".`);
  }
  return result();
}

function reachable(graph: BuilderGraph, from: string): Set<string> {
  const seen = new Set([from]);
  const todo = [from];
  while (todo.length) {
    const id = todo.pop()!;
    for (const e of graph.edges) if (e.from === id && !seen.has(e.to)) (seen.add(e.to), todo.push(e.to));
  }
  return seen;
}

/** A loop of calls as node ids (first repeated at the end), or null. */
function findCycle(graph: BuilderGraph): string[] | null {
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    if (state.get(id) === 'done') return null;
    state.set(id, 'open');
    path.push(id);
    for (const e of graph.edges) {
      if (e.from !== id) continue;
      const found = visit(e.to);
      if (found) return found;
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };
  for (const n of graph.nodes) {
    const found = visit(n.id);
    if (found) return found;
  }
  return null;
}
