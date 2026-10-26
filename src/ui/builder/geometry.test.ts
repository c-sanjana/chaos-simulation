import { connect } from '../../builder/edit';
import { starterGraph } from '../../builder/testGraphs';
import { defaultCall, defaultSettings, type BuilderGraph } from '../../builder/graph';
import { BOX_H, BOX_W, CELL_H, CELL_W, boxExit, cellCenter, edgeLine, edgeLines, labelSize, segmentHitsRect, wrapLabel } from './geometry';

describe('geometry', () => {
  it('puts cell centres on a fixed grid', () => {
    expect(cellCenter(1, 1)).toEqual({ x: CELL_W / 2, y: CELL_H / 2 });
    expect(cellCenter(3, 2)).toEqual({ x: 2.5 * CELL_W, y: 1.5 * CELL_H });
  });

  it('leaves a box through the side the ray points at', () => {
    const c = { x: 100, y: 100 };
    expect(boxExit(c, 1, 0, 0)).toEqual({ x: 100 + BOX_W / 2, y: 100 });
    expect(boxExit(c, 0, -1, 0)).toEqual({ x: 100, y: 100 - BOX_H / 2 });
    // Diagonally, the box is wider than tall, so the ray leaves through the bottom.
    expect(boxExit(c, 1, 1, 0)).toEqual({ x: 100 + BOX_H / 2, y: 100 + BOX_H / 2 });
    // The default leaves a small gap for the arrowhead.
    expect(boxExit(c, -1, 0).x).toBeLessThan(100 - BOX_W / 2);
  });

  it('runs an arrow from box edge to box edge, with its label in the middle', () => {
    const g = starterGraph();
    const [client, lb] = g.nodes;
    const line = edgeLine(client, lb, false);
    expect(line.start.y).toBe(cellCenter(1, 3).y);
    expect(line.start.x).toBeGreaterThan(cellCenter(1, 3).x + BOX_W / 2);
    expect(line.end.x).toBeLessThan(cellCenter(3, 3).x - BOX_W / 2);
    expect(line.mid.x).toBeCloseTo((line.start.x + line.end.x) / 2);
  });

  it('draws two opposite calls side by side', () => {
    const g = starterGraph();
    const server = g.nodes[2];
    const lb = g.nodes[1];
    const there = edgeLine(lb, server, true);
    const back = edgeLine(server, lb, true);
    expect(there.start.y).not.toBe(back.start.y);
    expect(there.start.y - cellCenter(3, 3).y).toBeCloseTo(-(back.start.y - cellCenter(3, 3).y));
    // Each label on its own outer side, so the two never overlap.
    expect([there.labelSide, back.labelSide]).toEqual(['below', 'above']);
  });

  it('puts labels beside the arrow, never on it: above horizontal arrows, right of vertical ones', () => {
    const g = starterGraph();
    const [client, lb, server, cache] = g.nodes;
    expect(edgeLine(client, lb, false).labelSide).toBe('above');
    expect(edgeLine(server, cache, false).labelSide).toBe('right');
    expect(edgeLine(server, cache, true).labelSide).toBe('right');
    expect(edgeLine(cache, server, true).labelSide).toBe('left');
  });

  it('bends an arrow through empty cells when a straight line would run under another box (review 3)', () => {
    // A load balancer calling three servers placed in one row with the Add button: the arrows to
    // the second and third would run under the first.
    const node = (id: string, kind: 'loadBalancer' | 'server', col: number) => ({ id, label: id, col, row: 3, settings: defaultSettings(kind) });
    const g: BuilderGraph = {
      nodes: [node('lb', 'loadBalancer', 1), node('a', 'server', 3), node('b', 'server', 5), node('c', 'server', 7)],
      edges: ['a', 'b', 'c'].map((to) => ({ id: `lb--${to}`, from: 'lb', to, call: defaultCall('loadBalancer', 'server') })),
    };
    const lines = edgeLines(g, () => '33% · 2 s · 1 retry');
    const rect = (id: string) => {
      const n = g.nodes.find((x) => x.id === id)!;
      const c = cellCenter(n.col, n.row);
      return { left: c.x - BOX_W / 2, right: c.x + BOX_W / 2, top: c.y - BOX_H / 2, bottom: c.y + BOX_H / 2 };
    };
    for (const { edge, line } of lines) {
      for (const other of g.nodes.filter((n) => n.id !== edge.from && n.id !== edge.to)) {
        for (let i = 1; i < line.points.length; i++) expect(segmentHitsRect(line.points[i - 1], line.points[i], rect(other.id))).toBe(false);
      }
    }
    expect(lines[0].line.points).toHaveLength(2); // neighbours: straight
    expect(lines[1].line.points.length).toBeGreaterThan(2); // bent around a
    expect(lines[0].line.labelWrap).toBe(true); // too wide for the gap between two boxes on one line
    expect(wrapLabel('33% · 2 s · 1 retry')).toEqual(['33% · 2 s', '1 retry']);
    expect(wrapLabel('no label')).toEqual(['no label']);
    // No label covers a box or another label.
    const labelBox = ({ mid, labelSide, labelWrap }: { mid: { x: number; y: number }; labelSide: string; labelWrap?: boolean }) => {
      const { w, h } = labelSize('33% · 2 s · 1 retry', labelWrap);
      if (labelSide === 'above') return { left: mid.x - w / 2, right: mid.x + w / 2, top: mid.y - 3 - h, bottom: mid.y - 3 };
      if (labelSide === 'below') return { left: mid.x - w / 2, right: mid.x + w / 2, top: mid.y + 3, bottom: mid.y + 3 + h };
      if (labelSide === 'right') return { left: mid.x + 5, right: mid.x + 5 + w, top: mid.y - h / 2, bottom: mid.y + h / 2 };
      return { left: mid.x - 5 - w, right: mid.x - 5, top: mid.y - h / 2, bottom: mid.y + h / 2 };
    };
    const hit = (a: ReturnType<typeof labelBox>, b: ReturnType<typeof labelBox>) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const labels = lines.map((l) => labelBox(l.line));
    labels.forEach((l, i) => {
      for (const n of g.nodes) expect(hit(l, rect(n.id))).toBe(false);
      labels.forEach((m, j) => j !== i && expect(hit(l, m)).toBe(false));
    });
    // Walled in (no empty cell leads round): straight, as before.
    const walled: BuilderGraph = { ...g, nodes: [...g.nodes, ...[2, 4].flatMap((row) => [1, 2, 3, 4, 5, 6, 7].map((col) => ({ ...node(`w${col}${row}`, 'server', col), row })))] };
    expect(edgeLines(walled).find((l) => l.edge.id === 'lb--c')!.line.points).toHaveLength(2);
  });

  it('puts a label on the other side of its arrow when a box is in the way', () => {
    const at = (id: string, kind: 'server' | 'cache' | 'database', col: number, row: number) => ({ id, label: id, col, row, settings: defaultSettings(kind) });
    const g: BuilderGraph = {
      nodes: [at('s', 'server', 5, 3), at('c', 'cache', 5, 1), at('d', 'database', 6, 2)],
      edges: [{ id: 's--c', from: 's', to: 'c', call: defaultCall('server', 'cache') }],
    };
    expect(edgeLines(g, () => '100 ms · no retries')[0].line.labelSide).toBe('left');
  });

  it('tells whether a segment crosses a rectangle', () => {
    const r = { left: 0, right: 10, top: 0, bottom: 10 };
    expect(segmentHitsRect({ x: -5, y: 5 }, { x: 15, y: 5 }, r)).toBe(true);
    expect(segmentHitsRect({ x: -5, y: 15 }, { x: 15, y: 15 }, r)).toBe(false);
    expect(segmentHitsRect({ x: 5, y: -5 }, { x: 5, y: -1 }, r)).toBe(false);
    expect(segmentHitsRect({ x: -5, y: -5 }, { x: 15, y: 15 }, r)).toBe(true);
  });

  it('lists lines for every edge whose ends exist, marking two-way pairs', () => {
    const g = connect(starterGraph(), 'server-1', 'loadBalancer-1').graph;
    const lines = edgeLines(g);
    expect(lines).toHaveLength(5);
    const lbToServer = lines.find((l) => l.edge.id === 'loadBalancer-1--server-1')!;
    expect(lbToServer.line.start.y).not.toBe(cellCenter(3, 3).y);
    expect(edgeLines({ nodes: g.nodes.slice(0, 2), edges: g.edges })).toHaveLength(1);
  });
});
