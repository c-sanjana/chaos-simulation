import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { GRID_COLS, GRID_ROWS, addNode, emptyGraph, starterGraph } from '../../builder/edit';
import type { BuilderGraph } from '../../builder/graph';
import { exampleGraph } from '../system';
import { BuilderScreen } from './BuilderScreen';
import { canCallAnything } from './BuilderCanvas';

/** The latest graph the screen reported, so tests can check the data, not just the DOM. */
let latest: BuilderGraph;

function Harness({ initial = emptyGraph(), problems = [], onUse = () => {} }: { initial?: BuilderGraph; problems?: string[]; onUse?: () => void }) {
  const [graph, setGraph] = useState(initial);
  latest = graph;
  return <BuilderScreen graph={graph} onChange={setGraph} problems={problems} onUse={onUse} />;
}

const node = (id: string) => screen.getByTestId(`node-${id}`);
const box = (id: string) => within(node(id)).getByRole('button');
const cell = (col: number, row: number) => screen.getByTestId(`cell-${col}-${row}`);
const status = () => screen.getAllByRole('status').find((el) => el.classList.contains('csl-builder__status'))!;
const placed = (id: string) => {
  const n = latest.nodes.find((x) => x.id === id)!;
  return [n.col, n.row];
};
const panel = () => screen.getByRole('complementary', { name: 'Settings' });
const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: 'all' });

describe('BuilderScreen: empty canvas and toolbar', () => {
  it('shows a hint, and loads the example from it', () => {
    render(<Harness />);
    expect(screen.getByText('Your canvas is empty')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Clear' }) as HTMLButtonElement).disabled).toBe(true);
    const buttons = screen.getAllByRole('button', { name: 'Start from the example' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    // The actual example system: its traffic, retries and sizes, as the example preset runs it.
    expect(latest).toEqual(exampleGraph());
    expect(screen.queryByText('Your canvas is empty')).toBeNull();
    expect(screen.getByRole('button', { name: /^Client, a client: 200 req\/s/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Client calls Gateway: gives up after 3 s, then tries again up to 5 times' }).textContent).toBe('3 s · 5 retries');
    expect(screen.getByRole('button', { name: 'App server calls DB: gives up after 1 s, then tries again up to 1 time' }).textContent).toBe('1 s · 1 retry');
    expect(status().textContent).toBe('Loaded the example: Client → Gateway → App server → DB, with a Cache.');
  });

  it('clears the canvas, and can undo the clear', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(latest.nodes).toHaveLength(0);
    expect(status().textContent).toMatch(/Cleared the canvas/);
    fireEvent.click(within(status()).getByRole('button', { name: 'Undo' }));
    expect(latest).toEqual(starterGraph());
    expect(status().textContent).toMatch(/Brought back/);
    expect(within(status()).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('can undo loading the example over a topology, but offers no undo over an empty canvas', () => {
    const own = addNode(emptyGraph(), 'queue', 2, 2).graph;
    const { unmount } = render(<Harness initial={own} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start from the example' }));
    fireEvent.click(within(status()).getByRole('button', { name: 'Undo' }));
    expect(latest).toEqual(own);
    unmount();
    render(<Harness />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Start from the example' })[0]);
    expect(within(status()).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('a successful edit after a clear drops the undo', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add queue' }));
    expect(within(status()).queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

describe('BuilderScreen: problems and "Use this topology"', () => {
  it('lists problems and blocks using the topology while there are any', () => {
    const onUse = vi.fn();
    render(<Harness initial={starterGraph()} problems={['The Client calls nothing.', 'App server 2 is unreachable.']} onUse={onUse} />);
    // Still focusable and clickable, with the count on it; a click takes you to the list.
    const use = screen.getByRole('button', { name: 'Use this topology · 2 things to fix' });
    expect(use.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/2 things to fix before simulating/)).toBeTruthy();
    expect(screen.getByText('The Client calls nothing.')).toBeTruthy();
    const list = document.getElementById(use.getAttribute('aria-describedby')!)!;
    expect(list.textContent).toMatch(/App server 2 is unreachable/);
    fireEvent.click(use);
    expect(onUse).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(list);
  });

  it('words a single problem', () => {
    render(<Harness problems={['Add a Client.']} />);
    expect(screen.getByText(/One thing to fix/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use this topology · 1 thing to fix' })).toBeTruthy();
  });

  it('offers the topology when there are no problems', () => {
    const onUse = vi.fn();
    render(<Harness initial={starterGraph()} onUse={onUse} />);
    expect(screen.getByText('Ready to simulate.')).toBeTruthy();
    const use = screen.getByRole('button', { name: 'Use this topology' }) as HTMLButtonElement;
    expect(use.getAttribute('aria-disabled')).toBeNull();
    expect(use.getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(use);
    expect(onUse).toHaveBeenCalledTimes(1);
  });
});

describe('BuilderScreen: palette', () => {
  it('lists the six components with their blurbs', () => {
    render(<Harness />);
    const palette = screen.getByRole('list', { name: 'Components you can add' });
    expect(within(palette).getAllByRole('listitem')).toHaveLength(6);
    expect(within(palette).getByText('Remembers answers so the database is asked less')).toBeTruthy();
  });

  it('adds with the Add button one cell apart (right of the selected box), selects it, and numbers repeats', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add app server' }));
    expect(placed('server-1')).toEqual([1, 3]); // the middle row, like the example
    expect(box('server-1').getAttribute('aria-pressed')).toBe('true');
    expect(within(panel()).getByRole('heading', { name: 'App server' })).toBeTruthy();
    expect(status().textContent).toBe('Added App server. Its settings are open in the Settings panel.');
    fireEvent.click(screen.getByRole('button', { name: 'Add app server' }));
    expect(placed('server-2')).toEqual([3, 3]); // never in a touching cell, so the arrow between them shows
    expect(latest.nodes[1].label).toBe('App server 2');
    fireEvent.click(box('server-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Add database' }));
    expect(placed('database-1')).toEqual([5, 3]); // no room right of the selected box: the next roomy cell
  });

  it('allows one Client, and explains why when asked for another', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Add client' }));
    const again = screen.getByRole('button', { name: 'Add client' });
    expect(again.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('palette-client').getAttribute('draggable')).toBe('false');
    expect(screen.getByText('Already on the canvas (only one allowed)')).toBeTruthy();
    fireEvent.click(again);
    expect(latest.nodes).toHaveLength(1);
    expect(status().textContent).toMatch(/^Not possible: There is already a Client/);
    expect(status().className).toMatch(/refused/);
  });

  it('says when the canvas is full', () => {
    let g = emptyGraph();
    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) g = addNode(g, 'queue', 1, 1).graph;
    render(<Harness initial={g} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add app server' }));
    expect(status().textContent).toMatch(/canvas is full/);
  });
});

describe('BuilderScreen: drag and drop', () => {
  it('drops a palette item on the cell under the pointer', () => {
    render(<Harness />);
    fireEvent.dragStart(screen.getByTestId('palette-database'), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(cell(4, 2));
    expect(cell(4, 2).className).toMatch(/csl-bcanvas__cell--drop/);
    fireEvent.dragLeave(cell(4, 2));
    expect(cell(4, 2).className).not.toMatch(/--drop/);
    fireEvent.dragOver(cell(4, 2));
    fireEvent.drop(cell(4, 2));
    expect(placed('database-1')).toEqual([4, 2]);
    expect(cell(4, 2).className).not.toMatch(/--drop/);
  });

  it('records what is dragged for the browser', () => {
    render(<Harness />);
    const dt = dataTransfer();
    fireEvent.dragStart(screen.getByTestId('palette-cache'), { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith('text/plain', 'cache');
    expect(dt.effectAllowed).toBe('copy');
    fireEvent.dragEnd(screen.getByTestId('palette-cache'));
  });

  it('drops a palette item on a box onto the nearest free cell', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.dragStart(screen.getByTestId('palette-queue'));
    fireEvent.dragOver(node('server-1'));
    fireEvent.drop(node('server-1'));
    expect(placed('queue-1')).toEqual([5, 2]);
  });

  it('ignores drags it did not start', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.dragOver(cell(9, 5));
    fireEvent.dragOver(node('server-1'));
    fireEvent.drop(cell(9, 5));
    fireEvent.drop(node('server-1'));
    expect(latest).toEqual(starterGraph());
  });

  it('moves a box to a free cell, refusing taken ones with a reason', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.dragStart(box('database-1'), { dataTransfer: dataTransfer() });
    expect(box('database-1').getAttribute('aria-pressed')).toBe('true');
    expect(node('database-1').className).toMatch(/moving/);
    // Over itself: fine, nothing to say.
    fireEvent.dragOver(node('database-1'));
    expect(within(node('database-1')).queryByRole('status')).toBeNull();
    // Over another box: refused, and says why.
    fireEvent.dragOver(node('server-1'));
    expect(within(node('server-1')).getByRole('status').textContent).toBe('✕ That spot is taken by App server.');
    expect(within(node('server-1')).getByRole('status').className).not.toMatch(/--above/);
    fireEvent.drop(node('server-1'));
    expect(placed('database-1')).toEqual([7, 3]);
    fireEvent.dragStart(box('database-1'));
    fireEvent.dragOver(cell(9, 4));
    fireEvent.drop(cell(9, 4));
    expect(placed('database-1')).toEqual([9, 4]);
    expect(status().textContent).toBe('Moved to column 9, row 4.');
    fireEvent.dragEnd(box('database-1'));
    expect(node('database-1').className).not.toMatch(/moving/);
    // On the bottom row the verdict sits above the box, so it stays on the canvas.
    fireEvent.keyDown(box('server-1'), { key: 'ArrowDown' });
    fireEvent.keyDown(box('server-1'), { key: 'ArrowDown' });
    fireEvent.dragStart(box('database-1'));
    fireEvent.dragOver(node('server-1'));
    expect(within(node('server-1')).getByRole('status').className).toMatch(/--above/);
  });

  it('dropping a box back where it was changes nothing', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.dragStart(box('server-1'));
    fireEvent.drop(cell(5, 3));
    expect(latest).toEqual(starterGraph());
    expect(status().textContent).toBe('');
  });

  it('connects by dragging from a box handle to another box', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.dragStart(screen.getByTestId('handle-loadBalancer-1'), { dataTransfer: dataTransfer() });
    expect(node('loadBalancer-1').className).toMatch(/source/);
    expect(node('database-1').className).toMatch(/csl-bnode--ok/);
    expect(node('client-1').className).toMatch(/csl-bnode--no/);
    expect(node('cache-1').className).toMatch(/csl-bnode--no/);
    // Hovering an allowed box says it can be dropped; a refused one says why.
    fireEvent.dragOver(node('database-1'));
    expect(within(node('database-1')).getByRole('status').textContent).toBe('✓ Drop to connect');
    fireEvent.dragOver(node('database-1')); // repeated events don't re-render the verdict
    fireEvent.dragLeave(node('database-1'));
    expect(within(node('database-1')).queryByRole('status')).toBeNull();
    fireEvent.dragOver(node('cache-1'));
    expect(within(node('cache-1')).getByRole('status').textContent).toBe('✕ Only an app server looks things up in a cache.');
    // Empty cells are not targets for a call.
    fireEvent.dragOver(cell(9, 5));
    fireEvent.drop(node('database-1'));
    expect(latest.edges.map((e) => e.id)).toContain('loadBalancer-1--database-1');
    expect(status().textContent).toBe('Load balancer calls Database now.');
    expect(within(panel()).getByRole('heading', { name: 'Load balancer → Database' })).toBeTruthy();
    expect(node('database-1').className).not.toMatch(/--ok/);
  });

  it('explains a refused drop on the status line', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.dragStart(screen.getByTestId('handle-server-1'));
    fireEvent.drop(node('client-1'));
    expect(status().textContent).toBe('Not possible: Nothing calls the Client: it is where requests start.');
    expect(latest.edges).toHaveLength(4);
  });

  it('a drag let go over a refused box (no drop event in browsers) still says why on the status line', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.dragStart(screen.getByTestId('handle-loadBalancer-1'));
    fireEvent.dragOver(node('cache-1'));
    fireEvent.dragEnd(screen.getByTestId('handle-loadBalancer-1'));
    expect(status().textContent).toBe('Not possible: Only an app server looks things up in a cache.');
    // Moved off the refused box first: nothing to say.
    fireEvent.dragStart(box('database-1'));
    fireEvent.dragOver(node('server-1'));
    fireEvent.dragLeave(node('server-1'));
    fireEvent.dragEnd(box('database-1'));
    expect(status().textContent).toBe('Not possible: Only an app server looks things up in a cache.');
  });

  it('draws a dashed preview line to the pointer while connecting', () => {
    const { container } = render(<Harness initial={starterGraph()} />);
    const canvas = container.querySelector('.csl-bcanvas')!;
    fireEvent.dragOver(canvas, { clientX: 10 }); // not connecting: no preview
    fireEvent.dragStart(screen.getByTestId('handle-client-1'));
    fireEvent.dragOver(canvas); // no coordinates: no preview
    expect(screen.queryByTestId('connect-preview')).toBeNull();
    const ev = createEvent.dragOver(canvas);
    Object.defineProperty(ev, 'clientX', { value: 300 });
    Object.defineProperty(ev, 'clientY', { value: 120 });
    fireEvent(canvas, ev);
    const line = screen.getByTestId('connect-preview');
    expect(line.getAttribute('x2')).toBe('300');
    expect(line.getAttribute('y2')).toBe('120');
    fireEvent.dragEnd(screen.getByTestId('handle-client-1'));
    expect(screen.queryByTestId('connect-preview')).toBeNull();
  });

  it('gives connection handles only to components that can call something', () => {
    render(<Harness initial={starterGraph()} />);
    expect(screen.queryByTestId('handle-database-1')).toBeNull();
    expect(screen.queryByTestId('handle-cache-1')).toBeNull();
    expect(screen.getByTestId('handle-server-1')).toBeTruthy();
    expect(canCallAnything('queue')).toBe(true);
    expect(canCallAnything('database')).toBe(false);
  });
});

describe('BuilderScreen: selecting and keyboard', () => {
  it('selects boxes and arrows by click, and clears the selection on an empty cell or Escape', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.click(box('cache-1'));
    expect(box('cache-1').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(cell(9, 5));
    expect(box('cache-1').getAttribute('aria-pressed')).toBe('false');
    expect(within(panel()).getByText(/Select a box or an arrow/)).toBeTruthy();
    const label = screen.getByRole('button', { name: /^Client calls Load balancer/ });
    fireEvent.click(label);
    expect(label.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('line-client-1--loadBalancer-1').querySelector('.csl-bcanvas__line--selected')).toBeTruthy();
    fireEvent.keyDown(label, { key: 'Escape' });
    expect(label.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(label, { key: 'Escape' }); // nothing selected: nothing happens
  });

  it('selects an arrow by clicking its line', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.click(screen.getByTestId('line-server-1--cache-1').querySelector('.csl-bcanvas__hit')!);
    expect(within(panel()).getByRole('heading', { name: 'App server → Cache' })).toBeTruthy();
  });

  it('draws cache lookups double-headed, other calls single-headed', () => {
    render(<Harness initial={starterGraph()} />);
    const cache = screen.getByTestId('line-server-1--cache-1').querySelector('.csl-bcanvas__line')!;
    expect(cache.getAttribute('marker-start')).toBeTruthy();
    expect(cache.getAttribute('class')).toMatch(/--cache/);
    const db = screen.getByTestId('line-server-1--database-1').querySelector('.csl-bcanvas__line')!;
    expect(db.getAttribute('marker-start')).toBeNull();
    expect(db.getAttribute('marker-end')).toMatch(/^url\(#csl-arrow-/);
  });

  it('selects with Enter or Space and moves with the arrow keys', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.keyDown(box('database-1'), { key: 'Enter' });
    expect(box('database-1').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(box('cache-1'), { key: ' ' });
    expect(box('cache-1').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(box('database-1'), { key: 'ArrowRight' });
    expect(placed('database-1')).toEqual([8, 3]);
    expect(box('database-1').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(box('database-1'), { key: 'ArrowDown' });
    fireEvent.keyDown(box('database-1'), { key: 'ArrowLeft' });
    fireEvent.keyDown(box('database-1'), { key: 'ArrowUp' });
    expect(placed('database-1')).toEqual([7, 3]);
    fireEvent.keyDown(box('database-1'), { key: 'ArrowLeft' });
    fireEvent.keyDown(box('database-1'), { key: 'ArrowLeft' });
    expect(status().textContent).toBe('Not possible: That spot is taken by App server.');
    fireEvent.keyDown(box('cache-1'), { key: 'ArrowUp' });
    expect(status().textContent).toBe('Not possible: That is outside the canvas.');
    fireEvent.keyDown(box('cache-1'), { key: 'a' }); // other keys do nothing
    expect(placed('cache-1')).toEqual([5, 1]);
  });

  it('deletes the selected box (and its calls) with Delete, and the selected arrow with Backspace', () => {
    const { container } = render(<Harness initial={starterGraph()} />);
    fireEvent.click(box('cache-1'));
    fireEvent.keyDown(box('cache-1'), { key: 'Delete' });
    expect(latest.nodes.map((n) => n.id)).not.toContain('cache-1');
    expect(latest.edges.map((e) => e.id)).not.toContain('server-1--cache-1');
    expect(status().textContent).toBe('Removed Cache and its calls.Undo');
    expect(document.activeElement).toBe(container.querySelector('.csl-bcanvas'));
    const label = screen.getByRole('button', { name: /^App server calls Database/ });
    fireEvent.click(label);
    fireEvent.keyDown(label, { key: 'Backspace' });
    expect(latest.edges.map((e) => e.id)).not.toContain('server-1--database-1');
    expect(status().textContent).toBe('Removed the call. App server no longer calls Database.Undo');
    // Undo brings the call back.
    fireEvent.click(within(status()).getByRole('button', { name: 'Undo' }));
    expect(latest.edges.map((e) => e.id)).toContain('server-1--database-1');
    // With nothing selected, Delete does nothing.
    fireEvent.keyDown(container.querySelector('.csl-bcanvas')!, { key: 'Delete' });
    expect(latest.nodes).toHaveLength(4);
  });

  it('undoes removing a box, calls and all', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.click(box('server-1'));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Remove App server' }));
    expect(latest.edges).toHaveLength(1);
    fireEvent.click(within(status()).getByRole('button', { name: 'Undo' }));
    expect(latest).toEqual(starterGraph());
  });

  it('focusing a box or an arrow selects it, so Delete removes what the keyboard is on', () => {
    render(<Harness initial={starterGraph()} />);
    fireEvent.click(box('cache-1'));
    fireEvent.focus(box('database-1'));
    expect(box('database-1').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(box('database-1'), { key: 'Delete' });
    expect(latest.nodes.map((n) => n.id)).toEqual(['client-1', 'loadBalancer-1', 'server-1', 'cache-1']);
    const label = screen.getByRole('button', { name: /^Client calls Load balancer/ });
    fireEvent.focus(label);
    expect(within(panel()).getByRole('heading', { name: 'Client → Load balancer' })).toBeTruthy();
  });
});

describe('BuilderScreen: settings panel for a box', () => {
  const select = (id: string) => fireEvent.click(box(id));
  const field = (name: string | RegExp) => within(panel()).getByRole('spinbutton', { name }) as HTMLInputElement;
  const setField = (name: string | RegExp, value: string) => fireEvent.change(field(name), { target: { value } });
  const settings = (id: string) => latest.nodes.find((n) => n.id === id)!.settings as unknown as Record<string, unknown>;

  it('renames, and asks for a name when it is blank', () => {
    render(<Harness initial={starterGraph()} />);
    select('server-1');
    const name = within(panel()).getByRole('textbox', { name: /Name/ });
    fireEvent.change(name, { target: { value: 'Orders API' } });
    expect(latest.nodes[2].label).toBe('Orders API');
    expect(within(panel()).getByRole('heading', { name: 'Orders API' })).toBeTruthy();
    fireEvent.change(name, { target: { value: ' ' } });
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(name.getAttribute('aria-describedby')!)?.textContent).toBe('Give it a name');
    // A blank name shows as the kind on the canvas.
    expect(within(box('server-1')).getByText('App server')).toBeTruthy();
  });

  it('shows the kind on the box when the name differs from it', () => {
    render(<Harness initial={starterGraph()} />);
    expect(box('server-1').querySelector('.csl-bnode__kind')).toBeNull();
    select('server-1');
    fireEvent.change(within(panel()).getByRole('textbox', { name: /Name/ }), { target: { value: 'API' } });
    expect(box('server-1').querySelector('.csl-bnode__kind')?.textContent).toBe('App server');
  });

  it('edits the Client traffic', () => {
    render(<Harness initial={starterGraph()} />);
    select('client-1');
    setField(/Requests per second/, '250');
    expect(settings('client-1').rps).toBe(250);
    expect(within(box('client-1')).getByText('250 req/s')).toBeTruthy();
    expect(within(panel()).getByText(/→ Load balancer/)).toBeTruthy();
  });

  it('edits every setting of a server, including the waiting-line limit', () => {
    render(<Harness initial={starterGraph()} />);
    select('server-1');
    setField('Copies (instances)', '6');
    setField('Requests each copy handles at once', '50');
    setField('CPU cores per copy', '8');
    setField(/Typical time per request/, '5');
    setField(/Slowest 1% take/, '40');
    expect(settings('server-1')).toMatchObject({ instances: 6, workersPerInstance: 50, coresPerInstance: 8, service: { medianMs: 5, p99Ms: 40 } });
    // The slow time can't be below the typical time, nor equal to it, and says so on that field.
    setField(/Slowest 1% take/, '5');
    expect(within(panel()).getByText('Must take longer than the typical time (5 ms)')).toBeTruthy();
    setField(/Slowest 1% take/, '2');
    expect(field(/Slowest 1% take/).getAttribute('aria-invalid')).toBe('true');
    expect((settings('server-1').service as { p99Ms: number }).p99Ms).toBe(40);

    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Limit the waiting line' }));
    expect(settings('server-1').queueLimit).toBe(50);
    setField('Requests allowed to wait, per copy', '10');
    expect(settings('server-1').queueLimit).toBe(10);
    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Limit the waiting line' }));
    expect(settings('server-1').queueLimit).toBeNull();
    expect(within(panel()).queryByRole('spinbutton', { name: 'Requests allowed to wait, per copy' })).toBeNull();

    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Skip requests whose caller already gave up' }));
    expect(settings('server-1').dropExpired).toBe(true);
  });

  it('edits a cache, including expiry', () => {
    render(<Harness initial={starterGraph()} />);
    select('cache-1');
    setField(/Keys it can hold/, '5000');
    setField(/Different keys requested/, '20000');
    setField(/Popularity skew/, '0.5');
    setField(/Expire after/, '30');
    setField(/Typical time per lookup/, '0.5');
    setField('Copies (instances)', '2');
    expect(settings('cache-1')).toMatchObject({ capacity: 5000, keys: 20000, skew: 0.5, ttlMs: 30_000, instances: 2, service: { medianMs: 0.5 } });
    const expires = within(panel()).getByRole('checkbox', { name: 'Entries expire' });
    fireEvent.click(expires);
    expect(settings('cache-1').ttlMs).toBeNull();
    expect(within(panel()).queryByRole('spinbutton', { name: /Expire after/ })).toBeNull();
    fireEvent.click(expires);
    expect(settings('cache-1').ttlMs).toBe(60_000);
    expect(within(panel()).getByText(/only answers calls/)).toBeTruthy();
  });

  it('edits a queue', () => {
    render(<Harness initial={addNode(emptyGraph(), 'queue', 1, 1).graph} />);
    select('queue-1');
    setField('Messages it can hold', '500');
    setField(/Messages handled at once/, '4');
    setField(/Typical time per message/, '2');
    expect(settings('queue-1')).toMatchObject({ maxDepth: 500, consumers: 4, service: { medianMs: 2 } });
    expect(within(panel()).getByText('There is nothing more on the canvas it can call.')).toBeTruthy();
  });

  it('adds a call from the "Calls…" list, which offers only allowed targets', () => {
    render(<Harness initial={starterGraph()} />);
    select('loadBalancer-1');
    const calls = within(panel()).getByRole('combobox', { name: /Calls…/ }) as HTMLSelectElement;
    const options = Array.from(calls.options).map((o) => o.textContent);
    expect(options).toEqual(['Choose a component to call', 'Database (database)']);
    const connectButton = within(panel()).getByRole('button', { name: 'Connect' });
    expect(connectButton.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(connectButton); // nothing chosen: nothing happens
    // Choosing (as an arrow key does) doesn't connect yet: only Connect does.
    fireEvent.change(calls, { target: { value: 'database-1' } });
    expect(latest.edges).toHaveLength(4);
    expect(connectButton.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(connectButton);
    expect(latest.edges.map((e) => e.id)).toContain('loadBalancer-1--database-1');
    const heading = within(panel()).getByRole('heading', { name: 'Load balancer → Database' });
    expect(document.activeElement).toBe(heading); // focus follows to the new call's settings
    // Selecting the call again later leaves focus alone.
    fireEvent.click(box('server-1'));
    const label = screen.getByRole('button', { name: /^Load balancer calls Database/ });
    label.focus();
    expect(document.activeElement).toBe(label);
  });

  it('jumps to a call from the list of calls', () => {
    render(<Harness initial={starterGraph()} />);
    select('server-1');
    fireEvent.click(within(panel()).getByRole('button', { name: /→ Database/ }));
    expect(within(panel()).getByRole('heading', { name: 'App server → Database' })).toBeTruthy();
  });

  it('removes the box from the panel', () => {
    render(<Harness initial={starterGraph()} />);
    select('database-1');
    expect(within(panel()).queryByRole('combobox')).toBeNull();
    fireEvent.click(within(panel()).getByRole('button', { name: 'Remove Database' }));
    expect(latest.nodes.map((n) => n.id)).not.toContain('database-1');
    expect(within(panel()).getByText(/Select a box or an arrow/)).toBeTruthy();
  });
});

describe('BuilderScreen: half-typed numbers', () => {
  it('count as a problem until fixed: no "Ready", and Use takes you to the field', async () => {
    const onUse = vi.fn();
    render(<Harness initial={starterGraph()} onUse={onUse} />);
    fireEvent.click(box('server-1'));
    const copies = within(panel()).getByRole('spinbutton', { name: 'Copies (instances)' });
    fireEvent.change(copies, { target: { value: '0' } });
    await screen.findByText('"Copies (instances)" isn\'t a number that can be used yet: fix the field marked in red.');
    expect(screen.queryByText('Ready to simulate.')).toBeNull();
    const use = screen.getByRole('button', { name: 'Use this topology · 1 thing to fix' });
    // Pressing it must not first blur the field (which would quietly bring back the last valid value).
    const down = createEvent.mouseDown(use);
    fireEvent(use, down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(use);
    expect(onUse).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(copies);
    fireEvent.change(copies, { target: { value: '3' } });
    await screen.findByText('Ready to simulate.');
    fireEvent.click(screen.getByRole('button', { name: 'Use this topology' }));
    expect(onUse).toHaveBeenCalledTimes(1);
  });
});

describe('BuilderScreen: settings panel for a call', () => {
  const selectCall = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));
  const call = (id: string) => latest.edges.find((e) => e.id === id)!.call;

  it('edits timeout, retries, backoff and jitter in plain words', () => {
    render(<Harness initial={starterGraph()} />);
    selectCall(/^App server calls Database/);
    expect(within(panel()).getByText('App server gives up after 1 s, then tries again up to 1 time.')).toBeTruthy();
    fireEvent.change(within(panel()).getByRole('spinbutton', { name: /Timeout/ }), { target: { value: '500' } });
    fireEvent.change(within(panel()).getByRole('spinbutton', { name: 'Retries' }), { target: { value: '3' } });
    fireEvent.change(within(panel()).getByRole('spinbutton', { name: /Wait before retrying/ }), { target: { value: '20' } });
    fireEvent.click(within(panel()).getByRole('checkbox', { name: /jitter/ }));
    expect(call('server-1--database-1')).toEqual({ timeoutMs: 500, retries: 3, backoffBaseMs: 20, jitter: false });
    expect(screen.getByRole('button', { name: /^App server calls Database/ }).textContent).toBe('500 ms · 3 retries');
  });

  it('shows the wait between retries only when the call retries', () => {
    render(<Harness initial={starterGraph()} />);
    selectCall(/^App server calls Database/);
    fireEvent.change(within(panel()).getByRole('spinbutton', { name: 'Retries' }), { target: { value: '0' } });
    expect(within(panel()).queryByRole('spinbutton', { name: /Wait before retrying/ })).toBeNull();
    expect(within(panel()).queryByRole('checkbox', { name: /jitter/ })).toBeNull();
    fireEvent.change(within(panel()).getByRole('spinbutton', { name: 'Retries' }), { target: { value: '2' } });
    expect(within(panel()).getByRole('spinbutton', { name: /Wait before retrying/ })).toBeTruthy();
  });

  it('turns the timeout off and back on at the usual value for the pair', () => {
    render(<Harness initial={starterGraph()} />);
    selectCall(/^Client calls Load balancer/);
    const timeout = within(panel()).getByRole('checkbox', { name: 'Give up after a timeout' });
    fireEvent.change(within(panel()).getByRole('spinbutton', { name: /Timeout/ }), { target: { value: '9000' } });
    fireEvent.click(timeout);
    expect(call('client-1--loadBalancer-1').timeoutMs).toBeNull();
    expect(within(panel()).queryByRole('spinbutton', { name: /Timeout/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Client calls Load balancer/ }).textContent).toBe('no timeout · 2 retries');
    fireEvent.click(timeout);
    expect(call('client-1--loadBalancer-1').timeoutMs).toBe(3000);
  });

  it('turns a cache lookup timeout back on at 100 ms', () => {
    const g = starterGraph();
    const odd = { ...g, edges: g.edges.map((e) => (e.id === 'server-1--cache-1' ? { ...e, call: { ...e.call, timeoutMs: null } } : e)) };
    render(<Harness initial={odd} />);
    selectCall(/^App server calls Cache/);
    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Give up after a timeout' }));
    expect(call('server-1--cache-1').timeoutMs).toBe(100);
  });

  it('removes the call from the panel', () => {
    render(<Harness initial={starterGraph()} />);
    selectCall(/^App server calls Cache/);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Remove this call' }));
    expect(latest.edges.map((e) => e.id)).not.toContain('server-1--cache-1');
    expect(status().textContent).toBe('Removed the call. App server no longer calls Cache.Undo');
  });

  it('shows nothing selected when the selected item disappears', () => {
    render(<Harness initial={starterGraph()} />);
    selectCall(/^App server calls Cache/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(within(panel()).getByText(/Select a box or an arrow/)).toBeTruthy();
  });
});
