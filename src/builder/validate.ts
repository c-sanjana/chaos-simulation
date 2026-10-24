import { aKind, canConnect, KIND_LABELS, KIND_NOUNS, type BuilderGraph, type BuilderNode } from './graph';

/** A part as the messages name it: its name, or its kind when the name is blank. */
const nameOf = (n: BuilderNode) => n.label.trim() || KIND_LABELS[n.settings.kind];

/**
 * What stops a drawn topology from being simulated, in plain words (empty = it can run).
 *
 * The first version supports chains (user decision, 2026-10-24): users → one component → the next…,
 * each component calling at most one next component, plus one cache for an app server. Branching (a
 * server calling several components, a load balancer splitting over several pools) comes next.
 */
export function validateGraph(graph: BuilderGraph): string[] {
  const problems: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const name = nameOf;
  const clients = graph.nodes.filter((n) => n.settings.kind === 'client');
  if (clients.length === 0) return ['Add a Client: it stands for the users sending requests.'];
  if (clients.length > 1) problems.push('Use one Client: it stands for all your users.');

  // Calls that aren't allowed at all (the canvas refuses them; a loaded graph might not).
  for (const e of graph.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) problems.push('A connection points at a component that no longer exists.');
    else if (!canConnect(from.settings.kind, to.settings.kind)) problems.push(`${name(from)} can't call ${name(to)}: ${aKind(from.settings.kind)} doesn't call ${aKind(to.settings.kind)}. Select that arrow and press Remove this call.`);
  }

  for (const n of graph.nodes) {
    const out = graph.edges.filter((e) => e.from === n.id).map((e) => byId.get(e.to)).filter((t): t is BuilderNode => t !== undefined);
    const caches = out.filter((t) => t.settings.kind === 'cache');
    const calls = out.filter((t) => t.settings.kind !== 'cache');
    if (calls.length > 1) {
      problems.push(
        `${name(n)} calls ${calls.map(name).join(' and ')}, but for now each part calls one next part (plus a cache). Remove ${calls.length === 2 ? 'one of these calls' : `all but one of these calls`}: select its arrow and press Remove this call.`,
      );
    }
    if (caches.length > 1) problems.push(`${name(n)} uses ${caches.length} caches; use one. Select the arrow to each extra cache and press Remove this call.`);
    if (caches.length > 0 && calls.length === 0) problems.push(`${name(n)} has a cache but nothing to ask when the cache doesn't have the answer: connect it to a database or another component.`);
    const kind = n.settings.kind;
    if (kind === 'client' && out.length === 0) problems.push('Connect the Client to the component users call first.');
    if (kind === 'queue' && calls.length === 0) problems.push(`${name(n)} holds work, but nothing does it: connect it to the component its consumers call.`);
    if (kind === 'loadBalancer' && calls.length === 0) problems.push(`${name(n)} spreads requests, but over nothing: connect it to the servers behind it.`);
    problems.push(...settingsProblems(n));
  }

  const cycle = findCycle(graph);
  if (cycle) problems.push(
      `These call each other in a loop: ${cycle.map((id) => (byId.has(id) ? name(byId.get(id)!) : id)).join(' → ')}. A request would go round forever: remove one of these calls.`,
    );

  // Names are how the story, the timeline and the charts refer to each part.
  const names = new Map<string, number>();
  for (const n of graph.nodes) {
    const key = n.label.trim().toLowerCase();
    if (key === '') problems.push(`Give the ${KIND_NOUNS[n.settings.kind]} a name: select it and type one in Name.`);
    else names.set(key, (names.get(key) ?? 0) + 1);
  }
  for (const n of graph.nodes) {
    if ((names.get(n.label.trim().toLowerCase()) ?? 0) > 1) problems.push(`Two parts are called "${n.label.trim()}": give each its own name (select one and change its Name).`);
  }

  const reached = reachable(graph, clients[0].id);
  for (const n of graph.nodes) if (!reached.has(n.id)) problems.push(`${name(n)} isn't reached from the Client: connect it or remove it.`);
  return [...new Set(problems)];
}

/** Settings that can't be simulated (the forms prevent most of these; a loaded graph might not). */
function settingsProblems(n: BuilderNode): string[] {
  const s = n.settings;
  const bad: string[] = [];
  const who = nameOf(n);
  const whole = (v: number, what: string) => {
    if (!(Number.isInteger(v) && v > 0)) bad.push(`${who}: ${what} must be a whole number above 0.`);
  };
  if (s.kind === 'client') {
    if (!(s.rps > 0)) bad.push(`${who}: traffic must be above 0 requests a second.`);
    return bad;
  }
  if (!(s.service.medianMs > 0)) bad.push(`${who}: the typical (median) time must be above 0.`);
  else if (!(s.service.p99Ms > s.service.medianMs)) bad.push(`${who}: the slowest 1% (p99) must take longer than the typical (median) request. Raise "Slowest 1% take" above ${s.service.medianMs} ms.`);
  if (s.kind === 'queue') {
    whole(s.maxDepth, 'the number of messages it holds');
    whole(s.consumers, 'consumers');
    return bad;
  }
  whole(s.instances, 'copies');
  whole(s.workersPerInstance, 'workers per copy');
  whole(s.coresPerInstance, 'CPU cores per copy');
  if (s.kind === 'cache') {
    whole(s.capacity, 'the number of keys it holds');
    whole(s.keys, 'the number of distinct keys');
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
