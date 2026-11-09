import type { Placement } from "../shared/api";

export type { Placement };

/** The free grid of the home page: 12 columns, 90 px rows, 12 px between cells. */
export const COLUMNS = 12;
export const ROW_PX = 90;
export const GAP_PX = 12;

type Taille = { l: number; h: number };
export interface Tailles {
  min: Taille;
  max: Taille;
}

/** `v` between `min` and `max`; if the bounds cross, the minimum wins. */
const clamp = (v: number, min: number, max: number) => Math.max(Math.min(v, max), min);
const overlap = (a: Placement, b: Placement) =>
  a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Widget `fixe` keeps its place; the others, taken from top to bottom, go down just under what they overlap
 * (cascading). The result has no overlap; the list's order is kept.
 */
function resolve(placements: Placement[], fixed: Placement): Placement[] {
  const poses: Placement[] = [fixed];
  const others = placements
    .filter((q) => q.id !== fixed.id)
    .map((q) => ({ ...q }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const q of others) {
    for (let gene = poses.find((r) => overlap(q, r)); gene; gene = poses.find((r) => overlap(q, r))) {
      q.y = gene.y + gene.h;
    }
    poses.push(q);
  }
  const parId = new Map(poses.map((q) => [q.id, q]));
  return placements.map((q) => parId.get(q.id)!);
}

/** Puts widget `id` at (x, y), within the grid, and pushes down those it overlaps. */
export function move(placements: Placement[], id: string, x: number, y: number): Placement[] {
  const target = placements.find((q) => q.id === id);
  if (!target) return placements;
  const fixed = { ...target, x: clamp(Math.round(x), 0, COLUMNS - target.l), y: Math.max(0, Math.round(y)) };
  return resolve(placements, fixed);
}

/** Changes widget `id`'s size, bounded by its min and max sizes and by the grid's right edge. */
export function resize(placements: Placement[], id: string, l: number, h: number, tailles: Tailles): Placement[] {
  const target = placements.find((q) => q.id === id);
  if (!target) return placements;
  const minL = Math.min(tailles.min.l, COLUMNS);
  // The minimum does not fit before the right edge: the widget steps back.
  const x = Math.min(target.x, COLUMNS - minL);
  const width = clamp(Math.round(l), minL, Math.min(tailles.max.l, COLUMNS - x));
  const hauteur = clamp(Math.round(h), tailles.min.h, tailles.max.h);
  return resolve(placements, { ...target, x, l: width, h: hauteur });
}
