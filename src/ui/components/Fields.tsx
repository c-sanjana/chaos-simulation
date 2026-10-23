import { useState } from 'react';

function parseValid(raw: string, min: number | undefined): number | null {
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) && (min === undefined || n >= min) ? n : null;
}

export interface NumberFieldProps {
  label: string;
  value: number;
  unit?: string;
  onChange: (value: number) => void;
  min?: number;
  step?: number;
}

/**
 * Labelled number input styled like the settings mockup. While the user is typing, the raw
 * text is kept locally so a half-typed value ("", "-", "1.") is not forced back to a number;
 * onChange fires only for valid numbers (at or above `min`). On blur the field shows `value` again.
 */
export function NumberField({ label, value, unit, onChange, min, step }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const valid = parseValid(shown, min) !== null;

  return (
    <label className="csl-field">
      {label}
      <span className={`csl-field__box${valid ? '' : ' csl-field__box--invalid'}`}>
        <input
          className="csl-field__input"
          type="number"
          inputMode="decimal"
          value={shown}
          min={min}
          step={step}
          aria-invalid={!valid}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            const n = parseValid(raw, min);
            if (n !== null) onChange(n);
          }}
          onBlur={() => setDraft(null)}
        />
        {unit && <span className="csl-field__unit">{unit}</span>}
      </span>
    </label>
  );
}

export interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function CheckboxField({ label, checked, onChange }: CheckboxFieldProps) {
  return (
    <label className="csl-checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
