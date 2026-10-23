export interface StepTabsProps {
  steps: Array<{ title: string; sub: string }>;
  /** Index of the current step (0-based). */
  current: number;
  onSelect: (index: number) => void;
}

/** The three numbered steps; the current one is marked with aria-current="step". */
export function StepTabs({ steps, current, onSelect }: StepTabsProps) {
  return (
    <nav className="csl-steps" aria-label="Steps">
      {steps.map((s, i) => (
        <button key={i} type="button" className="csl-step" aria-current={i === current ? 'step' : undefined} onClick={() => onSelect(i)}>
          <span className="csl-step__num" aria-hidden="true">
            {i + 1}
          </span>
          <span className="csl-step__text">
            <span className="csl-step__title">{s.title}</span>
            <span className="csl-step__sub">{s.sub}</span>
          </span>
        </button>
      ))}
    </nav>
  );
}
