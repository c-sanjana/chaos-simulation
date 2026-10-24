/// <reference lib="webworker" />
import { handleRequest } from './handler';
import type { WorkerRequest } from './protocol';

// Thin entry point: all logic lives in tested modules; this file only wires messages.
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  self.postMessage(handleRequest(event.data, self.crossOriginIsolated, (progress) => self.postMessage(progress)));
};
