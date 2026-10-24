import { createContext, type ReactNode } from 'react';

/** Whether the step a component is in is the one on screen (true outside any StepPanel). */
export const StepActiveContext = createContext(true);

/**
 * One of the three steps. A step the viewer has left stays mounted but hidden (`keep`), so coming
 * back finds it as it was: its finished and running work, the chosen fix, the selected map cell,
 * the replay's position and tab. Replays pause while hidden (see RunPlayer).
 * ASSUMPTION: `display: contents` keeps the step's own layout exactly as when it was rendered
 * directly in the page.
 */
export function StepPanel({ active, keep, children }: { active: boolean; keep: boolean; children: ReactNode }) {
  if (!active && !keep) return null;
  return (
    <StepActiveContext.Provider value={active}>
      <div hidden={!active} style={active ? { display: 'contents' } : undefined}>
        {children}
      </div>
    </StepActiveContext.Provider>
  );
}
