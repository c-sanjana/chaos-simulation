import type { DragEvent } from 'react';
import { KIND_BLURBS, KIND_LABELS, type ComponentKind } from '../../builder/graph';
import { KindIcon } from './KindIcon';

/** Palette order: roughly the order a request meets them. */
export const PALETTE_KINDS: ComponentKind[] = ['client', 'loadBalancer', 'server', 'cache', 'database', 'queue'];

/** Marks a drag as coming from the builder (browsers need some data for a drag to start). */
export const DRAG_MIME = 'application/x-csl-builder';

export function startDrag(e: DragEvent, payload: string, effect: 'copy' | 'move' | 'link') {
  // dataTransfer is missing in some test environments; the drag itself is tracked in React state.
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(DRAG_MIME, payload);
  e.dataTransfer.setData('text/plain', payload);
  e.dataTransfer.effectAllowed = effect;
}

export interface PaletteProps {
  /** Kinds that can't be added now, with why (e.g. a second Client). */
  unavailable: Partial<Record<ComponentKind, string>>;
  onAdd: (kind: ComponentKind) => void;
  onDragStart: (kind: ComponentKind) => void;
  onDragEnd: () => void;
}

/**
 * The six components. Each can be dragged onto the canvas, or added with its button (keyboard and
 * touch friendly), which puts it on the first free cell.
 */
export function Palette({ unavailable, onAdd, onDragStart, onDragEnd }: PaletteProps) {
  return (
    <ul className="csl-palette" aria-label="Components you can add">
      {PALETTE_KINDS.map((kind) => {
        const why = unavailable[kind];
        return (
          <li
            key={kind}
            className={`csl-palette__item${why ? ' csl-palette__item--unavailable' : ''}`}
            draggable={!why}
            title={why ?? `Drag onto the canvas to add a ${KIND_LABELS[kind].toLowerCase()}`}
            data-testid={`palette-${kind}`}
            onDragStart={(e) => {
              startDrag(e, kind, 'copy');
              onDragStart(kind);
            }}
            onDragEnd={onDragEnd}
          >
            <span className="csl-palette__icon">
              <KindIcon kind={kind} />
            </span>
            <span className="csl-palette__text">
              <span className="csl-palette__name">{KIND_LABELS[kind]}</span>
              <span className="csl-palette__blurb">{why ? 'Already on the canvas (only one allowed)' : KIND_BLURBS[kind]}</span>
            </span>
            <button
              type="button"
              className="csl-btn csl-btn--small csl-palette__add"
              aria-label={`Add ${KIND_LABELS[kind].toLowerCase()}`}
              // aria-disabled rather than disabled, so the button stays focusable and a click explains why.
              aria-disabled={why ? true : undefined}
              onClick={() => onAdd(kind)}
            >
              Add
            </button>
          </li>
        );
      })}
    </ul>
  );
}
