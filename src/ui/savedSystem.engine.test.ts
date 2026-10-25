import { chainGraph } from '../builder/testGraphs';
import { loadSaved, SAVED_SYSTEM_KEY } from './savedSystem';
import { PRESET_SYSTEM } from './system';

// Should the builder's checks and the engine's ever disagree, the engine has the last word.
vi.mock('../engine/validate', () => ({
  validateConfig: () => {
    throw new Error('Invalid config: something new the builder does not check');
  },
}));

describe('saved system, checked by the engine too', () => {
  it('leaves out a built system the engine refuses, even when the drawing has no problems', () => {
    const data = new Map([[SAVED_SYSTEM_KEY, JSON.stringify({ system: chainGraph(['client', 'server', 'database']), scenarioId: '', applied: null, canvas: null, canvasOpen: false })]]);
    const restored = loadSaved({ getItem: (k) => data.get(k) ?? null, setItem: () => {}, removeItem: () => {} })!;
    expect(restored.system).toBe(PRESET_SYSTEM);
    expect(restored.notice).toMatch(/^Your saved system couldn't be restored/);
  });
});
