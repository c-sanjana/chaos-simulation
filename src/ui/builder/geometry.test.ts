import { connect, starterGraph } from '../../builder/edit';
import { BOX_H, BOX_W, CELL_H, CELL_W, boxExit, cellCenter, edgeLine, edgeLines } from './geometry';

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
