/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse } from './protocol';

// Thin entry point: all logic lives in tested modules; this file only wires messages.
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'ping') {
    const reply: WorkerResponse = { type: 'pong', id: msg.id, crossOriginIsolated: self.crossOriginIsolated };
    self.postMessage(reply);
  }
};
