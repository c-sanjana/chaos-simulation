import { useId, useState } from 'react';

interface Limits {
  min?: number;
  max?: number;
  /** Whole numbers only. */
  integer?: boolean;
}

function parseValid(raw: string, { min, max, integer }: Limits): number | null {
  const n = Number(raw);
  const ok = raw.trim() !== '' && Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max) && (!integer || Number.isInteger(n));
  return ok ? n : null;
}

/** e.g. "Enter a whole number from 0 to 10", "Enter a number of at least 1". */
export function limitsMessage({ min, max, integer }: Limits): string {
  const what = integer ? 'a whole number' : 'a number';
  if (min !== undefined && max !== undefined) return `Enter ${what} from ${min} to ${max}`;
  if (min !== undefined) return `Enter ${what} of at least ${min}`;
  if (max !== undefined) return `Enter ${what} of at most ${max}`;
  return `Enter ${what}`;
}

export interface NumberFieldProps extends Limits {
  label: string;
  value: number;
  unit?: string;
  onChange: (value: number) => void;
}

/**
 * Labelled number input. The raw text is kept locally so a half-typed value ("", "-", "1.") is not
 * forced back to a number; onChange fires only for valid numbers. An invalid value stays visible,
 * marked and explained under the field, until the viewer fixes it (it never silently snaps back
 * to the last valid value, REVIEW2 2.6), and it blocks the form it is in through the input's
 * native validity (required, min, max, step). A new value from outside (a reset, say) replaces it.
 */
export function NumberField({ label, value, unit, onChange, min, max, integer }: NumberFieldProps) {
  /** What the viewer typed, and the value it was typed over (a different value from outside wins). */
  const [draft, setDraft] = useState<{ raw: string; over: number } | null>(null);
  const id = useId();
  const shown = draft !== null && draft.over === value ? draft.raw : String(value);
  const limits = { min, max, integer };
  const valid = parseValid(shown, limits) !== null;

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
          max={max}
          // The step must not add rules of its own: the browser checks it against `min` (step 10
          // from 1 would reject 80), and the form trusts the browser's verdict.
          step={integer ? 1 : 'any'}
          required
          aria-invalid={!valid}
          aria-describedby={valid ? undefined : `${id}-error`}
          onChange={(e) => {
            const raw = e.target.value;
            const n = parseValid(raw, limits);
            setDraft({ raw, over: n ?? value });
            if (n !== null) onChange(n);
          }}
          // A valid entry is tidied up ("05" → "5"); an invalid one stays as typed.
          onBlur={() => valid && setDraft(null)}
        />
        {unit && <span className="csl-field__unit">{unit}</span>}
      </span>
      {!valid && (
        <span className="csl-field__error" id={`${id}-error`}>
          {limitsMessage(limits)}
        </span>
      )}
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
