import type { Placement } from "../shared/api";

export type { Placement };

/** The free grid of the home page: 12 columns, 90 px rows, 12 px between cells. */
export const COLONNES = 12;
export const RANGEE_PX = 90;
export const ECART_PX = 12;

type Taille = { l: number; h: number };
export interface Tailles {
  min: Taille;
  max: Taille;
}

/** `v` between `min` and `max`; if the bounds cross, the minimum wins. */
const borner = (v: number, min: number, max: number) => Math.max(Math.min(v, max), min);
const chevauchent = (a: Placement, b: Placement) =>
  a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Widget `fixe` keeps its place; the others, taken from top to bottom, go down just under what they overlap
 * (cascading). The result has no overlap; the list's order is kept.
 */
function resoudre(placements: Placement[], fixe: Placement): Placement[] {
  const poses: Placement[] = [fixe];
  const autres = placements
    .filter((q) => q.id !== fixe.id)
    .map((q) => ({ ...q }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const q of autres) {
    for (let gene = poses.find((r) => chevauchent(q, r)); gene; gene = poses.find((r) => chevauchent(q, r))) {
      q.y = gene.y + gene.h;
    }
    poses.push(q);
  }
  const parId = new Map(poses.map((q) => [q.id, q]));
  return placements.map((q) => parId.get(q.id)!);
}

/** Puts widget `id` at (x, y), within the grid, and pushes down those it overlaps. */
export function deplacer(placements: Placement[], id: string, x: number, y: number): Placement[] {
  const cible = placements.find((q) => q.id === id);
  if (!cible) return placements;
  const fixe = { ...cible, x: borner(Math.round(x), 0, COLONNES - cible.l), y: Math.max(0, Math.round(y)) };
  return resoudre(placements, fixe);
}

/** Changes widget `id`'s size, bounded by its min and max sizes and by the grid's right edge. */
export function redimensionner(placements: Placement[], id: string, l: number, h: number, tailles: Tailles): Placement[] {
  const cible = placements.find((q) => q.id === id);
  if (!cible) return placements;
  const minL = Math.min(tailles.min.l, COLONNES);
  // The minimum does not fit before the right edge: the widget steps back.
  const x = Math.min(cible.x, COLONNES - minL);
  const largeur = borner(Math.round(l), minL, Math.min(tailles.max.l, COLONNES - x));
  const hauteur = borner(Math.round(h), tailles.min.h, tailles.max.h);
  return resoudre(placements, { ...cible, x, l: largeur, h: hauteur });
}
