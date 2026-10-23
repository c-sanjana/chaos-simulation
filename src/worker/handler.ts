import { executeJob } from './jobs';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * Answers one request. The worker entry point posts the reply; the in-process pool calls this
 * directly. A job that throws (e.g. an invalid config) becomes an `error` reply rather than
 * crashing the worker.
 */
export function handleRequest(msg: WorkerRequest, crossOriginIsolated: boolean): WorkerResponse {
  if (msg.type === 'ping') return { type: 'pong', id: msg.id, crossOriginIsolated };
  try {
    return { type: 'result', id: msg.id, result: executeJob(msg.job) };
  } catch (e) {
    return { type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) };
  }
}
