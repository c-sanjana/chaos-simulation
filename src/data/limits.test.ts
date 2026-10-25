import { callsPerRequest } from '../analysis/helpers';
import { MAX_RETRIES, type RunConfig, type TierConfig } from '../engine/config';
import { call, tier } from '../engine/testConfigs';
import { FIELD_LIMITS } from '../ui/fieldLimits';
import { buildRunConfig } from './buildConfig';
import { expectedRequests, LIMITS, MAX_CALLS_PER_RUN, MAX_REQUESTS_PER_RUN, runSizeProblem } from './limits';
import { retryStorm } from './scenarios';
import { webChain } from './topologies';

describe('run size limits', () => {
  it('allow the largest traffic for the longest run, and nothing bigger', () => {
    expect(MAX_REQUESTS_PER_RUN).toBe(3_000_000);
    expect(expectedRequests(200, 120_000)).toBe(24_000);
    expect(runSizeProblem(LIMITS.maxRps, LIMITS.maxDurationS * 1000)).toBeNull();
    expect(runSizeProblem(70_000, 120_000)).toBe(
      'This many requests would take too long to simulate in a browser: 70000 req/s for 120 s is about 8.4 million requests, and the most is 3 million. Lower the traffic or shorten the run.',
    );
  });

  it('count the calls each request makes: the presets fit at the largest settings, a mesh does not', () => {
    // The presets: load balancer, app server, its cache lookup and the database.
    const preset = callsPerRequest(buildRunConfig(webChain, retryStorm));
    expect(preset).toBe(4);
    expect(runSizeProblem(LIMITS.maxRps, LIMITS.maxDurationS * 1000, preset)).toBeNull();
    expect(MAX_CALLS_PER_RUN).toBe(30_000_000);
    // Every part calls every part of the next column: 4 wide, 5 deep is 4^5 database calls per request.
    const col = (k: number) => Array.from({ length: 4 }, (_, i) => `n${k}_${i}`);
    const fixed = { kind: 'fixed', ms: 1 } as const;
    const calls = (ids: string[]) => ({ downstream: call(ids[0]), moreDownstream: ids.slice(1).map((id) => call(id)), fanOut: 'parallel' as const });
    const tiers: TierConfig[] = [tier('entry', fixed, calls(col(1)))];
    for (let k = 1; k < 5; k++) for (const id of col(k)) tiers.push(tier(id, fixed, calls(col(k + 1))));
    for (const id of col(5)) tiers.push(tier(id, fixed, { downstream: call('db') }));
    const mesh: RunConfig = { seed: 1, durationMs: 30_000, client: { rps: 10, call: call('entry') }, tiers: [...tiers, tier('db', fixed)] };
    const perRequest = callsPerRequest(mesh);
    expect(perRequest).toBe(1 + 4 + 16 + 64 + 256 + 1024 + 1024);
    expect(runSizeProblem(10, 30_000, perRequest)).toBeNull();
    expect(runSizeProblem(1000, 600_000, perRequest)).toBe(
      'This system makes too many calls to simulate in a browser: each request goes on to about 2,389 calls between its parts, so 1000 req/s for 600 s is about 1,433.4 million calls, and the most is 30 million. Make fewer calls per request (fewer arrows from each part), lower the traffic or shorten the run.',
    );
    expect(runSizeProblem(10, 30_000, Infinity)).toMatch(/each request goes on to more calls than can be counted between its parts, so 10 req\/s for 30 s is more than can be counted,/);
  });

  it('stop retries at the same number in the engine and in the forms', () => {
    expect(MAX_RETRIES).toBe(10);
    expect(FIELD_LIMITS.maxRetries).toBe(MAX_RETRIES);
  });
});
