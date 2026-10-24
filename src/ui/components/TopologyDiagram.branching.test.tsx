import { render, screen, within } from '@testing-library/react';
import { boxRowCount, gridStyle, isDense, routePoints, TopologyDiagram, TRUNK_AFTER_SOURCE, TRUNK_BEFORE_TARGET, edgeAriaLabel } from './TopologyDiagram';
import type { TopologyEdgeView, TopologyNodeView } from './types';

const node = (id: string, col: number, row: number, instances = 4): TopologyNodeView => ({
  id,
  label: id.toUpperCase(),
  col,
  row,
  instanceCountLabel: `${instances} instances`,
  instanceBusy: new Array<number>(instances).fill(0.5),
  lines: ['workers 50%', 'CPU 10%'],
  health: 'ok',
});
// LB → S1 (above), S2 (level), S3 (below); S1 and S2 share DB (level with S1); S1 has a cache above.
const nodes: TopologyNodeView[] = [node('lb', 3, 5, 2), node('s1', 5, 3), node('cache', 5, 1, 1), node('s2', 5, 5), node('s3', 5, 7, 1), node('db', 7, 3)];
const edges: TopologyEdgeView[] = [
  { id: 'lb-s1', from: 'lb', to: 's1', col: 4, row: 3, orientation: 'routed', route: { trunk: 'source', text: 'above' }, label: '70 rps', detail: 'incl. 20 retries', rps: 70, health: 'ok', retryShare: 0.3 },
  { id: 'lb-s2', from: 'lb', to: 's2', col: 4, row: 5, orientation: 'horizontal', clearStart: true, label: '60 rps', detail: 'no retries', rps: 60, health: 'ok' },
  { id: 'lb-s3', from: 'lb', to: 's3', col: 4, row: 7, orientation: 'routed', route: { trunk: 'source', text: 'below' }, label: '60 rps', detail: '50% fail', rps: 60, health: 'bad', errorShare: 0.5 },
  { id: 's1-cache', from: 's1', to: 'cache', col: 5, row: 2, orientation: 'vertical', label: '70 lookups/s', detail: '60% hits', rps: 70, health: 'ok', cache: true },
  { id: 's1-db', from: 's1', to: 'db', col: 6, row: 3, orientation: 'horizontal', clearEnd: true, label: '28 rps', detail: 'no retries', rps: 28, health: 'ok' },
  { id: 's2-db', from: 's2', to: 'db', col: 6, row: 5, orientation: 'routed', route: { trunk: 'target', text: 'below' }, label: '60 rps', detail: 'no retries', rps: 60, health: 'ok', change: 'retry budget 10%' },
];

describe('routed arrows on the diagram', () => {
  it('puts each routed arrow’s text in its cell, on the side away from the bend, as one image named like a straight arrow', () => {
    render(<TopologyDiagram nodes={nodes} edges={edges} selectedId={null} onSelect={() => {}} />);
    const up = screen.getByTestId('edge-lb-s1');
    expect(up.getAttribute('role')).toBe('img');
    expect(up.getAttribute('aria-label')).toBe('LB to S1: 70 requests a second, including 21 repeats (retries)');
    expect(up.className).toContain('csl-edge--routed');
    expect(up.className).toContain('csl-edge--text-above');
    expect(up.style.gridColumn).toBe('4');
    expect(up.style.gridRow).toBe('3');
    expect(within(up).getAllByText('70 rps').length).toBeGreaterThan(0);
    const failing = screen.getByTestId('edge-lb-s3');
    expect(failing.className).toContain('csl-edge--failing');
    expect(failing.className).toContain('csl-edge--text-below');
    expect(failing.querySelector('.csl-edge__rpill')).not.toBeNull();
    expect(failing.getAttribute('aria-label')).toBe('LB to S3: 60 requests a second; 50% failing');
    // A fix's change is shown under the text and named.
    const merged = screen.getByTestId('edge-s2-db');
    expect(within(merged).getByText(/retry budget 10%/)).toBeTruthy();
    expect(merged.getAttribute('aria-label')).toBe('S2 to DB: 60 requests a second; changed by the fix: retry budget 10%');
  });

  it('keeps a straight arrow’s text clear of a bend beside it', () => {
    render(<TopologyDiagram nodes={nodes} edges={edges} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByTestId('edge-lb-s2').className).toContain('csl-edge--clear-start');
    expect(screen.getByTestId('edge-s1-db').className).toContain('csl-edge--clear-end');
  });

  it('draws the lines over the grid from the measured boxes, with a retry band, flow dashes and a coloured head', () => {
    // jsdom has no layout: give every box a size from its grid place.
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
        return (Number(this.style.gridColumn) || 0) * 100;
      }),
      vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
        return (Number(this.style.gridRow) || 0) * 50;
      }),
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(40),
    ];
    try {
      render(<TopologyDiagram nodes={nodes} edges={edges} selectedId={null} onSelect={() => {}} />);
      const lines = screen.getByTestId('routed-lines');
      expect(lines.getAttribute('aria-hidden')).toBe('true');
      const up = within(lines as unknown as HTMLElement).getByTestId('route-lb-s1');
      // LB at x 300..380, y 250..290 (middle 270); S1 at x 500, middle 170: out, up just after the LB, in.
      expect(up.querySelector('.csl-route__shaft')!.getAttribute('d')).toBe(`M386 270 L${380 + TRUNK_AFTER_SOURCE} 270 L${380 + TRUNK_AFTER_SOURCE} 170 L484 170`);
      expect(up.querySelector('[data-testid=route-retry]')).not.toBeNull();
      expect(up.querySelector('.csl-route__flow')).not.toBeNull();
      expect(within(lines as unknown as HTMLElement).getByTestId('route-lb-s3').getAttribute('class')).toContain('csl-route--failing');
      const into = within(lines as unknown as HTMLElement).getByTestId('route-s2-db');
      expect(into.querySelector('.csl-route__shaft')!.getAttribute('d')).toBe(`M586 270 L${700 - TRUNK_BEFORE_TARGET} 270 L${700 - TRUNK_BEFORE_TARGET} 170 L684 170`);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('routes with no bend on one row, and when the boxes are level', () => {
    const a = { x: 0, y: 0, w: 80, h: 40 };
    expect(routePoints({ trunk: 'none', text: 'straight' }, a, { x: 400, y: 0, w: 80, h: 40 })).toEqual([
      [86, 20],
      [394, 20],
    ]);
    expect(routePoints({ trunk: 'source', text: 'above' }, a, { x: 200, y: 0, w: 80, h: 40 })).toHaveLength(2);
  });

  it('a branched diagram is dense: copy squares in the title row as one square and the count, and rows sized to fit', () => {
    render(<TopologyDiagram nodes={nodes} edges={edges} selectedId={null} onSelect={() => {}} compact />);
    expect(isDense(nodes)).toBe(true);
    expect(boxRowCount(nodes)).toBe(4);
    const s1 = screen.getByRole('button', { name: /^S1/ });
    const squares = within(s1).getByTestId('instances-s1');
    expect(squares.closest('.csl-node__head')).not.toBeNull();
    expect(squares.querySelectorAll('.csl-instance')).toHaveLength(1);
    expect(within(squares).getByText('×4')).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /^S3/ })).queryByText(/×/)).toBeNull();
    expect(gridStyle(nodes, edges, true)!.gridTemplateRows).toBe('auto 40px auto 4px auto 4px auto');
    expect(gridStyle(nodes, edges)!.gridTemplateRows).toBe('auto 56px auto 12px auto 12px auto');
    // Without a cache on top, the empty top rows take no room.
    const low = nodes.filter((n) => n.id !== 'cache');
    expect(gridStyle(low, [])!.gridTemplateRows).toBe('auto 0px auto 12px auto 12px auto');
    expect(isDense(low)).toBe(true);
  });

  it('names a routed arrow from its ends even when nodes sit elsewhere on the grid', () => {
    expect(edgeAriaLabel({ ...edges[0], col: 99, row: 99 }, nodes)).toMatch(/^LB to S1:/);
  });
});
