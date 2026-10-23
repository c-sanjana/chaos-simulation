/**
 * Messages exchanged between the UI thread and simulation workers.
 * Everything here must be plain data: messages are structured-cloned, which drops class methods.
 */
export type WorkerRequest = { type: 'ping'; id: number };
export type WorkerResponse = { type: 'pong'; id: number; crossOriginIsolated: boolean };
