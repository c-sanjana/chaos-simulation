import { expectedRequests, LIMITS, MAX_REQUESTS_PER_RUN, runSizeProblem } from './limits';

describe('run size limits', () => {
  it('allow the largest traffic for the longest run, and nothing bigger', () => {
    expect(MAX_REQUESTS_PER_RUN).toBe(3_000_000);
    expect(expectedRequests(200, 120_000)).toBe(24_000);
    expect(runSizeProblem(LIMITS.maxRps, LIMITS.maxDurationS * 1000)).toBeNull();
    expect(runSizeProblem(70_000, 120_000)).toBe(
      'This many requests would take too long to simulate in a browser: 70000 req/s for 120 s is about 8.4 million requests, and the most is 3 million. Lower the traffic or shorten the run.',
    );
  });
});
