import { compileGraph } from '../builder/compile';
import { graphFromPreset, syncGraph } from '../builder/fromPreset';
import { setShare } from '../builder/edit';
import { defaultCall, defaultSettings, type ComponentKind } from '../builder/graph';
import { chainGraph } from '../builder/testGraphs';
import { scenarios } from '../data/scenarios';
import { webChain } from '../data/topologies';
import { updateCallAt, updateFault, updateScenario, updateTier } from './draft';
import { carryOver, customSystem, editedDraft, exampleGraph, graphForCanvas, PRESET_SYSTEM, resolveScenarioId, scenarioCatalog, systemDraft, withTrafficAxis } from './system';

type Custom = Extract<ReturnType<typeof customSystem>, { kind: 'custom' }>;

describe('system', () => {
  it('the preset system offers the preset scenarios on the example topology', () => {
    expect(scenarioCatalog(PRESET_SYSTEM)).toEqual(Object.values(scenarios));
    const d = systemDraft(PRESET_SYSTEM, 'cache-restart');
    expect(d.scenario.id).toBe('cache-restart');
    expect(d.topology).toEqual(webChain);
    expect(d.topology).not.toBe(webChain); // a copy to edit
    expect(graphForCanvas(PRESET_SYSTEM, 150).nodes.find((n) => n.id === 'client')!.settings).toEqual({ kind: 'client', rps: 150 });
  });

  it('a built system is compiled and offers its own scenarios at the client traffic', () => {
    const graph = chainGraph(['client', 'server', 'database'], 1);
    const system = customSystem(graph);
    expect(system.kind).toBe('custom');
    expect(scenarioCatalog(system).map((s) => s.id)).toEqual(['custom-db-slow:n2', 'custom-cache-restart:c', 'custom-front-slow:n1']);
    const d = systemDraft(system, 'nope'); // unknown → the first
    expect(d.scenario.id).toBe('custom-db-slow:n2');
    // An older save's id names the same failure.
    expect(systemDraft(system, 'custom-front-slow').scenario.id).toBe('custom-front-slow:n1');
    expect(resolveScenarioId(system, 'custom-cache-restart')).toBe('custom-cache-restart:c');
    expect(resolveScenarioId(system, 'nope')).toBe('custom-db-slow:n2');
    expect(d.scenario.rps).toBe(100);
    expect(d.topology).toEqual(compileGraph(graph));
    expect(graphForCanvas(system, 999)).toBe(graph);
  });
});

describe('syncGraph', () => {
  it('takes settings changed elsewhere, keeping what each part is, its name and place', () => {
    const graph = chainGraph(['client', 'server', 'database'], 1);
    const t = compileGraph(graph);
    const edited = {
      ...t,
      tiers: t.tiers.map((x) => (x.id === 'n2' ? { ...x, instances: 3 } : x.id === 'n1' ? { ...x, downstream: { ...x.downstream!, retries: 4 } } : x)),
    };
    const synced = syncGraph({ ...graph, nodes: [...graph.nodes, { id: 'loose', label: 'loose', col: 9, row: 5, settings: { kind: 'client', rps: 1 } }] }, edited, 250);
    const db = synced.nodes.find((n) => n.id === 'n2')!;
    expect(db).toMatchObject({ label: 'database 2', col: 5, row: 3, settings: { kind: 'database', instances: 3 } });
    expect(synced.nodes.find((n) => n.id === 'n1')!.settings.kind).toBe('server'); // the preset reader would call the first tier a load balancer
    expect(synced.nodes.find((n) => n.id === 'n0')!.settings).toEqual({ kind: 'client', rps: 250 });
    expect(synced.edges.find((e) => e.from === 'n1' && e.to === 'n2')!.call.retries).toBe(4);
    expect(synced.nodes.find((n) => n.id === 'loose')!.settings).toEqual({ kind: 'client', rps: 1 }); // not in the topology: untouched
    expect(compileGraph(synced).tiers).toEqual(edited.tiers);
  });

  it('reads a preset as drawn: the first tier is a load balancer, leaves are databases', () => {
    const g = graphFromPreset(webChain, 200);
    expect(Object.fromEntries(g.nodes.map((n) => [n.id, n.settings.kind]))).toEqual({ client: 'client', gateway: 'loadBalancer', api: 'server', cache: 'cache', db: 'database' });
  });
});

describe('carrying a failure over to a new built system', () => {
  const example = customSystem(exampleGraph()) as Custom; // the example's part ids: gateway, api, cache, db

  it('keeps the failure (and its title once changed) when its parts are still there; traffic comes from the canvas', () => {
    const applied = updateScenario(updateFault(systemDraft(PRESET_SYSTEM, 'retry-storm'), { factor: 4 }), { durationMs: 150_000 });
    const kept = carryOver(applied, 'retry-storm', example);
    expect(kept.reset).toBeUndefined();
    expect(kept.scenarioId).toBe('custom-db-slow:db');
    expect(kept.draft.scenario).toMatchObject({ title: 'Retry storm', faults: applied.scenario.faults, durationMs: 150_000, rps: 200, topology: 'custom' });
    expect(kept.draft.scenario.map.y).toEqual(applied.scenario.map.y);
    expect(kept.draft.scenario.map.x).toEqual(example.scenarios[0].map.x);
    expect(kept.draft.topology).toEqual(example.topology);
    // The scenario exactly as offered keeps its own words.
    const offered = systemDraft(example, 'custom-cache-restart');
    expect(carryOver(offered, 'custom-cache-restart', example).draft.scenario.title).toBe('Cache restarts empty');
  });

  it('resets it, saying why, when a part is gone or can no longer fail that way', () => {
    const chain = customSystem(chainGraph(['client', 'server', 'database'], 1)) as Custom; // n1 server, c cache, n2 database
    const gone = carryOver(systemDraft(PRESET_SYSTEM, 'retry-storm'), 'retry-storm', chain);
    expect(gone.reset).toBe('The failure was reset to "database 2 slows down": the example\'s DB, where it happened, is not in your system.');
    expect(gone.draft).toEqual(systemDraft(chain, 'custom-db-slow'));
    // "Restarts empty" on a part that is no longer a cache.
    const restart = { ...systemDraft(chain, 'custom-cache-restart') };
    restart.scenario = { ...restart.scenario, faults: [{ ...restart.scenario.faults[0], tier: 'n2' }] };
    expect(carryOver(restart, 'custom-cache-restart', chain).reset).toMatch(/database 2 is no longer a cache, so it can't restart empty\.$/);
    // "One copy goes down" where there is only one copy now, or fewer than before.
    const one = updateFault(systemDraft(chain, 'custom-db-slow'), { kind: 'dead', instance: 0 });
    expect(carryOver(one, 'custom-db-slow', chain).reset).toMatch(/database 2 has only one copy now, so losing one would take it down completely\.$/);
    const fewer = updateFault(systemDraft(chain, ''), { tier: 'n1', kind: 'dead', instance: 5 });
    expect(carryOver(fewer, '', chain).reset).toMatch(/server 1 has only 4 copies now\.$/);
  });
});

describe('a built system as it is now', () => {
  const system = customSystem(chainGraph(['client', 'server', 'database'], 1)) as Custom;

  it('another failure keeps the settings edits and traffic, with scenarios sized for them', () => {
    const edited = updateScenario(updateTier(systemDraft(system, 'custom-db-slow'), 'n1', (t) => ({ ...t, instances: 9 })), { rps: 300 });
    const next = editedDraft(system, 'custom-front-slow:n1', edited);
    expect(next.scenario.id).toBe('custom-front-slow:n1');
    expect(next.scenario.rps).toBe(300);
    expect(next.topology.tiers.find((t) => t.id === 'n1')!.instances).toBe(9);
    expect(next.scenario.map.x.values).toContain(300);
  });

  it('a re-run with new traffic moves the map to it; a preset map stays as it is', () => {
    const d = updateScenario(systemDraft(system, 'custom-db-slow'), { rps: 1000 });
    expect(d.scenario.map.x.values).not.toContain(1000);
    expect(withTrafficAxis(d).scenario.map.x.values).toContain(1000);
    const same = systemDraft(system, 'custom-db-slow');
    expect(withTrafficAxis(same)).toBe(same);
    const preset = updateScenario(systemDraft(PRESET_SYSTEM, 'retry-storm'), { rps: 1000 });
    expect(withTrafficAxis(preset)).toBe(preset);
  });
});

describe('scenario ids name their part, so changed shares never swap the failure (code review 3, finding 1)', () => {
  // Client → LB → S1 → DB1 and → S2 → DB2; S1 gets 70% of the traffic, so DB1 is the busiest.
  const node = (id: string, kind: ComponentKind, col: number, row: number) => ({ id, label: id.toUpperCase(), col, row, settings: defaultSettings(kind) });
  const nodes = [node('client', 'client', 1, 3), node('lb', 'loadBalancer', 3, 3), node('s1', 'server', 5, 1), node('s2', 'server', 5, 5), node('db1', 'database', 7, 1), node('db2', 'database', 7, 5)];
  const kind = (id: string) => nodes.find((n) => n.id === id)!.settings.kind;
  const edge = (from: string, to: string) => ({ id: `${from}--${to}`, from, to, call: defaultCall(kind(from), kind(to)) });
  const graph = setShare({ nodes, edges: [edge('client', 'lb'), edge('lb', 's1'), edge('lb', 's2'), edge('s1', 'db1'), edge('s2', 'db2')] }, 'lb--s1', 70);
  const built = customSystem(graph) as Custom;
  const faultsOn = (d: { scenario: { faults: Array<{ tier: string }> } }) => d.scenario.faults.map((f) => f.tier);

  it('the picker after the shares changed in the drawer: "DB1 slows down" runs on DB1', () => {
    const offered = built.scenarios.find((s) => s.title === 'DB1 slows down')!;
    expect(offered.id).toBe('custom-db-slow:db1');
    // The drawer now sends most traffic to S2 (DB2 becomes the busiest), then DB1's failure is picked.
    const drawer = updateTier(systemDraft(built, offered.id), 'lb', (t) => updateCallAt(updateCallAt(t, 0, { share: 0.3 }), 1, { share: 0.7 }));
    const picked = editedDraft(built, offered.id, drawer);
    expect(picked.scenario.title).toBe('DB1 slows down');
    expect(faultsOn(picked)).toEqual(['db1']);
    expect(picked.topology.tiers.find((t) => t.id === 'lb')!.downstream!.share).toBe(0.3);
  });

  it('"Use this topology" after the shares changed on the canvas: the failure stays filed under its own part, and Reset keeps it there', () => {
    const applied = systemDraft(built, 'custom-db-slow:db1');
    const next = customSystem(setShare(graph, 'lb--s1', 30)) as Custom;
    expect(next.scenarios[0].id).toBe('custom-db-slow:db2'); // DB2 is the busiest now…
    const kept = carryOver(applied, 'custom-db-slow:db1', next);
    expect(kept.reset).toBeUndefined();
    expect(kept.scenarioId).toBe('custom-db-slow:db1'); // …but the failure is still DB1's
    expect(kept.draft.scenario.title).toBe('DB1 slows down');
    expect(faultsOn(kept.draft)).toEqual(['db1']);
    // "Reset to how you built it" gives the same failure, so the summary doesn't say "(edited)".
    expect(faultsOn(systemDraft(next, kept.scenarioId))).toEqual(['db1']);
    expect(JSON.stringify(kept.draft)).toBe(JSON.stringify(systemDraft(next, kept.scenarioId))); // as App compares them
    // An older save's id ("the busiest database") still files the failure under its own part…
    expect(carryOver(applied, 'custom-db-slow', next).scenarioId).toBe('custom-db-slow:db1');
    // …and, when the failure was changed into one no scenario has, under what the old id names.
    const dead = updateFault(applied, { kind: 'dead' });
    expect(carryOver(dead, 'custom-db-slow', next).scenarioId).toBe('custom-db-slow:db2');
    expect(carryOver(dead, 'nope', next).scenarioId).toBe(next.scenarios[0].id);
  });

  it('a failure the changed system no longer offers (only the busiest three of a kind are) still runs on its part', () => {
    // A load balancer over four servers, each with its own database, split 40/30/20/10: DB1–DB3 are offered.
    const ids = [1, 2, 3, 4];
    const parts = ids.flatMap((i) => [node(`s${i}`, 'server', 5, i + 1), node(`db${i}`, 'database', 7, i + 1)]);
    nodes.push(...parts.filter((n) => !nodes.some((m) => m.id === n.id)));
    const four = {
      nodes: [node('client', 'client', 1, 3), node('lb', 'loadBalancer', 3, 3), ...parts],
      edges: [edge('client', 'lb'), ...ids.flatMap((i) => [{ ...edge('lb', `s${i}`), call: { ...defaultCall('loadBalancer', 'server'), share: (5 - i) / 10 } }, edge(`s${i}`, `db${i}`)])],
    };
    const system = customSystem(four) as Custom;
    expect(system.scenarios.filter((x) => x.id.startsWith('custom-db-slow')).map((x) => x.id)).toEqual(['custom-db-slow:db1', 'custom-db-slow:db2', 'custom-db-slow:db3']);
    // The drawer turns the split round (10/20/30/40): DB1 would no longer be offered. Picking it still runs it.
    const turned = updateTier(systemDraft(system, 'custom-db-slow:db1'), 'lb', (t) => ids.reduce((x, i) => updateCallAt(x, i - 1, { share: i / 10 }), t));
    const picked = editedDraft(system, 'custom-db-slow:db1', updateScenario(turned, { rps: 140 }));
    expect(picked.scenario.title).toBe('DB1 slows down');
    expect(faultsOn(picked)).toEqual(['db1']);
    expect(picked.scenario.rps).toBe(140);
    expect(picked.topology.tiers.find((t) => t.id === 'lb')!.downstream!.share).toBe(0.1);
  });
});
