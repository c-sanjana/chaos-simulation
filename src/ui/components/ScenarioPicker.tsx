export interface ScenarioPickerProps {
  scenarios: Array<{ id: string; title: string; blurb: string }>;
  selected: string;
  onSelect: (id: string) => void;
}

/** Preset failure scenarios as selectable cards. */
export function ScenarioPicker({ scenarios, selected, onSelect }: ScenarioPickerProps) {
  return (
    <div className="csl-scenarios" role="group" aria-label="Scenario">
      {scenarios.map((s) => (
        <button key={s.id} type="button" className="csl-scenario" aria-pressed={s.id === selected} onClick={() => onSelect(s.id)}>
          <span className="csl-scenario__title">{s.title}</span>
          <span className="csl-scenario__blurb">{s.blurb}</span>
        </button>
      ))}
    </div>
  );
}
