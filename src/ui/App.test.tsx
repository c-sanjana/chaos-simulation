import { render, screen, waitFor, act } from '@testing-library/react';
import { App } from './App';

/** Minimal stand-in for a Worker: lets tests drive onmessage/onerror. */
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  constructor(private reply: 'pong' | 'error' | 'silent') {}
  postMessage() {
    queueMicrotask(() => {
      if (this.reply === 'pong') this.onmessage?.({ data: { type: 'pong', id: 1, crossOriginIsolated: false } } as MessageEvent);
      if (this.reply === 'error') this.onerror?.();
    });
  }
  terminate() { this.terminated = true; }
}

describe('App worker smoke test', () => {
  it('shows Worker OK when the worker replies', async () => {
    render(<App makeWorker={() => new FakeWorker('pong') as unknown as Worker} />);
    await waitFor(() => expect(screen.getByTestId('worker-status').textContent).toBe('Worker OK'));
  });

  it('shows a failure when the worker errors', async () => {
    render(<App makeWorker={() => new FakeWorker('error') as unknown as Worker} />);
    await waitFor(() => expect(screen.getByTestId('worker-status').textContent).toBe('Worker failed to start'));
  });

  it('shows a failure when the worker cannot be constructed', async () => {
    render(<App makeWorker={() => { throw new Error('no workers'); }} />);
    await waitFor(() => expect(screen.getByTestId('worker-status').textContent).toBe('Worker failed to start'));
  });

  it('shows starting state, then terminates the worker on unmount', async () => {
    const fake = new FakeWorker('silent');
    const { unmount } = render(<App makeWorker={() => fake as unknown as Worker} />);
    expect(screen.getByTestId('worker-status').textContent).toBe('Starting simulation worker…');
    await act(async () => {});
    unmount();
    expect(fake.terminated).toBe(true);
  });
});

describe('createSimWorker', () => {
  it('starts the simulation worker as an ES module', async () => {
    const { createSimWorker } = await import('./App');
    const calls: Array<[URL, WorkerOptions]> = [];
    vi.stubGlobal('Worker', class { constructor(url: URL, opts: WorkerOptions) { calls.push([url, opts]); } });
    createSimWorker();
    vi.unstubAllGlobals();
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toContain('sim.worker');
    expect(calls[0][1]).toEqual({ type: 'module' });
  });
});
