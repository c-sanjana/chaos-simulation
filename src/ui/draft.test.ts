import { currentCell, draftProblems, nearestCell, onMap, presetDraft, updateFault, updateScenario, updateTier, JUDGE_AFTER_FAILURE_S } from './draft';

describe('draftProblems', () => {
  const preset = presetDraft('retry-storm');

  it('accepts the preset', () => {
    expect(draftProblems(preset)).toEqual([]);
  });

  it('needs the failure to end in time to judge recovery', () => {
    const late = updateFault(preset, { startMs: 500_000, endMs: 505_000 });
    expect(draftProblems(late)).toEqual([
      `The failure must end at least ${JUDGE_AFTER_FAILURE_S} s before the run ends, so there is time to see whether the system recovers. It ends at 505 s; the run lasts 120 s.`,
    ]);
    expect(draftProblems(updateScenario(preset, { durationMs: 30_000 }))).toHaveLength(1);
    expect(draftProblems(updateFault(preset, { endMs: 100_000 }))).toEqual([]); // exactly 20 s left
  });

  it('needs the slowest 1% to be slower than the typical request, in plain words', () => {
    const bad = updateTier(preset, 'db', (t) => ({ ...t, service: { kind: 'lognormal', medianMs: 20, p99Ms: 10 } }));
    expect(draftProblems(bad)).toEqual(['DB: the slowest 1% of requests (p99) must take longer than a typical one (median).']);
  });
});

describe('map cells', () => {
  const s = presetDraft('retry-storm').scenario;

  it('finds the current settings on the map, or the nearest cell when they fall between or beyond it', () => {
    expect(currentCell(s)).toEqual({ x: 200, y: 3 });
    expect(onMap(s)).toBe(true);
    expect(nearestCell(s)).toEqual({ x: 200, y: 3 });
    const between = { ...s, rps: 150, retries: 50 };
    expect(onMap(between)).toBe(false);
    expect(nearestCell(between)).toEqual({ x: 140, y: 5 });
    expect(nearestCell(s, { x: 1, y: -3 })).toEqual({ x: 60, y: 0 });
  });
});
