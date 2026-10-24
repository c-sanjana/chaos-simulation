import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import type { BuilderGraph } from '../../builder/graph';
import { branchedGraph } from '../../builder/testGraphs';
import { BuilderScreen } from './BuilderScreen';
import { edgeLabel, splitShare } from './describe';

let latest: BuilderGraph;
function Harness({ initial }: { initial: BuilderGraph }) {
  const [graph, setGraph] = useState(initial);
  latest = graph;
  return <BuilderScreen graph={graph} onChange={setGraph} problems={[]} onUse={() => {}} />;
}
const box = (id: string) => within(screen.getByTestId(`node-${id}`)).getByRole('button');
const panel = () => screen.getByRole('complementary', { name: 'Settings' });

/** The branched system with s3 also calling Database 1, so one server calls two parts. */
function twoCalls(): BuilderGraph {
  const g = branchedGraph();
  return { ...g, edges: [...g.edges, { ...g.edges.find((e) => e.id === 's2--db1')!, id: 's3--db1', from: 's3' }] };
}

describe('BuilderScreen with branches', () => {
  it("shows each of a load balancer's arrows with its share, and lets one be changed (the others make up the rest)", () => {
    render(<Harness initial={branchedGraph()} />);
    expect(screen.getAllByText('33% · 2 s · 1 retry')).toHaveLength(3);
    const arrow = screen.getByRole('button', { name: 'lb calls s1, 33% of its traffic: gives up after 2 s, then tries again up to 1 time' });
    fireEvent.click(arrow);
    const share = within(panel()).getByLabelText(/^Share of traffic/);
    fireEvent.change(share, { target: { value: '60' } });
    expect(latest.edges.filter((e) => e.from === 'lb').map((e) => e.call.share)).toEqual([0.6, 0.2, 0.2]);
    expect(screen.getByText('60% · 2 s · 1 retry')).toBeTruthy();
  });

  it("a load balancer's settings say how it spreads requests and list its calls with their shares", () => {
    render(<Harness initial={branchedGraph()} />);
    fireEvent.click(box('lb'));
    expect(within(panel()).getByText(/Each request goes to one of these, by the share of traffic on its arrow/)).toBeTruthy();
    expect(within(panel()).getAllByText(/\(33% · 2 s · 1 retry\)/)).toHaveLength(3);
  });

  it('an app server calling two parts: one after another (in canvas order) or all at once', () => {
    render(<Harness initial={twoCalls()} />);
    fireEvent.click(box('s3'));
    const group = within(panel()).getByRole('radiogroup', { name: 'Calls its parts' });
    const [sequence, parallel] = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(sequence.checked).toBe(true);
    expect(within(panel()).getByText('Move a box up or down on the canvas to change the order.')).toBeTruthy();
    // In call order: Database 1 (row 3) before the queue (row 5).
    const calls = within(panel()).getAllByRole('button', { name: /^→/ }).map((b) => b.textContent);
    expect(calls[0]).toMatch(/^→ db1/);
    expect(calls[1]).toMatch(/^→ queue/);
    fireEvent.click(parallel);
    expect(latest.nodes.find((n) => n.id === 's3')!.settings).toMatchObject({ fanOut: 'parallel' });
    expect(within(panel()).queryByText('Move a box up or down on the canvas to change the order.')).toBeNull();
    fireEvent.click(sequence);
    expect(latest.nodes.find((n) => n.id === 's3')!.settings).toMatchObject({ fanOut: 'sequence' });
  });

  it('a call that is not split has no share', () => {
    const g = branchedGraph();
    const e = g.edges.find((x) => x.id === 's1--db1')!;
    expect(splitShare(g, e)).toBeNull();
    expect(edgeLabel(g, e)).toBe('1 s · 1 retry');
    expect(splitShare(g, { ...e, id: 'gone', from: 'lb' })).toBeNull();
  });
});
