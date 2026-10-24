import { analyzed } from '../analysis/testRuns';
import { chainGraph } from '../builder/testGraphs';
import { buildRunConfig } from '../data/buildConfig';
import { cacheRestart, gatewaySlow, retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RunConfig } from '../engine/config';
import { customSystem } from '../ui/system';
import { candidateFixes } from './candidates';
import { FIX_CATALOG, type FixKind } from './catalog';
import { explainFix } from './explain';
import { fixHelped } from './rank';

const labels = Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label]));

/** Explains candidate `id` for `config`, with "helped" judged as the ranking does. */
function explain(config: RunConfig, id: string, labelsFor = labels) {
  const before = analyzed(config);
  const candidate = candidateFixes(config, before.analysis.signals, labelsFor).find((c) => c.id === id)!;
  const after = analyzed(candidate.config);
  const kind = FIX_CATALOG.find((d) => d.id === id)!.kind;
  const helped = fixHelped(before.analysis.recovery, after.analysis.recovery);
  return { helped, before, after, ...explainFix(kind, helped, { config, result: before }, { config: candidate.config, result: after }, labelsFor) };
}

describe('explainFix', { timeout: 120_000 }, () => {
  const storm = buildRunConfig(webChain, retryStorm);

  it("says why a retry fix didn't help: the other layers still retry, so the database still had more than it can handle", () => {
    const e = explain(storm, 'retry-budget');
    expect(e.helped).toBe(false);
    expect(e.title).toBe("Why it didn't help here");
    expect(e.text).toMatch(/^Users' apps \(5×\), the gateway \(3×\) and the app server \(1×\) still retry, so the database still had up to \d\.\d× the work it can handle after the failure ended\./);
    // The number is measured: the most work the database took on in a second after the failure ended.
    const capacity = (4 * 1000) / (20 * Math.exp(Math.log(5) ** 2 / (2 * 2.3263478740408408 ** 2)));
    const db = e.after.run.tiers.db;
    let peak = 0;
    for (let s = 35; s < Math.floor(e.after.analysis.recovery.judgedUntilMs / 1000); s++) peak = Math.max(peak, db.arrivalsFirst[s] + db.arrivalsRetry[s] - db.rejected[s]);
    expect(Number(/up to (\d\.\d)×/.exec(e.text)![1])).toBeCloseTo(peak / capacity, 1);
    // Capping one call at "at most double" is contradicted by a database running far above its normal load.
    expect(e.refuted).toContain('loadOverDouble');
  });

  it('says every repeat is still sent for backoff with jitter, and names an emptied cache', () => {
    const e = explain(storm, 'jitter-backoff');
    expect(e.text).toMatch(/^Every repeat is still sent, only later: users' apps \(5×\)/);
    expect(e.text).toMatch(/The cache emptied too \(hit rate \d+%, normally 75%\), so more requests went past it\.$/);
  });

  it('says why bounding the queue worked, counting only the work the database took on', () => {
    const e = explain(storm, 'bound-queue');
    expect(e.helped).toBe(true);
    expect(e.title).toBe('Why it worked');
    expect(e.text).toMatch(/^The database turned [\d,]+ requests away at once instead of letting them wait, so after the failure ended the database had at most (\d\.\d)× the work it can handle, against 3\.\d× without the fix\.$/);
    // Turned-away requests are not work: the database never ran far above what it can handle.
    expect(Number(/at most (\d+(\.\d)?)×/.exec(e.text)![1])).toBeLessThan(1.5);
  });

  it('says why retrying at one layer worked: far fewer repeats', () => {
    const e = explain(storm, 'retry-one-layer');
    expect(e.text).toMatch(/^Retries sent by all layers fell from [\d,]+ to [\d,]+, so after the failure ended the database had at most/);
  });

  it('says why merging cache misses worked after a cache restart, and that nobody failed', () => {
    const e = explain(buildRunConfig(webChain, cacheRestart), 'coalesce-misses');
    expect(e.helped).toBe(true);
    expect(e.text).toMatch(/^Requests reaching the database during the incident fell from [\d,]+ to [\d,]+, so after the failure ended the database had at most 0\.\d× the work it can handle, against \d\.\d× without the fix, so the pile left by the failure could drain\.$/);
    expect(e.refuted).toContain('noFailures');
  });

  it('flags failing more users, so a pro about hiding errors is dropped', () => {
    const e = explain(buildRunConfig(webChain, cacheRestart), 'retry-one-layer');
    expect(e.helped).toBe(false);
    expect(e.refuted).toContain('failedMore');
    expect(e.text).toMatch(/^The app server \(1×\) still retries, so the database still had up to/);
  });

  it('compares a longer wait with the failure it waits through, only for that part', () => {
    // A 10 s database slowdown outlasts the app server's new 3 s wait.
    const long = buildRunConfig(webChain, retryStorm, { outageMs: 10_000 });
    const e = explain(long, 'longer-timeout');
    expect(e.helped).toBe(false);
    expect(e.text).toMatch(/^The failure lasted 10 s, longer than the new 3 s wait, so the app server still gave up and asked again\. Users' apps/);
    // A slow Gateway is not what the app server waits for: no such comparison.
    expect(explain(buildRunConfig(webChain, gatewaySlow), 'longer-timeout').text).not.toMatch(/The failure lasted/);
  });

  it('says plainly when a run that recovered anyway did no better with the fix', () => {
    const calm = buildRunConfig(webChain, retryStorm, { rps: 60 });
    const before = analyzed(calm);
    const e = explainFix('jitterBackoff', false, { config: calm, result: before }, { config: calm, result: before }, labels);
    expect(e.title).toBe("Why it didn't help here");
    expect(e.text).toMatch(/^It recovers in .+, against .+ without it, and [\d,]+ requests failed instead of [\d,]+: no improvement\.$/);
  });

  it('explains a recovery that does not count because it fails more users', () => {
    const stuck = analyzed(storm);
    const recovered = analyzed(buildRunConfig(webChain, retryStorm, { rps: 60 }));
    const worse = { ...recovered, analysis: { ...recovered.analysis, recovery: { ...recovered.analysis.recovery, failedRequests: stuck.analysis.recovery.failedRequests + 1 } } };
    const e = explainFix('capRetries', false, { config: storm, result: stuck }, { config: storm, result: worse }, labels);
    expect(e.text).toMatch(/where the run without it stays stuck, but [\d,]+ requests failed instead of [\d,]+, so it doesn't count as helping\.$/);
    expect(e.refuted).toContain('failedMore');
  });

  it('says when the system cannot carry the traffic with the fix', () => {
    const stuck = analyzed(storm);
    const over = { ...stuck, analysis: { ...stuck.analysis, recovery: { ...stuck.analysis.recovery, verdict: 'overloaded' as const } } };
    expect(explainFix('addInstances', false, { config: storm, result: stuck }, { config: storm, result: over }, labels).text).toBe('With it, the system can’t carry this much traffic even without the failure.');
  });

  it('a queue: more consumers leave messages waiting at the end, or drain them', () => {
    const system = customSystem(chainGraph(['client', 'loadBalancer', 'queue', 'server', 'database']));
    if (system.kind !== 'custom') throw new Error('expected a built system');
    const queueLabels = Object.fromEntries(Object.entries(system.topology.layout).map(([id, l]) => [id, l.label]));
    const scenario = system.scenarios.find((s) => s.id === 'custom-db-slow')!;
    const config = buildRunConfig(system.topology, scenario, { rps: 100 });
    const before = analyzed(config);
    const fix = candidateFixes(config, before.analysis.signals, queueLabels).find((c) => c.id === 'more-consumers')!;
    const after = analyzed(fix.config);
    const helped = fixHelped(before.analysis.recovery, after.analysis.recovery);
    const e = explainFix('moreConsumers', helped, { config, result: before }, { config: fix.config, result: after }, queueLabels);
    expect(e.text.length).toBeGreaterThan(20);
    expect(e.text).not.toMatch(/undefined|NaN/);
  });

  it('scaling out the overloaded part itself: measured against its new capacity', () => {
    const scaled: RunConfig = { ...storm, tiers: storm.tiers.map((t) => (t.id === 'db' ? { ...t, instances: t.instances + 1 } : t)) };
    const [before, after] = [analyzed(storm), analyzed(scaled)];
    const e = explainFix('addInstances', false, { config: storm, result: before }, { config: scaled, result: after }, labels);
    if (after.analysis.recovery.verdict === 'stuck') expect(e.text).toMatch(/^Even with more servers, the database had up to \d\.\d× the work it can now handle after the failure ended: users' apps \(5×\)/);
    else expect(e.text).toMatch(/^It gets back to normal/);
  });

  it('says why skipping abandoned work worked, and falls back to the load alone when nothing else changed', () => {
    const single = buildRunConfig(webChain, retryStorm, { retries: { client: 0, gateway: 0, api: 3 } });
    const e = explain(single, 'drop-expired');
    expect(e.helped).toBe(true);
    expect(e.text).toMatch(/^The database skipped [\d,]+ requests nobody was waiting for any more, so after the failure ended/);
    const same = analyzed(storm);
    expect(explainFix('jitterBackoff', true, { config: storm, result: same }, { config: storm, result: same }, labels).text).toMatch(/^After the failure ended, the database had at most \d\.\d× the work it can handle, against \d\.\d× without the fix\.$/);
  });

  it('with no overloaded part and nobody retrying, says plainly that it never got back to normal', () => {
    const calm = buildRunConfig(webChain, retryStorm, { rps: 40, retries: { client: 0, gateway: 0, api: 0 } });
    const run = analyzed(calm);
    const stuck = { ...run, analysis: { ...run.analysis, recovery: { ...run.analysis.recovery, verdict: 'stuck' as const, failedRequests: 12 } } };
    expect(explainFix('dropExpired', false, { config: calm, result: run }, { config: calm, result: stuck }, labels).text).toBe("It still hadn't returned to normal by the end of the run, and 12 requests failed.");
    expect(explainFix('dropExpired', true, { config: calm, result: run }, { config: calm, result: run }, labels).text).toBe('It got back to normal after the failure ended.');
    const quiet = vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(() => {
      throw new RangeError('bad locale');
    });
    expect(explainFix('dropExpired', false, { config: calm, result: run }, { config: calm, result: stuck }, labels).text).toMatch(/and 12 requests failed/);
    quiet.mockRestore();
  });

  it('a queue that never catches up: more consumers leave messages waiting; one that drains has fewer waiting', () => {
    const system = customSystem(chainGraph(['client', 'loadBalancer', 'queue', 'server', 'database']));
    if (system.kind !== 'custom') throw new Error('expected a built system');
    const queueLabels = Object.fromEntries(Object.entries(system.topology.layout).map(([id, l]) => [id, l.label]));
    const backlog = system.scenarios.find((s) => s.id === 'custom-queue-backlog')!;
    const config = buildRunConfig(system.topology, backlog, { rps: 150 });
    const before = analyzed(config);
    const fix = candidateFixes(config, before.analysis.signals, queueLabels).find((c) => c.id === 'more-consumers')!;
    const after = analyzed(fix.config);
    const notHelped = explainFix('moreConsumers', false, { config, result: before }, { config: fix.config, result: after }, queueLabels);
    if (after.analysis.recovery.verdict === 'stuck' && (after.analysis.signals.queueBacklog?.value.atEnd ?? 0) >= 1) expect(notHelped.text).toMatch(/^[\d,]+ messages were still waiting in the queue 2 at the end of the run/);
    const worked = explainFix('moreConsumers', true, { config, result: before }, { config: fix.config, result: after }, queueLabels);
    if ((after.analysis.signals.queueBacklog?.value.peak ?? 0) < (before.analysis.signals.queueBacklog?.value.peak ?? 0)) expect(worked.text).toMatch(/^At most [\d,]+ messages waited instead of [\d,]+/);
    expect(worked.title).toBe('Why it worked');
  });

  it('every kind gives a sentence for every preset, with numbers and no placeholders', () => {
    for (const scenario of [retryStorm, cacheRestart, gatewaySlow]) {
      const config = buildRunConfig(webChain, scenario);
      const before = analyzed(config);
      for (const c of candidateFixes(config, before.analysis.signals, labels)) {
        const after = analyzed(c.config);
        const kind: FixKind = FIX_CATALOG.find((d) => d.id === c.id)!.kind;
        const e = explainFix(kind, fixHelped(before.analysis.recovery, after.analysis.recovery), { config, result: before }, { config: c.config, result: after }, labels);
        expect(e.text).toMatch(/\.$/);
        expect(e.text).not.toMatch(/undefined|NaN|Infinity|\{|\}/);
      }
    }
  });
});
