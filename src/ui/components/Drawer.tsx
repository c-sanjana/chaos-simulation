import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface DrawerProps {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Modal side drawer. Closes on Escape, on the close button and on a click on the backdrop.
 * Moves focus to the close button when opened, keeps Tab inside the drawer, and gives focus
 * back to whatever had it before when closed.
 */
export function Drawer({ open, title, subtitle, onClose, children, footer }: DrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus?.();
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.from(panelRef.current!.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="csl-drawer-backdrop" data-testid="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} className="csl-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <div className="csl-drawer__header">
          <div className="csl-drawer__titles">
            <h2 id={titleId} className="csl-drawer__title">
              {title}
            </h2>
            {subtitle && <span className="csl-drawer__subtitle">{subtitle}</span>}
          </div>
          <button ref={closeRef} type="button" className="csl-drawer__close" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="csl-drawer__body">{children}</div>
        {footer && <div className="csl-drawer__footer">{footer}</div>}
      </div>
    </div>
  );
}
