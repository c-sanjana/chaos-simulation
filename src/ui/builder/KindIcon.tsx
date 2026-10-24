import type { ComponentKind } from '../../builder/graph';

/** Simple line drawings, one per component kind. Decorative: the kind is always also written out. */
const PATHS: Record<ComponentKind, string> = {
  // A person.
  client: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  // One line splitting into three.
  loadBalancer: 'M3 12h6M9 12l10-7M9 12h10M9 12l10 7M17 3l2 2-2 2M17 10l2 2-2 2M17 17l2 2-2 2',
  // A rack of two units.
  server: 'M4 4h16v7H4zM4 13h16v7H4zM8 7.5h.01M8 16.5h.01',
  // A lightning bolt: fast answers.
  cache: 'M13 2L5 14h6l-1 8 8-12h-6z',
  // A cylinder.
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  // Messages waiting in a line.
  queue: 'M3 7h4v10H3zM10 7h4v10h-4zM17 7h4v10h-4z',
};

export function KindIcon({ kind, size = 18 }: { kind: ComponentKind; size?: number }) {
  return (
    <svg className="csl-kind-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[kind]} />
    </svg>
  );
}
