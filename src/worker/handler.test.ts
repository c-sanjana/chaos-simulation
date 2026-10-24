import type { RunConfig } from '../engine/config';
import { singleTier } from '../engine/testConfigs';
import { handleRequest } from './handler';
import * as jobs from './jobs';

vi.mock('./jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./jobs')>();
  return { ...actual, executeJob: vi.fn(actual.executeJob) };
});

const config: RunConfig = singleTier(20, { kind: 'exponential', meanMs: 5 }, 2000);

describe('handleRequest', () => {
  it('answers ping with pong, reporting cross-origin isolation', () => {
    expect(handleRequest({ type: 'ping', id: 3 }, true)).toEqual({ type: 'pong', id: 3, crossOriginIsolated: true });
  });

  it('runs a job and replies with its result', () => {
    const job = { kind: 'cell', config } as const;
    expect(handleRequest({ type: 'job', id: 7, job }, false)).toEqual({ type: 'result', id: 7, result: jobs.executeJob(job) });
  });

  it('sends progress for a long job through `post`, tagged with the job id', () => {
    vi.mocked(jobs.executeJob).mockImplementationOnce((_job, onProgress) => {
      onProgress?.(0.4);
      return { verdict: 'recovered', recoveryMs: 0, failedRequests: 0 };
    });
    const post = vi.fn();
    expect(handleRequest({ type: 'job', id: 5, job: { kind: 'cell', config } }, false, post)).toEqual({ type: 'result', id: 5, result: { verdict: 'recovered', recoveryMs: 0, failedRequests: 0 } });
    expect(post).toHaveBeenCalledWith({ type: 'progress', id: 5, fraction: 0.4 });
  });

  it('replies with an error instead of throwing when the job fails', () => {
    const reply = handleRequest({ type: 'job', id: 8, job: { kind: 'cell', config: { ...config, seed: 1.5 } } }, false);
    expect(reply).toEqual({ type: 'error', id: 8, message: 'Invalid config: seed must be an integer (got 1.5)' });
  });

  it('reports a non-Error throw as text', () => {
    vi.mocked(jobs.executeJob).mockImplementationOnce(() => {
      throw 'boom';
    });
    expect(handleRequest({ type: 'job', id: 9, job: { kind: 'cell', config } }, false)).toEqual({ type: 'error', id: 9, message: 'boom' });
  });
});
