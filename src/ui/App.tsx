import { useEffect, useState } from 'react';
import type { WorkerResponse } from '../worker/protocol';

type Status = 'starting' | 'ok' | 'failed';

/** Creates the simulation worker. Isolated so tests can inject a fake. */
export function createSimWorker(): Worker {
  return new Worker(new URL('../worker/sim.worker.ts', import.meta.url), { type: 'module' });
}

/** P0 smoke-test page: proves the hosted build can start a module worker. */
export function App({ makeWorker = createSimWorker }: { makeWorker?: () => Worker }) {
  const [status, setStatus] = useState<Status>('starting');

  useEffect(() => {
    let worker: Worker;
    try {
      worker = makeWorker();
    } catch {
      setStatus('failed');
      return;
    }
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === 'pong') setStatus('ok');
    };
    worker.onerror = () => setStatus('failed');
    worker.postMessage({ type: 'ping', id: 1 });
    return () => worker.terminate();
  }, [makeWorker]);

  return (
    <main style={{ fontFamily: "'IBM Plex Sans', system-ui, sans-serif", padding: 24 }}>
      <h1>Chaos Simulation Lab</h1>
      <p data-testid="worker-status">
        {status === 'starting' && 'Starting simulation worker…'}
        {status === 'ok' && 'Worker OK'}
        {status === 'failed' && 'Worker failed to start'}
      </p>
    </main>
  );
}
