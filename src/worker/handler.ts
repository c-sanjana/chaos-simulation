import { executeJob } from './jobs';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * Answers one request. The worker entry point posts the reply; the in-process pool calls this
 * directly. A job that throws (e.g. an invalid config) becomes an `error` reply rather than
 * crashing the worker. With `post`, a long job also sends `progress` messages through it while it runs.
 */
export function handleRequest(msg: WorkerRequest, crossOriginIsolated: boolean, post?: (progress: WorkerResponse) => void): WorkerResponse {
  if (msg.type === 'ping') return { type: 'pong', id: msg.id, crossOriginIsolated };
  const { id } = msg;
  try {
    return { type: 'result', id, result: executeJob(msg.job, post && ((fraction) => post({ type: 'progress', id, fraction }))) };
  } catch (e) {
    return { type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) };
  }
}
