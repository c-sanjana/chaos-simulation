import { placeCalls, trunkSides, type CallEnds, type GridPlace } from './edgeRoutes';

const at = (col: number, row: number): GridPlace => ({ col, row });
const call = (from: string, to: string, cache = false): CallEnds => ({ from, to, cache });

describe('placeCalls', () => {
  it('neighbours on a row get a straight arrow between them; a cache above its server a vertical one', () => {
    const layout = { client: at(1, 3), api: at(3, 3), cache: at(3, 1), db: at(5, 3) };
    expect(placeCalls(layout, [call('client', 'api'), call('api', 'cache', true), call('api', 'db')])).toEqual([
      { orientation: 'horizontal', col: 2, row: 3 },
      { orientation: 'vertical', col: 3, row: 2 },
      { orientation: 'horizontal', col: 4, row: 3 },
    ]);
  });

  it("a load balancer's servers on other rows: the bend by the load balancer, the text by each server, away from the bend", () => {
    const layout = { lb: at(3, 5), s1: at(5, 3), s2: at(5, 5), s3: at(5, 7) };
    const calls = [call('lb', 's1'), call('lb', 's2'), call('lb', 's3')];
    const places = placeCalls(layout, calls);
    expect(places).toEqual([
      { orientation: 'routed', col: 4, row: 3, route: { trunk: 'source', text: 'above' } },
      { orientation: 'horizontal', col: 4, row: 5 },
      { orientation: 'routed', col: 4, row: 7, route: { trunk: 'source', text: 'below' } },
    ]);
    // The straight arrow keeps its text clear of the bend at its start.
    expect(trunkSides(calls, places)).toEqual([
      { clearStart: false, clearEnd: false },
      { clearStart: true, clearEnd: false },
      { clearStart: false, clearEnd: false },
    ]);
  });

  it('into a shared database: the bend by the database, the text by each caller', () => {
    const layout = { s1: at(5, 3), s2: at(5, 5), s3: at(5, 7), db: at(7, 5) };
    const calls = [call('s1', 'db'), call('s2', 'db'), call('s3', 'db')];
    const places = placeCalls(layout, calls);
    expect(places).toEqual([
      { orientation: 'routed', col: 6, row: 3, route: { trunk: 'target', text: 'above' } },
      { orientation: 'horizontal', col: 6, row: 5 },
      { orientation: 'routed', col: 6, row: 7, route: { trunk: 'target', text: 'below' } },
    ]);
    expect(trunkSides(calls, places)[1]).toEqual({ clearStart: false, clearEnd: true });
  });

  it('on one row but further apart: a straight line, text left of the callee', () => {
    expect(placeCalls({ a: at(3, 3), b: at(7, 3) }, [call('a', 'b')])).toEqual([{ orientation: 'routed', col: 6, row: 3, route: { trunk: 'none', text: 'straight' } }]);
  });

  it('when the preferred text cell is taken, the text goes to the other end (or shares it when both are)', () => {
    // b is shared by a and y. a's text would go by a, but x → f's text already sits there: it goes by b.
    const layout = { a: at(1, 1), f: at(3, 1), x: at(1, 3), b: at(3, 3), y: at(1, 5) };
    const places = placeCalls(layout, [call('x', 'f'), call('a', 'b'), call('y', 'b')]);
    expect(places).toEqual([
      { orientation: 'routed', col: 2, row: 1, route: { trunk: 'source', text: 'above' } },
      { orientation: 'routed', col: 2, row: 3, route: { trunk: 'source', text: 'below' } },
      { orientation: 'routed', col: 2, row: 5, route: { trunk: 'target', text: 'below' } },
    ]);
    // Both ends taken: it shares the preferred cell.
    const crowded = placeCalls(layout, [call('x', 'f'), call('x', 'b'), call('a', 'b')]);
    expect(crowded[2]).toEqual({ orientation: 'routed', col: 2, row: 1, route: { trunk: 'target', text: 'above' } });
  });

  it('skips calls whose ends are not placed, backwards calls and a cache not straight above its server', () => {
    const layout = { a: at(3, 3), b: at(1, 1), c: at(5, 1) };
    expect(placeCalls(layout, [call('a', 'ghost'), call('a', 'b'), call('a', 'c', true)])).toEqual([null, null, null]);
  });
});
