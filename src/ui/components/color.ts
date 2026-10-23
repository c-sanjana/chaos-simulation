/** Opacity of stacked-area fills, shared by the chart and its legend. */
export const AREA_ALPHA = 0.55;

/** '#RRGGBB' → 'rgba(r,g,b,a)'. Any other colour string is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) return color;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}
