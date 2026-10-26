import {
  addFault,
  currentCell,
  describeFault,
  draftProblems,
  FAULT_KIND_LABELS,
  faultKindOf,
  nearestCell,
  onMap,
  removeFault,
  retryCalls,
  updateFault,
  updateRetries,
  updateScenario,
  updateTier,
  withFaultKind,
  JUDGE_AFTER_FAILURE_S,
} from './draft';
import { PRESET_SYSTEM, systemDraft } from './system';

const presetDraft = (id: string) => systemDraft(PRESET_SYSTEM, id);

describe('draftProblems', () => {
  const preset = presetDraft('retry-storm');

  it('accepts the preset', () => {
    expect(draftProblems(preset)).toEqual([]);
  });

  it('refuses a run with too many requests to simulate', () => {
    expect(draftProblems(updateScenario(preset, { rps: 30_000 }))[0]).toMatch(/^This many requests would take too long to simulate/);
  });

  it('needs the failure to end in time to judge recovery', () => {
    const late = updateFault(preset, { startMs: 500_000, endMs: 505_000 });
    expect(draftProblems(late)).toEqual([
      `The failure must end at least ${JUDGE_AFTER_FAILURE_S} s before the run ends, so there is time to see whether the system recovers. It ends at 505 s; the run lasts 120 s.`,
    ]);
    expect(draftProblems(updateScenario(preset, { durationMs: 30_000 }))).toHaveLength(1);
    expect(draftProblems(updateFault(preset, { endMs: 100_000 }))).toEqual([]); // exactly 20 s left
  });

  it('refuses two failures of the same part at the same time, which the engine would not combine', () => {
    const two = addFault(preset);
    expect(draftProblems(two)).toEqual([]); // a different part
    const same = updateFault(two, { tier: 'db', startMs: 32_000, endMs: 40_000 }, 1);
    expect(draftProblems(same)).toEqual(['Failures 1 and 2 both hit DB at the same time, and only one failure of a part can be simulated at once. Move one of them, or choose another part.']);
    expect(draftProblems(updateFault(same, { startMs: 35_000 }, 1))).toEqual([]); // one after the other
  });

  it('needs the slowest 1% to be slower than the typical request, in plain words', () => {
    const bad = updateTier(preset, 'db', (t) => ({ ...t, service: { kind: 'lognormal', medianMs: 20, p99Ms: 10 } }));
    expect(draftProblems(bad)).toEqual(['DB: the slowest 1% of requests (p99) must take longer than a typical one (median).']);
  });
});

describe('map cells', () => {
  const s = presetDraft('retry-storm').scenario; // traffic × failure length

  it('finds the current settings on the map, or the nearest cell when they fall between or beyond it', () => {
    expect(currentCell(s)).toEqual({ x: 200, y: 5000 });
    expect(onMap(s)).toBe(true);
    expect(nearestCell(s)).toEqual({ x: 200, y: 5000 });
    const between = { ...s, rps: 150, faults: [{ ...s.faults[0], endMs: s.faults[0].startMs + 6000 }] };
    expect(onMap(between)).toBe(false);
    expect(nearestCell(between)).toEqual({ x: 140, y: 5000 });
    expect(nearestCell(s, { x: 1, y: 60_000 })).toEqual({ x: 60, y: 12_000 });
    expect(currentCell({ ...s, map: { ...s.map, y: { param: 'rps', label: 'traffic', values: [] } } })).toEqual({ x: 200, y: 200 });
  });
});

describe('failures and retries', () => {
  const d = presetDraft('retry-storm');

  it('adds a slowdown of a part that is not failing yet, at the same time, and never removes the first', () => {
    const two = addFault(d);
    expect(two.scenario.faults[1]).toEqual({ tier: 'lb', kind: 'slow', factor: 4, startMs: 30_000, endMs: 35_000 });
    expect(addFault(addFault(addFault(addFault(two)))).scenario.faults.at(-1)!.tier).toBe('db'); // every part failing: reuse the first
    expect(removeFault(two, 0)).toBe(two);
    expect(removeFault(two, 1).scenario.faults).toHaveLength(1);
    expect(updateFault(two, { factor: 2 }, 1).scenario.faults.map((f) => f.factor)).toEqual([8, 2]);
  });

  it('switches failure kinds in plain words, keeping where and when', () => {
    const f = d.scenario.faults[0];
    expect(faultKindOf(f)).toBe('slow');
    const kinds = ['down', 'one-down', 'restart-empty', 'slow'] as const;
    expect(kinds.map((k) => describeFault(withFaultKind(f, k), 4))).toEqual(['goes down', 'loses one of its 4 copies', 'goes down and restarts empty', 'slows 8×']);
    expect(kinds.map((k) => faultKindOf(withFaultKind(f, k)))).toEqual([...kinds]);
    expect(withFaultKind({ ...f, kind: 'dead', factor: undefined }, 'slow').factor).toBe(4);
    expect(withFaultKind(f, 'one-down')).toEqual({ tier: 'db', startMs: 30_000, endMs: 35_000, kind: 'dead', instance: 0 });
    // Built in the presets' key order, so it reads (and is written) like them.
    expect(JSON.stringify(withFaultKind(f, 'slow'))).toBe(JSON.stringify(f));
    expect(Object.keys(withFaultKind(f, 'one-down'))).toEqual(['tier', 'kind', 'startMs', 'endMs', 'instance']);
    const cache = presetDraft('cache-restart').scenario.faults[0];
    expect(JSON.stringify(withFaultKind(cache, 'restart-empty'))).toBe(JSON.stringify(cache));
  });

  it('lists and edits every layer\'s retries, front to back', () => {
    expect(retryCalls(d.topology)).toEqual([
      { caller: 'client', target: 'lb', retries: 5 },
      { caller: 'lb', target: 'api', retries: 3 },
      { caller: 'api', target: 'db', retries: 1 },
    ]);
    const edited = updateRetries(updateRetries(d, 'client', 0), 'api', 4);
    expect(retryCalls(edited.topology).map((c) => c.retries)).toEqual([0, 3, 4]);
  });

  it('refuses "loses one copy" on a part with a single copy, quoting the options as the editor offers them', () => {
    const cacheOneDown = updateFault(d, { tier: 'cache', kind: 'dead', instance: 0, factor: undefined });
    expect(draftProblems(cacheOneDown)).toEqual(['Cache has only 1 copy, so "loses one copy" would take it down completely; choose "goes down" instead.']);
    expect([FAULT_KIND_LABELS['one-down'], FAULT_KIND_LABELS.down]).toEqual(['loses one copy', 'goes down']);
  });
});
