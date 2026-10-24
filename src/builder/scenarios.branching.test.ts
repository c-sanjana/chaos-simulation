import { compileGraph } from './compile';
import { defaultCall, defaultSettings, type BuilderGraph } from './graph';
import { builtScenarios, estimateCapacityRps, MAX_PER_KIND, tierCapacityRps } from './scenarios';
import { branchedGraph } from './testGraphs';

const kindsOf = (g: BuilderGraph) => Object.fromEntries(g.nodes.map((n) => [n.id, n.settings.kind]));

describe('scenarios and capacity of a branched system', () => {
  const g = branchedGraph();
  const t = compileGraph(g);
  const tier = (id: string) => t.tiers.find((x) => x.id === id)!;

  it('capacity counts each part by its share of the traffic: Database 1 gets two thirds of it', () => {
    expect(estimateCapacityRps(t)).toBeCloseTo(tierCapacityRps(tier('db1')) * 1.5, 5);
  });

  it('offers each database (busiest first), each cache, the front door and the work behind each queue', () => {
    const list = builtScenarios(t, kindsOf(g), 120);
    expect(list.map((s) => [s.id, s.title, s.faults[0].tier])).toEqual([
      ['custom-db-slow', 'db1 slows down', 'db1'],
      ['custom-db-slow-db2', 'db2 slows down', 'db2'],
      ['custom-cache-restart', 'cache restarts empty', 'cache'],
      ['custom-front-slow', 'lb slows down', 'lb'],
      ['custom-queue-backlog', 'Work behind queue slows down', 'db2'],
    ]);
    // The queue gets a third of the 120 req/s: its consumers must fall to about half of 40 req/s.
    const backlog = list.at(-1)!;
    const db2 = tier('db2');
    const mean = tierCapacityRps({ ...db2, instances: 1, coresPerInstance: 1, workersPerInstance: 1 });
    const perSecond = (16 * mean) / backlog.faults[0].factor!;
    expect(perSecond).toBeGreaterThan(15);
    expect(perSecond).toBeLessThan(25);
  });

  it(`offers at most ${MAX_PER_KIND} databases, the busiest`, () => {
    const many: BuilderGraph = {
      nodes: [
        { id: 'client', label: 'Client', col: 1, row: 3, settings: defaultSettings('client') },
        { id: 'api', label: 'API', col: 3, row: 3, settings: defaultSettings('server') },
        ...[1, 2, 3, 4].map((i) => ({ id: `db${i}`, label: `DB ${i}`, col: 5, row: i, settings: defaultSettings('database') })),
      ],
      edges: [
        { id: 'c', from: 'client', to: 'api', call: defaultCall('client', 'server') },
        ...[1, 2, 3, 4].map((i) => ({ id: `e${i}`, from: 'api', to: `db${i}`, call: defaultCall('server', 'database') })),
      ],
    };
    const ids = builtScenarios(compileGraph(many), kindsOf(many), 100).filter((s) => s.id.startsWith('custom-db-slow')).map((s) => s.faults[0].tier);
    // Every database gets all the traffic (the API calls each in turn); the last ones come first, as in a chain.
    expect(ids).toEqual(['db4', 'db3', 'db2']);
  });
});
