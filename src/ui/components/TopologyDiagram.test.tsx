import { fireEvent, render, screen, within } from '@testing-library/react';
import { TopologyDiagram, arrowThickness, detailForms, edgeAriaLabel, edgeEnds, edgeKind, errorWash, fitBucket, flowDurationS, gridStyle, instanceColor, isLongChain, keepEnd, nodeAriaLabel, rateForms, withoutIcon } from './TopologyDiagram';
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
    expect(nodeAriaLabel({ ...nodes[0], errorShare: 0.93 })).toBe('Client: 200 rps sent, 93% errors; unhealthy; failing, 93% not answered');
    expect(nodeAriaLabel(nodes[2])).toBe('Cache (1 instance): hit rate 70%, p99 2 ms; healthy');
  });

  it('adds the injected failure, overload and fix change in words, without the badge symbols', () => {
    const db: TopologyNodeView = { ...nodes[2], id: 'db', label: 'DB', lines: ['467 rps in', 'CPU 100%'], health: 'bad', errorShare: 0.12, fault: '⚡ 8× slower', overloaded: true, change: 'queue limit 93' };
    expect(nodeAriaLabel(db)).toBe(
      'DB (1 instance): 467 rps in, CPU 100%; unhealthy; injected failure: 8× slower; failing, 12% errors; overloaded: more work is arriving than it can serve; changed by the fix: queue limit 93',
    );
    expect(nodeAriaLabel({ ...nodes[2], fault: 'down', change: '🔧 TTL 30 s' })).toBe('Cache (1 instance): hit rate 70%, p99 2 ms; healthy; injected failure: down; changed by the fix: TTL 30 s');
  });
});

describe('withoutIcon', () => {
  it('drops one leading badge symbol (with or without the emoji variation selector)', () => {
    expect(withoutIcon('⚡ 8× slower')).toBe('8× slower');
    expect(withoutIcon('⚡\uFE0F 8× slower')).toBe('8× slower');
    expect(withoutIcon('🔧 retry budget 10%')).toBe('retry budget 10%');
    expect(withoutIcon('⚠overloaded')).toBe('overloaded');
    expect(withoutIcon('queue limit 93')).toBe('queue limit 93');
    expect(withoutIcon('8× slower ⚡')).toBe('8× slower ⚡');
  });
});

describe('edgeEnds and edgeAriaLabel', () => {
  const tiers: TopologyNodeView[] = [
    ...nodes,
    { id: 'db', label: 'DB', col: 7, row: 3, instanceCountLabel: '1 instance', instanceBusy: [1], lines: ['467 rps in', 'CPU 100%'], health: 'bad' },
  ];

  it('reads the ends off the grid the way the arrow is drawn', () => {
    expect(edgeEnds(edges[2], tiers)).toEqual({ from: tiers[1], to: tiers[3] });
    // Vertical (cache) arrows go up from the caller below.
    expect(edgeEnds(edges[1], tiers)).toEqual({ from: tiers[1], to: tiers[2] });
    expect(edgeEnds(edges[0], tiers)).toEqual({ from: tiers[0], to: undefined });
  });

  it('names source and target, the rate, the repeats, failures and the fix change', () => {
    const storm: TopologyEdgeView = { ...edges[2], rps: 264.4, retryShare: 191 / 264.4, errorShare: 1 };
    expect(edgeAriaLabel(storm, tiers)).toBe('API to DB: 264 requests a second, including 191 repeats (retries); 100% failing');
    expect(edgeAriaLabel({ ...edges[2], change: '🔧 retry budget 10%' }, tiers)).toBe('API to DB: 60 requests a second; changed by the fix: retry budget 10%');
    expect(edgeAriaLabel({ ...edges[2], rps: 1, retryShare: 1, errorShare: 0.04 }, tiers)).toBe('API to DB: 1 request a second, including 1 repeat (retries)');
    expect(edgeAriaLabel({ ...edges[2], rps: 0 }, tiers)).toBe('API to DB: 0 requests a second');
    expect(edgeAriaLabel({ ...edges[1], cache: true }, tiers)).toBe('API to Cache: 480 lookups a second, 70% hits');
    expect(edgeAriaLabel({ ...edges[1], cache: true, rps: 1 }, tiers)).toBe('API to Cache: 1 lookup a second, 70% hits');
    // Without both boxes on the grid, the name is just the numbers.
    expect(edgeAriaLabel(edges[0], tiers)).toBe('200 requests a second');
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
    // Unhealthy without failure data: drawn as retrying (orange head), neutral track.
    expect(bad.className).toContain('csl-edge--retrying');
    expect(bad.querySelector('path')!.style.fill).toBe('var(--csl-retry)');
    const shaft = within(bad).getByTestId('edge-shaft');
    expect(shaft.style.height).toBe('4px');
    expect(shaft.style.background).toBe('var(--csl-arrow)');
    // Captions with shorter forms render every form; the first is the full one.
    const texts = Array.from(bad.children).map((c) => (c.querySelector('.csl-fit') ?? c).textContent);
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
    expect(within(v).queryByTestId('edge-retry')).toBeNull();
  });

  it('runs the retry band along the side of a vertical arrow', () => {
    render(<TopologyDiagram nodes={[]} edges={[{ ...edges[1], retryShare: 0.3 }]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByTestId('edge-retry').style.width).toBe('30%');
  });

  it('wraps the grid in a horizontal scroll box and shows the one-line key with an optional note and actions', () => {
    const { container, rerender } = render(<TopologyDiagram nodes={nodes} edges={edges} selectedId={null} onSelect={() => {}} />);
    expect(container.querySelector('.csl-topology-scroll > .csl-topology-grid')).not.toBeNull();
    const key = container.querySelector('.csl-topology-legend') as HTMLElement;
    expect(Array.from(key.children).map((c) => c.textContent)).toEqual([
      'Key:',
      'arrow width = requests/s',
      'stripes, ↻ = retries (repeats)',
      '✕red = failing',
      '⚠ = overloaded',
      '⚡ = injected failure',
      'squares = server copies',
    ]);
    // The key never talks about motion, so it holds with reduced motion too.
    expect(key.textContent).not.toMatch(/mov|dash|anim/i);
    expect(screen.queryByText(/Snapshot at/)).toBeNull();
    expect(container.querySelector('.csl-topology-foot--actions')).toBeNull();
    rerender(
      <TopologyDiagram nodes={nodes} edges={edges} selectedId={null} onSelect={() => {}} note="Snapshot at t = 60 s." actions={<button type="button">Edit all settings</button>} />,
    );
    // The note follows the key's items in the same wrapping row (so it can share the key's second line).
    expect(container.querySelector('.csl-topology-legend')!.lastElementChild).toBe(screen.getByText('Snapshot at t = 60 s.'));
    expect(screen.getByText('Snapshot at t = 60 s.').className).toBe('csl-topology-foot__note');
    expect(container.querySelector('.csl-topology-foot--actions .csl-topology-foot__actions')!.textContent).toBe('Edit all settings');
  });

  it('adds a 🔧 entry to the key only when a box or arrow was changed by a fix', () => {
    const keyText = (container: HTMLElement) => container.querySelector('.csl-topology-legend')!.textContent;
    const { container, rerender } = render(<TopologyDiagram nodes={nodes} edges={edges} selectedId={null} onSelect={() => {}} />);
    expect(keyText(container)).not.toContain('🔧');
    rerender(<TopologyDiagram nodes={[{ ...nodes[1], change: 'queue limit 93' }]} edges={edges} selectedId={null} onSelect={() => {}} />);
    expect(keyText(container)).toContain('🔧 = changed by the fix');
    rerender(<TopologyDiagram nodes={nodes} edges={[{ ...edges[2], change: 'retry budget 10%' }]} selectedId={null} onSelect={() => {}} />);
    expect(keyText(container)).toContain('🔧 = changed by the fix');
  });

  it('marks the injected failure, overload and fix change with badges on the box border', () => {
    const db: TopologyNodeView = { ...nodes[2], id: 'db', label: 'DB', col: 7, row: 3, health: 'bad', fault: '⚡ 8× slower', overloaded: true };
    const api: TopologyNodeView = { ...nodes[1], errorShare: 0.62, overloaded: true, change: 'queue limit 93' };
    render(<TopologyDiagram nodes={[db, api, nodes[2]]} edges={[]} selectedId={null} onSelect={() => {}} />);

    const dbBox = screen.getByRole('button', { name: /^DB .*injected failure: 8× slower; overloaded/ });
    expect(dbBox.className).toContain('csl-node--overloaded');
    const top = dbBox.querySelector('.csl-node__edge--top') as HTMLElement;
    expect(top.getAttribute('aria-hidden')).toBe('true');
    expect(top.querySelector('.csl-node__fault')!.textContent).toBe('⚡ 8× slower');
    expect(top.querySelector('.csl-node__badge')).toBeNull();
    const overload = dbBox.querySelector('.csl-node__edge--bottom .csl-node__overload') as HTMLElement;
    expect(overload.textContent).toBe('⚠ overloaded');
    expect(overload.className).not.toContain('crowded');
    expect(dbBox.querySelector('.csl-change')).toBeNull();

    // Failing and overloaded: both shown, on different corners; the fix change shares the bottom edge.
    const apiBox = screen.getByRole('button', { name: /^API .*failing, 62% errors; overloaded.*; changed by the fix: queue limit 93$/ });
    expect(apiBox.querySelector('.csl-node__fault')).toBeNull();
    const badge = apiBox.querySelector('.csl-node__edge--top .csl-node__badge') as HTMLElement;
    expect(badge.textContent).toBe('✕ 62% errors');
    expect(badge.className).not.toContain('crowded');
    const change = apiBox.querySelector('.csl-node__edge--bottom .csl-change') as HTMLElement;
    expect(change.textContent).toBe('🔧 queue limit 93');
    expect(change.title).toBe('Changed by the fix: queue limit 93');
    expect(apiBox.querySelector('.csl-node__overload')!.className).toContain('csl-node__tag--crowded');

    const cache = screen.getByRole('button', { name: /^Cache/ });
    expect(cache.querySelector('.csl-node__edge')).toBeNull();
    expect(cache.className).not.toContain('csl-node--overloaded');
  });

  it('lets the error badge shorten when it shares the top edge with the injected failure', () => {
    const db: TopologyNodeView = { ...nodes[2], id: 'db', label: 'DB', errorShare: 0.12, fault: '8× slower' };
    render(<TopologyDiagram nodes={[db]} edges={[]} selectedId={null} onSelect={() => {}} />);
    const box = screen.getByRole('button', { name: /^DB/ });
    expect(box.querySelector('.csl-node__fault')!.textContent).toBe('⚡ 8× slower');
    const badge = box.querySelector('.csl-node__badge') as HTMLElement;
    expect(badge.className).toContain('csl-node__tag--crowded');
    expect(badge.querySelector('.csl-node__badge-pct')!.textContent).toBe(' 12%');
    expect(badge.querySelector('.csl-node__badge-word')!.textContent).toBe(' errors');
  });

  it('gives every arrow an accessible name with its source and target', () => {
    const tiers: TopologyNodeView[] = [...nodes, { ...nodes[2], id: 'db', label: 'DB', col: 7, row: 3 }];
    const storm: TopologyEdgeView = { ...edges[2], label: '264 rps', detail: 'incl. 191 retries', rps: 264, retryShare: 191 / 264, errorShare: 1, health: 'bad' };
    render(<TopologyDiagram nodes={tiers} edges={[storm, { ...edges[1], cache: true }]} selectedId={null} onSelect={() => {}} />);
    const arrow = screen.getByRole('img', { name: 'API to DB: 264 requests a second, including 191 repeats (retries); 100% failing' });
    expect(arrow).toBe(screen.getByTestId('edge-a-d'));
    expect(screen.getByRole('img', { name: 'API to Cache: 480 lookups a second, 70% hits' })).toBe(screen.getByTestId('edge-a-c'));
    // The visible text is hidden from assistive tech, which gets the name instead.
    for (const id of ['edge-a-d', 'edge-a-c']) {
      for (const part of Array.from(screen.getByTestId(id).children)) expect(part.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('shows what a fix changed under a horizontal arrow and beside a vertical one', () => {
    const budget: TopologyEdgeView = { ...edges[2], change: 'retry budget 10%' };
    const ttl: TopologyEdgeView = { ...edges[1], change: '🔧 TTL 30 s' };
    render(<TopologyDiagram nodes={[]} edges={[budget, ttl, edges[0]]} selectedId={null} onSelect={() => {}} />);
    const h = screen.getByTestId('edge-a-d');
    // The words while they fit the arrow, else only "🔧" (container queries pick one); the words are listed under the diagram.
    expect(Array.from(h.lastElementChild!.children).map((f) => f.textContent)).toEqual(['🔧 retry budget 10%', '🔧']);
    expect(h.lastElementChild!.className).toBe('csl-change csl-edge__change');
    expect(within(screen.getByRole('list', { name: 'Changed by the fix' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '🔧 retry budget 10%',
      '🔧 TTL 30 s',
    ]);
    expect(h.getAttribute('aria-label')).toBe('60 requests a second; changed by the fix: retry budget 10%');
    const v = screen.getByTestId('edge-a-c');
    expect(v.querySelector('.csl-edge__vtext .csl-edge__change')!.textContent).toBe('🔧 TTL 30 s');
    expect(screen.getByTestId('edge-c-g').querySelector('.csl-change')).toBeNull();
  });

  it('lists every change under the diagram, naming the arrow or box it is on', () => {
    const ttl: TopologyEdgeView = { ...edges[1], change: '🔧 TTL 30 s' };
    const db: TopologyNodeView = { ...nodes[1], change: 'queue limit 93' };
    render(<TopologyDiagram nodes={[nodes[0], db, nodes[2]]} edges={[ttl]} selectedId={null} onSelect={() => {}} />);
    expect(within(screen.getByRole('list', { name: 'Changed by the fix' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['🔧 API → Cache: TTL 30 s', '🔧 API: queue limit 93']);
  });

  it('marks failing boxes with a class, a red wash, an error badge and words in the aria-label', () => {
    const failing: TopologyNodeView = { ...nodes[1], errorShare: 0.93 };
    const healthy: TopologyNodeView = { ...nodes[2], errorShare: 0.01 };
    render(<TopologyDiagram nodes={[failing, healthy]} edges={[]} selectedId={null} onSelect={() => {}} editable />);
    const api = screen.getByRole('button', { name: /^Edit API settings\. API \(4 instances\).*failing, 93% errors$/ });
    expect(api.className).toContain('csl-node--failing');
    expect(api.style.getPropertyValue('--csl-node-wash')).toBe('96%');
    expect(api.querySelector('.csl-node__badge')!.textContent).toBe('✕ 93% errors');
    expect(api.querySelector('.csl-node__badge')!.className).not.toContain('crowded');
    expect(within(api).getByText('✎')).toBeTruthy();

    const cache = screen.getByRole('button', { name: /^Edit Cache settings/ });
    expect(cache.className).not.toContain('csl-node--failing');
    expect(cache.style.getPropertyValue('--csl-node-wash')).toBe('0%');
    expect(cache.querySelector('.csl-node__badge')).toBeNull();
    expect(cache.getAttribute('aria-label')).not.toContain('failing');
  });

  it('distinguishes retries (orange band, ↻) from failures (red track, ✕ pill)', () => {
    const retrying: TopologyEdgeView = { ...edges[2], id: 'retries', detail: 'incl. 300 retries', rps: 600, health: 'bad', retryShare: 0.5, errorShare: 0.01 };
    const failing: TopologyEdgeView = { ...edges[2], id: 'fail', detail: 'incl. 900 retries', rps: 1200, health: 'bad', retryShare: 0.75, errorShare: 0.931 };
    const calm: TopologyEdgeView = { ...edges[2], id: 'calm', retryShare: 0, errorShare: 0 };
    render(<TopologyDiagram nodes={[]} edges={[retrying, failing, calm]} selectedId={null} onSelect={() => {}} />);

    const r = screen.getByTestId('edge-retries');
    expect(r.className).toContain('csl-edge--retrying');
    expect(within(r).getByTestId('edge-shaft').style.background).toBe('var(--csl-arrow)');
    expect(within(r).getByTestId('edge-retry').style.height).toBe('50%');
    expect(Array.from(r.querySelectorAll('.csl-edge__detail--retry .csl-fit')).map((e) => e.textContent)).toEqual(['↻ incl. 300 retries', '↻ 300 retries', '↻ 300']);
    expect(r.querySelector('.csl-edge__fail')).toBeNull();

    const f = screen.getByTestId('edge-fail');
    expect(f.className).toContain('csl-edge--failing');
    expect(f.className).not.toContain('csl-edge--retrying');
    expect(within(f).getByTestId('edge-shaft').style.background).toBe('var(--csl-fail)');
    expect(f.querySelector('path')!.style.fill).toBe('var(--csl-fail)');
    expect(within(f).getByTestId('edge-retry').style.height).toBe('75%');
    expect(f.querySelector('.csl-edge__fail')!.textContent).toBe('✕ 93% fail');

    const c = screen.getByTestId('edge-calm');
    expect(c.className).toContain('csl-edge--ok');
    expect(within(c).queryByTestId('edge-retry')).toBeNull();
    expect(c.querySelector('.csl-edge__detail--retry')).toBeNull();
    expect(c.querySelector('path')!.style.fill).toBe('var(--csl-arrow)');
  });

  it('shows a failing cache arrow with the fail pill beside its text', () => {
    const cacheDown: TopologyEdgeView = { ...edges[1], errorShare: 1, retryShare: 0, cache: true };
    render(<TopologyDiagram nodes={[]} edges={[cacheDown]} selectedId={null} onSelect={() => {}} />);
    const v = screen.getByTestId('edge-a-c');
    expect(v.className).toContain('csl-edge--failing');
    expect(within(v).getByTestId('edge-shaft').style.background).toBe('var(--csl-fail)');
    expect(v.querySelector('.csl-edge__vtext .csl-edge__fail')!.textContent).toBe('✕ 100% fail');
  });

  it('moves flow dashes faster for more requests/s, and not at all with no requests', () => {
    const slow: TopologyEdgeView = { ...edges[2], id: 'slow', rps: 10 };
    const fast: TopologyEdgeView = { ...edges[2], id: 'fast', rps: 1000 };
    const idle: TopologyEdgeView = { ...edges[2], id: 'idle', rps: 0 };
    const cache: TopologyEdgeView = { ...edges[1] };
    render(<TopologyDiagram nodes={[]} edges={[slow, fast, idle, cache]} selectedId={null} onSelect={() => {}} />);
    const duration = (id: string) => within(screen.getByTestId(`edge-${id}`)).getByTestId('edge-flow').style.animationDuration;
    expect(duration('slow')).toBe('1.9s');
    expect(duration('fast')).toBe('0.5s');
    expect(duration('a-c')).toBe('0.7s');
    const still = screen.getByTestId('edge-idle');
    expect(within(still).queryByTestId('edge-flow')).toBeNull();
    expect(still.className).toContain('csl-edge--still');
    expect(screen.getByTestId('edge-fast').className).not.toContain('csl-edge--still');
  });

  it('keeps working in the compact layout', () => {
    const failing: TopologyNodeView = { ...nodes[1], errorShare: 0.5 };
    const { container } = render(<TopologyDiagram nodes={[failing]} edges={edges} selectedId={null} onSelect={() => {}} compact />);
    expect(container.querySelector('.csl-topology-grid--compact')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^API/ }).className).toContain('csl-node--failing');
    expect(screen.getAllByTestId('edge-flow')).toHaveLength(3);
  });
});

describe('flowDurationS', () => {
  it('shortens with more requests/s, clamped to 0.4..2.4 s, and is null with no requests', () => {
    expect(flowDurationS(0)).toBeNull();
    expect(flowDurationS(-5)).toBeNull();
    expect(flowDurationS(Number.NaN)).toBeNull();
    expect(flowDurationS(0.5)).toBe(2.4);
    expect(flowDurationS(100)).toBe(1.2);
    expect(flowDurationS(200)).toBe(1);
    expect(flowDurationS(1_000_000)).toBe(0.4);
    expect(flowDurationS(50)!).toBeGreaterThan(flowDurationS(500)!);
  });
});

describe('errorWash', () => {
  it('is zero while healthy and rises with the error share once failing', () => {
    expect(errorWash(undefined)).toBe(0);
    expect(errorWash(0.05)).toBe(0);
    expect(errorWash(0.06)).toBe(44);
    expect(errorWash(1)).toBe(100);
  });
});

describe('edgeKind', () => {
  it('prefers failing over retrying, and treats small retry shares as normal', () => {
    const base = edges[2];
    expect(edgeKind({ ...base, retryShare: 0.04 })).toBe('ok');
    expect(edgeKind({ ...base, retryShare: 0.2 })).toBe('retrying');
    expect(edgeKind({ ...base, health: 'bad' })).toBe('retrying');
    expect(edgeKind({ ...base, retryShare: 0.9, errorShare: 0.5 })).toBe('failing');
  });
});

describe('arrow captions that fit', () => {
  it('offers shorter forms of retry and rate captions, longest first', () => {
    expect(detailForms('incl. 1015 retries', true)).toEqual(['↻ incl. 1015 retries', '↻ 1015 retries', '↻ 1015']);
    expect(detailForms('no retries', false)).toEqual(['no retries', '↻ 0']);
    expect(detailForms('62% fail', false)).toEqual(['62% fail']);
    expect(detailForms('19% hits', true)).toEqual(['↻ 19% hits']);
    expect(rateForms('1015 rps')).toEqual(['1015 rps', '1015']);
    expect(rateForms('316 lookups/s')).toEqual(['316 lookups/s', '316']);
    expect(rateForms('lots')).toEqual(['lots']);
  });

  it('estimates the width each form needs, in 10 px steps within 40..200', () => {
    expect(fitBucket('↻ 44', 'detail')).toBe(40);
    expect(fitBucket('↻ 44 retries', 'detail')).toBe(80);
    expect(fitBucket('1015 rps', 'label')).toBe(80);
    expect(fitBucket('x'.repeat(60), 'detail')).toBe(200);
  });

  it('tags each form with the widths it shows between, so exactly one fits', () => {
    const edge: TopologyEdgeView = { ...edges[2], id: 'r', detail: 'incl. 44 retries', rps: 400, retryShare: 0.1 };
    render(<TopologyDiagram nodes={[]} edges={[edge]} selectedId={null} onSelect={() => {}} />);
    const forms = Array.from(screen.getByTestId('edge-r').querySelectorAll('.csl-edge__detail .csl-fit'));
    expect(forms.map((f) => f.className)).toEqual(['csl-fit csl-fit--min120', 'csl-fit csl-fit--min80 csl-fit--max120', 'csl-fit csl-fit--max80']);
    // A vertical (cache) arrow is not a size container, so it shows only the full caption.
    render(<TopologyDiagram nodes={[]} edges={[{ ...edges[1], detail: 'no retries' }]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByTestId('edge-a-c').querySelector('.csl-fit')).toBeNull();
    expect(within(screen.getByTestId('edge-a-c')).getByText('no retries')).toBeTruthy();
  });
});

describe('box names', () => {
  it('keeps the accessible name still while the box is focused, and refreshes it on the next focus', () => {
    const { rerender } = render(<TopologyDiagram nodes={nodes} edges={[]} selectedId={null} onSelect={() => {}} />);
    const api = screen.getByRole('button', { name: /^API/ });
    fireEvent.focus(api);
    const busier = nodes.map((n) => (n.id === 'api' ? { ...n, lines: ['workers 50%', 'CPU 3%'] as [string, string] } : n));
    rerender(<TopologyDiagram nodes={busier} edges={[]} selectedId={null} onSelect={() => {}} />);
    expect(api.getAttribute('aria-label')).toMatch(/workers 100%/);
    fireEvent.blur(api);
    expect(api.getAttribute('aria-label')).toMatch(/workers 50%/);
  });

  it('shortens long names in a long built chain from the middle, keeping the end, with the full name as tooltip', () => {
    expect(keepEnd('App server 2')).toBe('App server 2');
    expect(keepEnd('Payments gateway service 12')).toBe('Payments…service 12');
    expect(keepEnd('abcdefghij', 5)).toBe('ab…ij');
    expect(keepEnd('Payments gateway service')).toBe('Payments…service'); // a word start a few letters ahead
    const chain: TopologyNodeView[] = Array.from({ length: 6 }, (_, i) => ({ ...nodes[1], id: `n${i}`, label: `Payments gateway service ${i + 1}`, col: 1 + 2 * i, row: 3 }));
    expect(isLongChain(chain)).toBe(true);
    expect(isLongChain(nodes)).toBe(false);
    const { container } = render(<TopologyDiagram nodes={chain} edges={[]} selectedId={null} onSelect={() => {}} />);
    expect(container.querySelector('.csl-topology-grid--long')).not.toBeNull();
    const label = container.querySelector('.csl-node__label') as HTMLElement;
    expect(label.textContent).toBe('Payments…service 1');
    expect(label.title).toBe('Payments gateway service 1');
    expect(gridStyle(chain)!.gridTemplateColumns).toMatch(/^minmax\(76px, 1fr\) minmax\(40px, 0.55fr\)/);
    expect(gridStyle(nodes)).toBeUndefined();
  });
});

describe('sideways scrolling on narrow screens', () => {
  it('fades the side with more and shows a hint while the diagram is wider than its frame', () => {
    const { container } = render(<TopologyDiagram nodes={nodes} edges={edges} selectedId={null} onSelect={() => {}} />);
    expect(screen.queryByText(/Scroll sideways/)).toBeNull(); // jsdom: nothing overflows
    const scroller = container.querySelector('.csl-topology-scroll') as HTMLElement;
    Object.defineProperty(scroller, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(scroller, 'clientWidth', { value: 300, configurable: true });
    fireEvent.scroll(scroller);
    expect(screen.getByText(/Scroll sideways to see every part/).textContent).toMatch(/→$/);
    expect(container.querySelector('.csl-topology-fade--right')).not.toBeNull();
    scroller.scrollLeft = 600;
    fireEvent.scroll(scroller);
    expect(container.querySelector('.csl-topology-fade--left')).not.toBeNull();
    expect(container.querySelector('.csl-topology-fade--right')).toBeNull();
    expect(screen.getByText(/Scroll sideways/).textContent).toMatch(/←$/);
  });
});
