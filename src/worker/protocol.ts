/**
 * Messages exchanged between the UI thread and simulation workers.
 * Everything here must be plain data: messages are structured-cloned, which drops class methods.
 *
 * - ping → pong: start-up smoke test (P0).
 * - job → result | error: run one job; `id` matches the reply to its request.
 */
import type { Job, JobResult } from './jobs';

export type WorkerRequest = { type: 'ping'; id: number } | { type: 'job'; id: number; job: Job };

export type WorkerResponse =
  | { type: 'pong'; id: number; crossOriginIsolated: boolean }
  | { type: 'result'; id: number; result: JobResult }
  | { type: 'error'; id: number; message: string };
