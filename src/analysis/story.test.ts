import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { Fault, RunConfig } from '../engine/config';
import { call, tier } from '../engine/testConfigs';
import { leafCapacityRps } from './helpers';
import { buildStory, type StoryStep } from './story';
import { analyzed, retryStormRun } from './testRuns';

const labels = Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label]));
const storyOf = (config: RunConfig) => {
  const { run, analysis } = analyzed(config);
  return buildStory(run, config, analysis, labels);
};
const texts = (steps: StoryStep[]) => steps.map((s) => s.text);
/** The default retry storm with other failures, and optionally a different length or retries. */
const storm = (faults: Fault[], over: { durationMs?: number; retries?: number } = {}): RunConfig => ({
  ...buildRunConfig(webChain, retryStorm, { retries: over.retries }),
  ...(over.durationMs === undefined ? {} : { durationMs: over.durationMs }),
  faults,
});
const slowDb = (startMs: number, endMs: number, factor = 8): Fault => ({ tier: 'db', kind: 'slow', factor, startMs, endMs });

/** Newcomer language: short sentences, none of the words an SRE would use. */
function expectPlain(steps: StoryStep[]) {
  expect(steps.map((s) => s.tMs)).toEqual([...steps.map((s) => s.tMs)].sort((a, b) => a - b));
  for (const { text } of steps) {
    for (const sentence of text.split(/(?<=\.) /)) expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(25);
    expect(text).not.toMatch(/p99|p50|rps|tier|timeout|timed out|retr|capacity|latency|throughput|saturat/i);
    expect(text).toMatch(/[.]$/);
  }
}

describe('buildStory on the retry storm', { timeout: 60_000 }, () => {
  it('tells the default stuck run step by step, revealed as the replay shows each part', () => {
    const { config, run, analysis } = retryStormRun({ retries: 3 });
    const story = buildStory(run, config, analysis, labels);
    expect(story).toEqual([
      { tMs: 30_000, tone: 'fault', text: 'At 30 s the database became 8× slower for 5 seconds.' },
      { tMs: 31_000, tone: 'info', text: 'The API gives up on a database answer after 1 s and asks again, up to 3 more times.' },
      { tMs: 33_000, tone: 'bad', text: 'So the database got more requests than it can handle, even at full speed (about 160 a second).' },
      { tMs: 35_000, tone: 'info', text: 'At 35 s the database was back to normal speed — but the pile of repeated requests was still there.' },
      {
        tMs: 58_000,
        tone: 'bad',
        text:
          "Almost all the database's work was for requests nobody was waiting for any more, so new ones were given up on and asked again too. " +
          "Cache entries ran out and weren't refilled, sending even more requests to the database.",
      },
      { tMs: 117_000, tone: 'bad', text: 'It never recovered: still failing at the end of the run, with the database getting up to 4.8× the work it can handle.' },
    ]);
    expectPlain(story);

    // The times and numbers come from the run.
    const db = run.tiers.db;
    const load = (s: number) => db.arrivalsFirst[s] + db.arrivalsRetry[s];
    const capacity = leafCapacityRps(config.tiers.find((t) => t.id === 'db')!)!;
    expect(db.latencyP99Ms.findIndex((p, s) => s >= 30 && p > 1000)).toBe(31);
    expect(db.arrivalsFirst.findIndex((_, s) => s >= 30 && load(s) > capacity)).toBe(33);
    expect(Math.round(capacity / 10) * 10).toBe(160);
    const peak = Math.max(...Array.from({ length: 117 - 35 }, (_, i) => load(35 + i))) / capacity;
    expect(peak.toFixed(1)).toBe('4.8');
    expect(story.at(-1)!.tMs).toBe(analysis.recovery.judgedUntilMs);
  });

  it('tells a recovered run (no retries) and says the slowed database could serve less', () => {
    const { config, run, analysis } = retryStormRun({ retries: 0 });
    const story = buildStory(run, config, analysis, labels);
    expect(story).toEqual([
      { tMs: 30_000, tone: 'fault', text: 'At 30 s the database became 8× slower for 5 seconds.' },
      { tMs: 30_000, tone: 'bad', text: `Slowed down, the database could serve only about 20 requests a second, but it got ${run.tiers.db.arrivalsFirst[30]}.` },
      { tMs: 31_000, tone: 'info', text: 'The API gives up on a database answer after 1 s and does not ask again, so those users got an error.' },
      { tMs: 35_000, tone: 'info', text: 'At 35 s the database was back to normal speed and started on the requests that had piled up.' },
      { tMs: analysis.recovery.recoveredAtMs, tone: 'good', text: 'It worked through the backlog and was back to normal 3 s after the failure ended.' },
    ]);
    expectPlain(story);
  });

  it('with one retry, the repeats push the database over only after the failure, and it recovers', () => {
    const story = storyOf(buildRunConfig(webChain, retryStorm, { retries: 1 }));
    expect(texts(story)).toContain('The API gives up on a database answer after 1 s and asks again once.');
    const over = story.find((s) => s.text.startsWith('Then the requests asked again pushed the database past what it can handle'))!;
    expect(over.tMs).toBeGreaterThan(35_000);
    expect(story.at(-1)).toMatchObject({ tone: 'good', text: expect.stringMatching(/^It worked through the backlog and was back to normal \d+ s after the failure ended\.$/) });
    expectPlain(story);
  });

  it('a database outage: errors come straight away, and load during the outage is not called too much', () => {
    const story = storyOf(storm([{ tier: 'db', kind: 'dead', startMs: 30_000, endMs: 35_000 }]));
    expect(texts(story)).toEqual([
      'At 30 s the database went down for 5 seconds.',
      'The API gets an error from the database straight away and asks again, up to 3 more times.',
      'At 35 s the database was back up.',
      'It was back to normal 1 s after the failure ended.',
    ]);
    const noRetries = storyOf(storm([{ tier: 'db', kind: 'dead', startMs: 30_000, endMs: 35_000 }], { retries: 0 }));
    expect(texts(noRetries)).toContain('The API gets an error from the database straight away and does not ask again, so those users got an error.');
    expect(noRetries.at(-1)).toEqual({ tMs: 35_000, tone: 'good', text: 'It was back to normal as soon as the failure ended.' });
    expectPlain(story);
  });

  it('a cache outage sends lookups to the database, and the cache comes back empty', () => {
    const story = storyOf(storm([{ tier: 'cache', kind: 'dead', startMs: 30_000, endMs: 35_000, flushAtEnd: true }]));
    expect(texts(story)).toContain('Without the cache, the API sent every lookup to the database instead.');
    expect(texts(story)).toContain('At 35 s the cache was back up, but empty — and the pile of repeated requests was still there.');
    expect(texts(story).some((t) => /Cache entries ran out/.test(t))).toBe(false); // the failure step said so already
    expect(story.at(-1)!.text).toMatch(/^It never recovered/);
    expectPlain(story);
  });

  it('a slow cache: the API gives up on it and asks the database instead', () => {
    const story = storyOf(storm([{ tier: 'cache', kind: 'slow', factor: 200, startMs: 30_000, endMs: 35_000 }]));
    expect(texts(story)).toContain('The API gives up on the cache after 100 ms and asks the database instead.');
    expectPlain(story);
  });

  it('without a cache there is nothing about cache entries', () => {
    const config = storm([slowDb(30_000, 35_000)]);
    const noCache: RunConfig = { ...config, client: { ...config.client, rps: 100 }, tiers: config.tiers.filter((t) => t.id !== 'cache').map((t) => (t.id === 'api' ? { ...t, cacheAside: undefined } : t)) };
    const story = storyOf(noCache);
    expect(story.length).toBeGreaterThanOrEqual(3);
    expect(story.length).toBeLessThanOrEqual(6);
    expect(texts(story).some((t) => /[Cc]ache/.test(t))).toBe(false);
    expectPlain(story);
  });

  it('a failure after the end of the run never happens', () => {
    for (const config of [storm([slowDb(40_000, 45_000)], { durationMs: 30_000 }), storm([slowDb(30_000, 35_000)], { durationMs: 30_000 })]) {
      const start = config.faults![0].startMs / 1000;
      expect(storyOf(config)).toEqual([
        { tMs: 0, tone: 'info', text: `The failure is set to start at ${start} s, but this run ends at 30 s, so it never happens.` },
        { tMs: 0, tone: 'good', text: 'Nothing went wrong.' },
      ]);
    }
    expect(texts(storyOf(storm([], { durationMs: 10_000 })))).toEqual(['Nothing is set to fail in this run.', 'Nothing went wrong.']);
  });

  it('a failure lasting to the end of the run leaves no time to recover', () => {
    for (const endMs of [40_000, 50_000]) {
      const story = storyOf(storm([slowDb(30_000, endMs)], { durationMs: 40_000 }));
      expect(story[0].text).toBe('At 30 s the database became 8× slower and stayed that way until the run ended.');
      expect(texts(story).some((t) => /back to normal speed/.test(t))).toBe(false);
      expect(story.at(-1)).toEqual({ tMs: 40_000, tone: 'bad', text: 'The failure was still going on when the run ended, so there was no time to recover.' });
      expectPlain(story);
    }
  });

  it('a short run judged before its end still tells the stuck verdict at the end of the judged range', () => {
    const story = storyOf(storm([slowDb(30_000, 35_000)], { durationMs: 40_000 }));
    expect(story.at(-1)).toMatchObject({ tMs: 37_000, tone: 'bad', text: expect.stringMatching(/^It never recovered: still failing at the end of the run/) });
    // Without the cache step, the wasted work is a step of its own, shortly after the failure.
    expect(story.find((s) => s.text.includes('nobody was waiting for'))!.tMs).toBe(36_000);
  });

  it('an unaffected run says it coped; an overloaded one says so first', () => {
    const mild = storyOf(storm([slowDb(30_000, 31_500, 1.1)]));
    expect(mild[0].text).toBe('At 30 s the database became 1.1× slower for 1.5 s.');
    expect(mild.at(-1)).toEqual({ tMs: 31_500, tone: 'good', text: 'It coped: requests did just as well as they would have without the failure.' });
    expect(storyOf(storm([slowDb(30_000, 31_000, 1.1)]))[0].text).toBe('At 30 s the database became 1.1× slower for 1 second.');

    const config = storm([slowDb(30_000, 35_000)]);
    const overloaded = storyOf({ ...config, tiers: config.tiers.map((t) => (t.id === 'db' ? { ...t, coresPerInstance: 1 } : t)) });
    expect(overloaded[0]).toEqual({ tMs: 0, tone: 'bad', text: 'Even without the failure, this much traffic is more than the system can handle, so requests fail anyway.' });
  });

  it('mentions a retry budget in plain words', () => {
    const config = storm([slowDb(30_000, 35_000)]);
    const budgeted = { ...config, tiers: config.tiers.map((t) => (t.id === 'api' ? { ...t, downstream: { ...t.downstream!, retryBudget: 0.1 } } : t)) };
    expect(texts(storyOf(budgeted))).toContain('The API gives up on a database answer after 1 s and asks again, up to 3 more times, as long as repeats stay under 10% of its requests.');
  });

  it('a failure on a tier that calls others: the caller notices, but there is no load step', () => {
    const story = storyOf(storm([{ tier: 'api', kind: 'slow', factor: 1000, startMs: 30_000, endMs: 35_000 }]));
    expect(texts(story)).toContain('The gateway gives up on an API answer after 2 s and does not ask again, so those users got an error.');
    expect(story.some((s) => /requests a second/.test(s.text))).toBe(false);
  });

  it('an API instance going down: errors only for requests sent to it', () => {
    const story = storyOf(storm([{ tier: 'api', instance: 1, kind: 'dead', startMs: 30_000, endMs: 35_000 }]));
    expect(texts(story).slice(0, 3)).toEqual([
      'At 30 s one of the 4 API instances went down for 5 seconds.',
      'The gateway gets an error for requests sent to that instance straight away and does not ask again, so those users got an error.',
      'At 35 s one of the 4 API instances was back up.',
    ]);
  });
});

describe('buildStory on small systems', { timeout: 60_000 }, () => {
  /** Users call a two-instance service directly. */
  const direct = (fault: Fault, timeoutMs: number | null = 200): RunConfig => ({
    seed: 3,
    durationMs: 30_000,
    client: { rps: 250, call: call('svc', { timeoutMs }) },
    tiers: [tier('svc', { kind: 'fixed', ms: 10 }, { instances: 2, workersPerInstance: 2 })],
    faults: [fault],
  });

  it('one slowed or failed instance halves what the service can serve; users see the errors', () => {
    const slowed = texts(storyOf(direct({ tier: 'svc', instance: 0, kind: 'slow', factor: 10, startMs: 10_000, endMs: 15_000 })));
    expect(slowed[0]).toBe('At 10 s one of the 2 svc instances became 10× slower for 5 seconds.');
    expect(slowed).toContain('The client gives up on a svc answer after 200 ms and does not ask again, so those users saw an error.');
    expect(slowed.some((t) => /^With one instance slowed, the svc could serve only about 220 requests a second, but it got \d+\.$/.test(t))).toBe(true);

    const down = texts(storyOf(direct({ tier: 'svc', instance: 0, kind: 'dead', startMs: 10_000, endMs: 15_000 })));
    expect(down.some((t) => /^With one instance down, the svc could serve only about 200 requests a second, but it got \d+\.$/.test(t))).toBe(true);
  });

  it('a caller that waits forever never gives up, so there is no giving-up step', () => {
    const story = texts(storyOf(direct({ tier: 'svc', kind: 'slow', factor: 3, startMs: 10_000, endMs: 15_000 }, null)));
    expect(story.some((t) => /gives up/.test(t))).toBe(false);
  });

  it('says the load went over afterwards without blaming repeats when there were none', () => {
    const { config, run, analysis } = retryStormRun({ retries: 0 });
    const tweaked = structuredClone(run);
    tweaked.tiers.db.arrivalsFirst[40] = 1000;
    expect(texts(buildStory(tweaked, config, analysis, labels))).toContain('Then the database got more requests than it can handle, even at full speed (about 160 a second).');
  });

  it('quotes the share of wasted work when it is not almost all', () => {
    const config = storm([slowDb(30_000, 35_000)], { durationMs: 40_000 });
    const { run, analysis } = analyzed(config);
    const tweaked = structuredClone(run);
    tweaked.tiers.db.wastedMs[36] = 0.6 * tweaked.tiers.db.busyCoresAvg[36] * 1000;
    expect(texts(buildStory(tweaked, config, analysis, labels))).toContain("60% of the database's work was for requests nobody was waiting for any more, so new ones were given up on and asked again too.");
  });
});
