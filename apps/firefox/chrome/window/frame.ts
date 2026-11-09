import type { FrameBounds } from "../../shared/model";

/** The recorded frame, rounded, if it still overlaps a screen (else the window would open out of sight). */
export function visibleFrame(c: FrameBounds | null, screens: { x: number; y: number; width: number; height: number }[]): FrameBounds | undefined {
  if (!c) return undefined;
  const r = { x: Math.round(c.x), y: Math.round(c.y), width: Math.round(c.width), height: Math.round(c.height) };
  const visible = screens.some((z) => r.x < z.x + z.width && r.x + r.width > z.x && r.y < z.y + z.height && r.y + r.height > z.y);
  return visible ? r : undefined;
}
