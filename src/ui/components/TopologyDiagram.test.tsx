import { fireEvent, render, screen, within } from '@testing-library/react';
import { TopologyDiagram, arrowThickness, instanceColor, nodeAriaLabel } from './TopologyDiagram';
import type { TopologyEdgeView, TopologyNodeView } from './types';

const nodes: TopologyNodeView[] = [
  { id: 'client', label: 'Client', col: 1, row: 3, instanceCountLabel: '', instanceBusy: [], lines: ['200 rps sent', '93% errors'], health: 'bad' },
  { id: 'api', label: 'API', col: 5, row: 3, instanceCountLabel: '4 instances', instanceBusy: [1, 1, 0.5, 0.999], lines: ['workers 100%', 'CPU 9%'], health: 'bad' },
  { id: 'cache', label: 'Cache', col: 5, row: 1, instanceCountLabel: '1 instance', instanceBusy: [0.2], lines: ['hit rate 70%', 'p99 2 ms'], health: 'ok' },
];
const edges: TopologyEdgeView[] = [
  { id: 'c-g', col: 2, row: 3, orientation: 'horizontal', label: '200 rps', detail: '93% fail', rps: 200, health: 'bad' },
  { id: 'a-c', col: 5, row: 2, orientation: 'vertical', label: '480 lookups/s', detail: '70% hits', rps: 480, health: 'ok' },
  { id: 'a-d', col: 6, row: 3, orientation: 'horizontal', label: '60 rps', detail: 'no retries', rps: 60, health: 'ok' },
];

describe('arrowThickness', () => {
  it('scales with rps and clamps to 2..14 px', () => {
    expect(arrowThickness(0)).toBe(2);
    expect(arrowThickness(45)).toBe(2);
    expect(arrowThickness(200)).toBe(4);
    expect(arrowThickness(480)).toBe(11);
    expect(arrowThickness(10_000)).toBe(14);
  });
});

describe('instanceColor', () => {
  it('is hot only when essentially every worker is busy', () => {
    expect(instanceColor(1)).toBe('var(--csl-instance-hot)');
    expect(instanceColor(0.999)).toBe('var(--csl-instance-hot)');
    expect(instanceColor(0.99)).toBe('var(--csl-instance-calm)');
    expect(instanceColor(0)).toBe('var(--csl-instance-calm)');
  });
});

describe('nodeAriaLabel', () => {
  it('summarises label, instance count, both lines and health', () => {
    expect(nodeAriaLabel(nodes[1])).toBe('API (4 instances): workers 100%, CPU 9%; unhealthy');
    expect(nodeAriaLabel(nodes[0])).toBe('Client: 200 rps sent, 93% errors; unhealthy');
    expect(nodeAriaLabel(nodes[2])).toBe('Cache (1 instance): hit rate 70%, p99 2 ms; healthy');
  });
});

describe('TopologyDiagram', () => {
  it('renders each node as a button placed on the grid, with selection state', () => {
    render(<TopologyDiagram nodes={nodes} edges={edges} selectedId="api" onSelect={() => {}} />);
    const api = screen.getByRole('button', { name: /^API/ });
    expect(api.getAttribute('aria-pressed')).toBe('true');
    expect(api.style.gridColumn).toBe('5');
    expect(api.style.gridRow).toBe('3');
    expect(api.className).toContain('csl-node--bad');
    expect(within(api).getByText('4 instances')).toBeTruthy();
    expect(within(api).getByText('workers 100%')).toBeTruthy();
    expect(within(api).getByText('CPU 9%')).toBeTruthy();
    const cache = screen.getByRole('button', { name: /^Cache/ });
    expect(cache.getAttribute('aria-pressed')).toBe('false');
    expect(cache.className).not.toContain('csl-node--bad');
  });

  it('draws one square per instance coloured by how busy it is, and none for the client', () => {
    render(<TopologyDiagram nodes={nodes} edges={[]} selectedId={null} onSelect={() => {}} />);
    const squares = Array.from(screen.getByTestId('instances-api').children) as HTMLElement[];
    expect(squares.map((s) => s.style.background)).toEqual([
      'var(--csl-instance-hot)',
      'var(--csl-instance-hot)',
      'var(--csl-instance-calm)',
      'var(--csl-instance-hot)',
    ]);
    expect(squares[2].title).toBe('instance 3: 50% of workers busy');
    expect(screen.queryByTestId('instances-client')).toBeNull();
    // Client has no instance count label either.
    expect(screen.getByRole('button', { name: /^Client/ }).querySelector('.csl-node__count')).toBeNull();
  });

  it('calls onSelect with the node id', () => {
    const onSelect = vi.fn();
    render(<TopologyDiagram nodes={nodes} edges={edges} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /^Cache/ }));
    expect(onSelect).toHaveBeenCalledWith('cache');
  });

  it('draws horizontal arrows with thickness from rps, orange when unhealthy, label above and detail below', () => {
    render(<TopologyDiagram nodes={[]} edges={edges} selectedId={null} onSelect={() => {}} />);
    const bad = screen.getByTestId('edge-c-g');
    expect(bad.style.gridColumn).toBe('2');
    expect(bad.className).toContain('csl-edge--bad');
    const shaft = within(bad).getByTestId('edge-shaft');
    expect(shaft.style.height).toBe('4px');
    expect(shaft.style.background).toBe('var(--csl-bad)');
    const texts = Array.from(bad.children).map((c) => c.textContent);
    expect(texts[0]).toBe('200 rps');
    expect(texts[2]).toBe('93% fail');
    expect(bad.querySelectorAll('svg')).toHaveLength(1);

    const ok = screen.getByTestId('edge-a-d');
    expect(within(ok).getByTestId('edge-shaft').style.background).toBe('var(--csl-arrow)');
    expect(ok.className).not.toContain('csl-edge--bad');
  });

  it('draws vertical arrows double-headed with width from rps', () => {
    render(<TopologyDiagram nodes={[]} edges={edges} selectedId={null} onSelect={() => {}} />);
    const v = screen.getByTestId('edge-a-c');
    expect(v.className).toContain('csl-edge--vertical');
    expect(v.querySelectorAll('svg')).toHaveLength(2);
    expect(within(v).getByTestId('edge-shaft').style.width).toBe('11px');
    expect(within(v).getByText('480 lookups/s')).toBeTruthy();
    expect(within(v).getByText('70% hits')).toBeTruthy();
  });

  it('wraps the grid in a horizontal scroll box and shows the key with an optional note', () => {
    const { container, rerender } = render(<TopologyDiagram nodes={nodes} edges={edges} selectedId={null} onSelect={() => {}} />);
    expect(container.querySelector('.csl-topology-scroll > .csl-topology-grid')).not.toBeNull();
    expect(screen.getByText(/Arrow thickness = requests\/s/)).toBeTruthy();
    expect(screen.queryByText(/Snapshot at/)).toBeNull();
    rerender(<TopologyDiagram nodes={nodes} edges={edges} selectedId={null} onSelect={() => {}} note="Snapshot at t = 60 s." />);
    expect(screen.getByText('Snapshot at t = 60 s.')).toBeTruthy();
  });
});
