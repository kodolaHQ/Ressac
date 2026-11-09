import type { FrameBounds } from "../../shared/model";

/** The recorded frame, rounded, if it still overlaps a screen (else the window would open out of sight). */
export function visibleFrame(c: FrameBounds | null, screens: { x: number; y: number; width: number; height: number }[]): FrameBounds | undefined {
  if (!c) return undefined;
  const r = { x: Math.round(c.x), y: Math.round(c.y), largeur: Math.round(c.largeur), hauteur: Math.round(c.hauteur) };
  const visible = screens.some((z) => r.x < z.x + z.width && r.x + r.largeur > z.x && r.y < z.y + z.height && r.y + r.hauteur > z.y);
  return visible ? r : undefined;
}
