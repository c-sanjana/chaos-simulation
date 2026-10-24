/**
 * Messages exchanged between the UI thread and simulation workers.
 * Everything here must be plain data: messages are structured-cloned, which drops class methods.
 *
 * - ping → pong: start-up smoke test (P0).
 * - job → progress* then result | error: run one job; `id` matches the replies to its request.
 *   `progress` (fraction done, 0–1) is sent now and then while a long job runs.
 */
import type { Job, JobResult } from './jobs';

export type WorkerRequest = { type: 'ping'; id: number } | { type: 'job'; id: number; job: Job };

export type WorkerResponse =
  | { type: 'pong'; id: number; crossOriginIsolated: boolean }
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'result'; id: number; result: JobResult }
  | { type: 'error'; id: number; message: string };
