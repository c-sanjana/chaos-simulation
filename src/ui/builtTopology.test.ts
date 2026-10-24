import { chainGraph } from '../builder/testGraphs';
import { buildRunConfig } from '../data/buildConfig';
import { runSimulation } from '../engine/run';
import { gridStyle } from './components/TopologyDiagram';
import { customSystem } from './system';
import { topologyView } from './viewModels';

describe('a built topology on the diagram', { timeout: 60_000 }, () => {
  const system = customSystem(chainGraph(['client', 'loadBalancer', 'queue', 'server', 'database']));
  if (system.kind !== 'custom') throw new Error('expected a built system');
  const scenario = system.scenarios.find((s) => s.id === 'custom-db-slow')!;
  const config = buildRunConfig(system.topology, scenario);
  const run = runSimulation(config);

  it('a queue box shows messages waiting and how busy its consumers are, and is overloaded while falling behind', () => {
    const calm = topologyView(system.topology, config, run, 10_000).nodes.find((n) => n.id === 'n2')!;
    expect(calm).toMatchObject({ instanceCountLabel: '16 consumers', overloaded: false });
    expect(calm.lines[0]).toMatch(/^\d+ waiting$/);
    expect(calm.lines[1]).toMatch(/^consumers \d+%$/);
    const piled = topologyView(system.topology, config, run, 33_000).nodes.find((n) => n.id === 'n2')!;
    expect(Number(piled.lines[0].replace(/\D/g, ''))).toBeGreaterThan(16);
    expect(piled.overloaded).toBe(true);
    expect(piled.instanceBusy).toEqual([1]);
  });

  it('a chain longer than the presets gets columns of its own; the presets keep theirs', () => {
    const { nodes } = topologyView(system.topology, config, run, 10_000);
    expect(Math.max(...nodes.map((n) => n.col))).toBe(9);
    const style = gridStyle(nodes)!;
    expect(String(style.gridTemplateColumns).split(' minmax').length).toBe(9);
    expect(style.minWidth).toBe(0);
    expect(gridStyle(nodes.filter((n) => n.col <= 7))).toBeUndefined();
  });
});
