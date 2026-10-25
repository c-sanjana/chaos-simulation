import { MAX_RETRIES } from '../engine/config';
import { connectRefusal } from './edit';
import { aKind, KIND_LABELS, type BuilderEdge, type BuilderGraph, type BuilderNode } from './graph';

/** A part as the messages name it: its name, or its kind when the name is blank. */
const nameOf = (n: BuilderNode) => n.label.trim() || KIND_LABELS[n.settings.kind];

/** "a", "a and b", "a, b and c". */
const listed = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** How to make a part call another, in the canvas's words. */
const HOW_TO_CONNECT = "drag from its round handle to that part, or select it and use Calls… and Connect";

/**
 * What stops a drawn topology from being simulated, in plain words (empty = it can run). Each
 * message names the parts involved, says what is wrong and why it matters for the simulation, and
 * gives a fix that works on the canvas.
 *
 * Branching is allowed (user decision, 2026-10-24): a load balancer spreads requests over several
 * parts (each arrow's share of traffic), and an app server may call several parts (one after
 * another, or all at once), plus at most one cache. Several parts may call the same part (two app
 * servers sharing a database). The Client sends to one part, a queue hands its messages to one
 * part, and calls may not go round in a loop.
 */
export function validateGraph(graph: BuilderGraph): string[] {
  const problems: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // Only a damaged save can have these (the canvas gives every part its own id).
  for (const id of new Set(graph.nodes.filter((n, i) => graph.nodes.findIndex((m) => m.id === n.id) < i).map((n) => n.id))) {
    problems.push(`Two parts have the same internal id ("${id}"), so their calls can't be told apart. This only happens when a saved drawing is damaged: press Clear and draw the system again, or Start from the example.`);
  }
  const clients = graph.nodes.filter((n) => n.settings.kind === 'client');
  if (clients.length === 0) {
    return ['There is no Client, so no requests would be sent. Drag a Client from the list above onto the canvas (or press its Add button), then connect it to the part users call first.'];
  }
  if (clients.length > 1) {
    problems.push(
      `There are ${clients.length} Clients (${listed(clients.map(nameOf))}), but one Client stands for all your users, and the traffic is set on it. Keep one: select each of the others and press its Remove button.`,
    );
  }

  // Calls that aren't allowed at all, or that point at a part that is gone (the canvas refuses
  // these; a loaded graph might have them).
  for (const e of graph.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from && !to) problems.push('An arrow joins two parts that are no longer on the canvas, so it cannot be simulated. Press Clear and draw the system again, or Start from the example.');
    else if (!to) problems.push(`${nameOf(from!)} calls a part that is no longer on the canvas, so that call cannot be simulated. Select ${nameOf(from!)}, press its Remove button (its arrows go with it), and add it again.`);
    else if (!from) problems.push(`${nameOf(to)} is called by a part that is no longer on the canvas, so that call cannot be simulated. Select ${nameOf(to)}, press its Remove button (its arrows go with it), and add it again.`);
    else {
      const why = connectRefusal(from.settings.kind, to.settings.kind);
      if (why) problems.push(`${nameOf(from)} can't call ${nameOf(to)}: ${why} Select the arrow from ${nameOf(from)} to ${nameOf(to)} and press Remove this call.`);
      problems.push(...callProblems(e, nameOf(from), nameOf(to)));
    }
  }

  // The same call drawn twice (the canvas refuses it; a loaded graph might not).
  const seen = new Set<string>();
  for (const e of graph.edges) {
    const key = `${e.from}>${e.to}`;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (seen.has(key) && from && to) {
      problems.push(`${nameOf(from)} calls ${nameOf(to)} twice, so it is unclear which timeout and retries to use. Select one of the two arrows from ${nameOf(from)} to ${nameOf(to)} and press Remove this call.`);
    }
    seen.add(key);
  }

  for (const n of graph.nodes) {
    const outEdges = graph.edges.filter((e) => e.from === n.id && byId.has(e.to));
    const out = outEdges.map((e) => byId.get(e.to)!);
    const caches = out.filter((t) => t.settings.kind === 'cache');
    const calls = out.filter((t) => t.settings.kind !== 'cache');
    const kind = n.settings.kind;
    const who = nameOf(n);
    if (kind === 'client' && calls.length > 1) {
      problems.push(
        `${who} sends to ${listed(calls.map(nameOf))}, but the Client stands for users calling one front door, so it calls one part. Keep one of these arrows and remove the others (select an arrow and press Remove this call); to spread users over several parts, put a load balancer between ${who} and them.`,
      );
    }
    if (kind === 'queue' && calls.length > 1) {
      problems.push(
        `${who} hands its messages to ${listed(calls.map(nameOf))}, but a queue's consumers pass each message to exactly one part. Keep one of these arrows and remove the others (select an arrow and press Remove this call); to feed several parts, give each its own queue.`,
      );
    }
    if (caches.length > 1) {
      problems.push(
        `${who} looks things up in ${caches.length} caches (${listed(caches.map(nameOf))}), but an app server checks one cache before asking the next part. Keep one: select the arrow from ${who} to each of the others and press Remove this call.`,
      );
    }
    if (caches.length > 0 && calls.length === 0) {
      problems.push(
        `${who} has a cache but nothing to ask when the cache doesn't have the answer, so those requests could never be answered. Connect ${who} to a database or another part: ${HOW_TO_CONNECT}.`,
      );
    }
    if (kind === 'client' && out.length === 0) {
      problems.push(`${who} calls nothing, so no request would reach your system. Connect it to the part users call first (usually a load balancer): ${HOW_TO_CONNECT}.`);
    }
    if (kind === 'queue' && calls.length === 0) {
      problems.push(`${who} holds work, but nothing does it, so its messages would pile up forever. Connect it to the part its consumers call: ${HOW_TO_CONNECT}.`);
    }
    if (kind === 'loadBalancer' && calls.length === 0) {
      problems.push(`${who} spreads requests, but over nothing, so every request would fail there. Connect it to an app server behind it: ${HOW_TO_CONNECT}.`);
    }
    if (kind === 'loadBalancer' && calls.length > 1) {
      for (const e of outEdges) {
        const share = e.call.share;
        const to = byId.get(e.to)!;
        if (to.settings.kind === 'cache' || share === undefined || (Number.isFinite(share) && share > 0)) continue;
        problems.push(
          share === 0
            ? `${who} sends no traffic to ${nameOf(to)} (its share is 0%), so ${nameOf(to)} would sit idle. Select the arrow from ${who} to ${nameOf(to)} and give it a share of traffic above 0%, or press Remove this call.`
            : `${who}'s share of traffic to ${nameOf(to)} isn't a number above 0, so the split can't be simulated. Select the arrow from ${who} to ${nameOf(to)} and give it a share of traffic above 0%, or press Remove this call.`,
        );
      }
    }
    problems.push(...settingsProblems(n));
  }

  const cycle = findCycle(graph);
  if (cycle) {
    const names = cycle.map((id) => (byId.has(id) ? nameOf(byId.get(id)!) : id));
    problems.push(
      `These call each other in a loop: ${names.join(' → ')}. A request would go round forever and never be answered. Remove one of these calls: for example, select the arrow from ${names[names.length - 2]} to ${names[names.length - 1]} and press Remove this call.`,
    );
  }

  // Names are how the story, the timeline and the charts refer to each part.
  // Names that differ only in case clash too ("Database" and "DATABASE"): one problem per clash, naming each spelling.
  const spellings = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const key = n.label.trim().toLowerCase();
    if (key === '') problems.push(`${aKind(n.settings.kind, true)} has no name, and the story and charts name each part. Select it and type a name in Name.`);
    else spellings.set(key, [...(spellings.get(key) ?? []), n.label.trim()]);
  }
  for (const same of spellings.values()) {
    if (same.length < 2) continue;
    const count = same.length === 2 ? 'Two' : String(same.length);
    problems.push(`${count} parts are called ${listed([...new Set(same)].map((x) => `"${x}"`))}, so the story and charts couldn't tell them apart. Select one and change its Name.`);
  }

  // While the Client calls nothing, every part is unreached: the Client's own problem is the one step to take.
  const reached = reachable(graph, clients[0].id);
  const clientCalls = graph.edges.some((e) => e.from === clients[0].id && byId.has(e.to));
  for (const n of graph.nodes) {
    if (reached.has(n.id) || !clientCalls) continue;
    const who = nameOf(n);
    problems.push(
      `${who} isn't reached from the Client, so no request would ever get to it. Connect a part that is reached to ${who} (drag from that part's round handle to ${who}, or select that part and use Calls… and Connect), or select ${who} and press Remove ${who}.`,
    );
  }
  return [...new Set(problems)];
}

/** A number above 0 (and not infinite). */
const positive = (v: number) => Number.isFinite(v) && v > 0;

/**
 * A call's settings that can't be simulated (the forms prevent these; a loaded graph might not).
 * The same rules (and the engine's own cap on retries, MAX_RETRIES) as the engine's
 * `validateConfig` checks for every call, so a graph without problems always compiles to a config
 * the engine runs.
 */
function callProblems(e: BuilderEdge, from: string, to: string): string[] {
  const c = e.call;
  const bad: string[] = [];
  const fix = `Select the arrow from ${from} to ${to} and change it in its settings.`;
  if (!(c.timeoutMs === null || positive(c.timeoutMs))) bad.push(`The call from ${from} to ${to}: "Timeout" must be above 0 ms (or switched off) to be simulated. ${fix}`);
  if (!(Number.isInteger(c.retries) && c.retries >= 0 && c.retries <= MAX_RETRIES)) {
    bad.push(`The call from ${from} to ${to}: "Retries" must be a whole number from 0 to ${MAX_RETRIES} to be simulated. ${fix}`);
  }
  if (!(Number.isFinite(c.backoffBaseMs) && c.backoffBaseMs >= 0)) bad.push(`The call from ${from} to ${to}: "Wait before retrying" must be 0 ms or more to be simulated. ${fix}`);
  return bad;
}

/**
 * Settings that can't be simulated (the forms prevent these; a loaded graph might not): the same
 * rules as the engine's `validateConfig` checks for a tier.
 */
function settingsProblems(n: BuilderNode): string[] {
  const s = n.settings;
  const bad: string[] = [];
  const who = nameOf(n);
  const fix = `Select ${who} and change it in its settings.`;
  const whole = (v: number, field: string) => {
    if (!(Number.isInteger(v) && v > 0)) bad.push(`${who}: "${field}" must be a whole number above 0 to be simulated. ${fix}`);
  };
  if (s.kind === 'client') {
    if (!positive(s.rps)) bad.push(`${who}: "Requests per second" must be above 0, or no requests would be sent. ${fix}`);
    return bad;
  }
  if (!positive(s.service.medianMs)) bad.push(`${who}: the typical time must be above 0 ms: every request takes some time. ${fix}`);
  else if (!(s.service.p99Ms > s.service.medianMs && Number.isFinite(s.service.p99Ms))) {
    bad.push(`${who}: the slowest 1% of requests must take longer than a typical one, or the times can't be simulated. Select ${who} and raise "Slowest 1% take" above ${s.service.medianMs} ms.`);
  }
  // Only an app server chooses how it calls its parts (a load balancer always splits, and a
  // database calls nothing), so only a server's choice is compiled, and checked.
  if (s.kind === 'server' && s.fanOut !== undefined && s.fanOut !== 'sequence' && s.fanOut !== 'parallel') {
    bad.push(`${who}: it is not set whether it calls its parts one after another or all at once. Select ${who} and choose under "Calls its parts".`);
  }
  if (s.kind === 'queue') {
    whole(s.maxDepth, 'Messages it can hold');
    whole(s.consumers, 'Messages handled at once (consumers)');
    return bad;
  }
  whole(s.instances, 'Copies (instances)');
  whole(s.workersPerInstance, 'Requests each copy handles at once');
  whole(s.coresPerInstance, 'CPU cores per copy');
  if (s.kind === 'cache') {
    whole(s.capacity, 'Keys it can hold');
    whole(s.keys, 'Different keys requested');
    if (!(s.ttlMs === null || positive(s.ttlMs))) bad.push(`${who}: "Expire after" must be above 0 s (or switched off) to be simulated. ${fix}`);
    if (!(Number.isFinite(s.skew) && s.skew >= 0)) bad.push(`${who}: "Popularity skew" must be 0 or more to be simulated. ${fix}`);
  } else if (!(s.queueLimit === null || (Number.isInteger(s.queueLimit) && s.queueLimit >= 0))) {
    bad.push(`${who}: "Requests allowed to wait, per copy" must be a whole number, 0 or more (or the limit switched off), to be simulated. ${fix}`);
  }
  return bad;
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
