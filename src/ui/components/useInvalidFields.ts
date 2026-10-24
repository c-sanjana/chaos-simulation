import { useEffect, useRef, useState } from 'react';

/** A number field showing text that isn't a valid value (yet): its label, and the input itself. */
export interface InvalidField {
  label: string;
  input: HTMLInputElement;
}

const SELECTOR = 'input[type="number"][aria-invalid="true"]';

/** A field's label without its unit or error message: the label element's own first text. */
function labelOf(input: HTMLInputElement): string {
  const label = input.closest('label');
  const first = label?.firstChild;
  return (first?.nodeType === Node.TEXT_NODE ? first.textContent : label?.textContent ?? '')!.trim();
}

/**
 * The number fields inside `root` that currently show invalid text, in page order. Pass the
 * element from a callback ref kept in state (`ref={setRoot}`), so the watch starts when it mounts.
 *
 * A NumberField keeps half-typed text to itself (it reports only valid numbers), so the screen it
 * sits in can't see it from its data. This watches the fields' `aria-invalid` instead, so a screen
 * can say "fix this field first" rather than run with the last valid value without a word.
 */
export function useInvalidFields(root: HTMLElement | null): InvalidField[] {
  const [fields, setFields] = useState<InvalidField[]>([]);
  // The list last reported, so DOM changes that don't change it cause no update at all.
  const current = useRef<InvalidField[]>([]);
  useEffect(() => {
    const set = (next: InvalidField[]) => {
      current.current = next;
      setFields(next);
    };
    if (!root) {
      if (current.current.length > 0) set([]);
      return;
    }
    const read = () => {
      const now = [...root.querySelectorAll<HTMLInputElement>(SELECTOR)];
      const before = current.current;
      if (before.length === now.length && before.every((f, i) => f.input === now[i])) return;
      set(now.map((input) => ({ label: labelOf(input), input })));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-invalid'] });
    return () => observer.disconnect();
  }, [root]);
  return fields;
}

/** Scrolls an invalid field into view and puts the cursor in it. */
export function focusField(field: InvalidField | undefined): void {
  if (!field) return;
  field.input.scrollIntoView?.({ block: 'center' });
  field.input.focus();
}
