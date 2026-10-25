import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { branchedGraph } from '../builder/testGraphs';
import { callsOf } from '../engine/config';
import { settingsChanges } from './compare';
import { countsText, retriesByCaller, retryCalls, updateCallAt, updateRetries, updateTier, type Draft } from './draft';
import { FailureEditor, retriesDetail, retriesSummary, SUMMARY_MAX_CALLERS } from './FailureEditor';
import { SettingsForm } from './SettingsForm';
import { customSystem, systemDraft } from './system';
import { cascadeSentence } from './tipping';
import { labelsOf } from './viewModels';

/** The branched system, with s3 also calling Database 1 (so a server calls two parts). */
function branchedDraft(): Draft {
  const d = systemDraft(customSystem(branchedGraph()), 'custom-db-slow');
  return updateTier(d, 's3', (t) => ({ ...t, moreDownstream: [{ ...t.downstream!, target: 'db1', retries: 2 }], fanOut: 'sequence' }));
}

let latest: Draft;
function Harness({ initial, form }: { initial: Draft; form: 'settings' | 'failure' }) {
  const [draft, setDraft] = useState(initial);
  latest = draft;
  return form === 'settings' ? <SettingsForm draft={draft} onChange={setDraft} /> : <FailureEditor draft={draft} onChange={setDraft} onRun={() => {}} dirty />;
}

describe('per-call retries with branches', () => {
  it('lists every call, front to back, and groups them by caller', () => {
    const calls = retryCalls(branchedDraft().topology);
    expect(calls.map((c) => `${c.caller}>${c.target}:${c.retries}`)).toEqual(['client>lb:2', 'lb>s1:1', 'lb>s2:1', 'lb>s3:1', 's1>db1:1', 's2>db1:1', 's3>queue:1', 's3>db1:2', 'queue>db2:1']);
    expect(retriesByCaller(calls).find((g) => g.caller === 's3')).toEqual({ caller: 's3', counts: [1, 2] });
    expect(countsText([1, 2])).toBe('1× / 2×');
  });

  it('sets one call, or every call of a caller', () => {
    const d = branchedDraft();
    const one = updateRetries(d, 'lb', 4, 's2');
    expect(callsOf(one.topology.tiers[0]).map((c) => c.retries)).toEqual([1, 4, 1]);
    const all = updateRetries(d, 'lb', 0);
    expect(callsOf(all.topology.tiers[0]).map((c) => c.retries)).toEqual([0, 0, 0]);
    expect(updateCallAt(d.topology.tiers[0], 2, { timeoutMs: 5 }).moreDownstream![1].timeoutMs).toBe(5);
    expect(updateCallAt(d.topology.tiers[0], 0, { timeoutMs: 5 }).downstream!.timeoutMs).toBe(5);
  });

  it(`the summary stays short: beyond ${SUMMARY_MAX_CALLERS} callers, the users' apps, the ones that differ, then the rest`, () => {
    const d = branchedDraft();
    expect(retriesSummary(d)).toBe("users' apps 2× · s3: 1× / 2× · the rest 1×"); // "s3 1×" would read as one number
    expect(retriesDetail(d)).toBe("users' apps → lb 2×, lb → s1 1×, lb → s2 1×, lb → s3 1×, s1 → db1 1×, s2 → db1 1×, s3 → queue 1×, s3 → db1 2×, queue → db2 1×");
    // Most callers don't ask again: that is left unsaid ("the rest 0×" read oddly).
    const calm = updateRetries(updateRetries(updateRetries(updateRetries(updateRetries(updateRetries(d, 'lb', 0), 's1', 0), 's2', 0), 'queue', 0), 's3', 0), 's3', 3, 'db1');
    expect(retriesSummary(calm)).toBe("users' apps 2× · s3: 0× / 3×");
    const chain = systemDraft(customSystem(branchedGraph()), '');
    expect(retriesSummary(chain)).toBe("users' apps 2× · the rest 1×");
  });

  it('the cascade sentence names each caller once', () => {
    const d = branchedDraft();
    expect(cascadeSentence(retryCalls(d.topology), labelsOf(d.topology))).toBe(
      'Every layer asks again when it gives up (client 2×, lb 1×, s1: 1×, s2: 1×, s3: 1× / 2×, queue 1×), so one failed answer can come back as many requests.',
    );
  });

  it('the comparison lists changes to every call, a split and how a server calls its parts', () => {
    const d = branchedDraft();
    let next = updateRetries(d, 's3', 3, 'db1');
    next = updateTier(next, 's3', (t) => updateCallAt({ ...t, fanOut: 'parallel' }, 1, { timeoutMs: 500 }));
    next = updateTier(next, 'lb', (t) => updateCallAt(t, 0, { share: 2 }));
    expect(settingsChanges(d, next)).toEqual([
      's3 → db1 retries 2 → 3',
      'lb → s1 share of traffic 34% → 50%',
      'lb → s2 share of traffic 33% → 25%',
      'lb → s3 share of traffic 33% → 25%',
      's3 → db1 timeout 2000 ms → 500 ms',
      's3 calls its parts all at once',
    ]);
  });
});

describe('editing every call in the settings drawer', () => {
  it("a load balancer's share of traffic per server: the others make up the rest", () => {
    render(<Harness initial={branchedDraft()} form="settings" />);
    const lb = screen.getByRole('group', { name: 'lb' });
    const shares = within(lb).getAllByLabelText(/^Share of traffic to/);
    expect(shares.map((s) => (s as HTMLInputElement).value)).toEqual(['34', '33', '33']); // adds up to 100
    fireEvent.change(shares[0], { target: { value: '50' } });
    expect(callsOf(latest.topology.tiers[0]).map((c) => c.share)).toEqual([0.5, 0.25, 0.25]);
    // Each call has its own retries.
    const retries = within(lb).getAllByLabelText(/^Retries to/);
    expect(retries).toHaveLength(3);
    fireEvent.change(retries[2], { target: { value: '0' } });
    expect(callsOf(latest.topology.tiers[0]).map((c) => c.retries)).toEqual([1, 1, 0]);
  });

  it('shares that round to 0% show as a valid value, never blocking the re-run; typing 70, 20, 10 gives 70/20/10 (code review 3)', () => {
    render(<Harness initial={branchedDraft()} form="settings" />);
    const lb = screen.getByRole('group', { name: 'lb' });
    const shares = () => within(lb).getAllByLabelText(/^Share of traffic to/) as HTMLInputElement[];
    fireEvent.change(shares()[0], { target: { value: '99' } });
    expect(shares().map((s) => [s.value, s.getAttribute('aria-invalid')])).toEqual([
      ['99', 'false'],
      ['0.5', 'false'],
      ['0.5', 'false'],
    ]);
    expect(lb.textContent).not.toMatch(/Enter a/);
    fireEvent.change(shares()[0], { target: { value: '70' } });
    fireEvent.change(shares()[1], { target: { value: '20' } });
    fireEvent.change(shares()[2], { target: { value: '10' } });
    expect(callsOf(latest.topology.tiers[0]).map((c) => c.share)).toEqual([0.7, 0.2, 0.1]);
    expect(shares().map((s) => s.value)).toEqual(['70', '20', '10']);
  });

  it('an app server calling two parts: one after another or all at once, and each call’s timeout', () => {
    render(<Harness initial={branchedDraft()} form="settings" />);
    const s3 = screen.getByRole('group', { name: 's3' });
    fireEvent.change(within(s3).getByLabelText('Calls its parts'), { target: { value: 'parallel' } });
    expect(latest.topology.tiers.find((t) => t.id === 's3')!.fanOut).toBe('parallel');
    fireEvent.change(within(s3).getByLabelText(/^Timeout to db1/), { target: { value: '700' } });
    expect(latest.topology.tiers.find((t) => t.id === 's3')!.moreDownstream![0].timeoutMs).toBe(700);
    fireEvent.change(within(s3).getByLabelText('Calls its parts'), { target: { value: 'sequence' } });
    expect(latest.topology.tiers.find((t) => t.id === 's3')!.fanOut).toBe('sequence');
  });

  it('the failure editor has one retries field per call', () => {
    render(<Harness initial={branchedDraft()} form="failure" />);
    fireEvent.change(screen.getByLabelText(/^s3 → db1/), { target: { value: '5' } });
    expect(callsOf(latest.topology.tiers.find((t) => t.id === 's3')!).map((c) => c.retries)).toEqual([1, 5]);
  });
});
