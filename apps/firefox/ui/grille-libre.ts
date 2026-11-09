import type { PlacementLibre } from "../../../packages/noyau/src/accueil/schemas";

// Gestures of the free home (thousandths in width, pixels in height). Placing widgets without a position is done
// by the kernel (placerManquantsLibre): here, only snapping, guides and the gesture's bounds.
/** Horizontal snap step, in thousandths of the width. */
export const PAS_X = 5;
/** Vertical snap step, in pixels. */
export const PAS_Y = 8;
/** Thousandths of the home width (same value as the kernel; copied so as not to load zod in the interface). */
export const LARGEUR_LIBRE = 1000;
/** Columns and rows declared by a widget: the size sent to the display is rounded to these units. */
export const COLONNES = 12;
export const RANGEE_PX = 90;

const borner = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));
const aimantX = (x: number) => Math.round(x / PAS_X) * PAS_X;
const aimantY = (y: number) => Math.round(y / PAS_Y) * PAS_Y;

const chevauchent = (a: PlacementLibre, b: PlacementLibre) => a.x < b.x + b.l && b.x < a.x + a.l && a.y < b.y + b.h && b.y < a.y + a.h;

/** Declared sizes (units 1…12) to free units (thousandths, pixels): the copy of the kernel's `taillesLibres`. */
export function taillesLibres(t: { l: number; h: number }): { l: number; h: number } {
  return { l: Math.max(1, Math.round((t.l * LARGEUR_LIBRE) / COLONNES)), h: Math.max(1, t.h * RANGEE_PX) };
}

/** The reverse: the real size (thousandths, pixels) in rounded units, for `postMessage`. */
export function unitesLibres(t: { l: number; h: number }): { l: number; h: number } {
  return { l: Math.max(1, Math.round((t.l * COLONNES) / LARGEUR_LIBRE)), h: Math.max(1, Math.round(t.h / RANGEE_PX)) };
}

/**
 * The place of widget `p` if it were dropped at (x, y): snapped, within home, and stopped at another widget's edge
 * without moving it (the move pushes the preview off the others, it does not pack them). A drag passes over a
 * neighbor when the pointer aims beyond its opposite edge; only a pointer that overlaps it by the near edge
 * stops.
 */
export function deplacerLibre(o: { p: PlacementLibre; x: number; y: number; autres: readonly PlacementLibre[]; largeurPx: number }): PlacementLibre {
  const { p, autres, largeurPx } = o;
  // The pointer's target, fixed: bounds reached along the way do not change the gesture's direction.
  const cibleX = borner(aimantX(o.x), 0, LARGEUR_LIBRE - p.l);
  const cibleY = Math.max(0, aimantY(o.y));
  const dx = cibleX - p.x;
  const dy = cibleY - p.y;
  let x = cibleX;
  let y = cibleY;
  // Several walls may follow one another: we do another pass as long as another widget is touched.
  for (let tour = 0; tour < 8; tour++) {
    const gene = autres.find((a) => a.id !== p.id && chevauchent({ ...p, x, y }, a));
    if (!gene) break;
    // Crossing is only allowed if the targeted place is really free: the pointer's target may be beyond the
    // neighbor while the home edge brings the widget back onto it (we then stop at the near edge).
    const bornerX = () => {
      if (dx > 0) {
        if (cibleX >= gene.x + gene.l && !chevauchent({ ...p, x: cibleX, y }, gene)) x = cibleX;
        else x = Math.min(x, Math.max(p.x, gene.x - p.l));
      } else if (dx < 0) {
        if (cibleX + p.l <= gene.x && !chevauchent({ ...p, x: cibleX, y }, gene)) x = cibleX;
        else x = Math.min(p.x, Math.max(x, gene.x + gene.l));
      }
    };
    const bornerY = () => {
      if (dy > 0) {
        if (cibleY >= gene.y + gene.h && !chevauchent({ ...p, x, y: cibleY }, gene)) y = cibleY;
        else y = Math.min(y, Math.max(p.y, gene.y - p.h));
      } else if (dy < 0) {
        if (cibleY + p.h <= gene.y && !chevauchent({ ...p, x, y: cibleY }, gene)) y = cibleY;
        else y = Math.min(p.y, Math.max(y, gene.y + gene.h));
      }
    };
    // The last edge touched wins: the axis that moved the most is bounded first, the other only if the overlap
    // remains (a diagonal drag does not jump to the neighbor's corner). Both axes are compared in pixels.
    if (Math.abs(dx) * largeurPx >= Math.abs(dy) * LARGEUR_LIBRE) {
      bornerX();
      if (chevauchent({ ...p, x, y }, gene)) bornerY();
    } else {
      bornerY();
      if (chevauchent({ ...p, x, y }, gene)) bornerX();
    }
  }
  // A stop on a left edge coming from the right may aim at home's right edge: we stay there.
  x = borner(x, 0, LARGEUR_LIBRE - p.l);
  return { ...p, x, y };
}

/**
 * The size of widget `p` after a gesture: bounded between min and max, never beyond home's right edge, and
 * stopped at the left edge of a neighbor to its right or at the top edge of a neighbor that crosses its width, on the
 * left as on the right (never a written overlap).
 */
export function redimensionnerLibre(o: {
  p: PlacementLibre;
  l: number;
  h: number;
  min: { l: number; h: number };
  max: { l: number; h: number };
  autres: readonly PlacementLibre[];
}): PlacementLibre {
  const { p, min, max, autres } = o;
  const minL = Math.max(1, Math.min(min.l, LARGEUR_LIBRE));
  // Requested height: it tells which neighbors cross the height during the width computation.
  const hSouhaite = borner(aimantY(o.h), Math.max(1, min.h), max.h);
  // Only neighbors on the current rows block the width: a lower neighbor is stopped by the h computation.
  const vertical = (a: PlacementLibre) => a.id !== p.id && a.y < p.y + p.h && p.y < a.y + a.h;
  const bord = (depuis: number) => Math.min(LARGEUR_LIBRE, ...autres.filter((a) => vertical(a) && a.x >= depuis).map((a) => a.x));
  // The minimum does not fit before the neighbour (or the right edge): the widget moves back instead of going under its
  // minimum. It moves back without entering a neighbour on its left.
  const gauche = Math.max(0, ...autres.filter((a) => vertical(a) && a.x + a.l <= p.x).map((a) => a.x + a.l));
  const x = Math.max(gauche, Math.min(p.x, bord(p.x) - minL));
  const droite = bord(x);
  const xFinal = Math.max(gauche, Math.min(x, droite - minL));
  const maxL = Math.max(1, Math.min(max.l, droite - xFinal));
  const l = borner(aimantX(o.l), Math.max(1, Math.min(minL, maxL)), maxL);
  // Growing downward touches a neighbor as soon as the widths cross, whether it is on the left or the right.
  const dessous = autres
    .filter((a) => a.id !== p.id && a.x < xFinal + l && xFinal < a.x + a.l && a.y >= p.y)
    .map((a) => a.y - p.y);
  const hMax = Math.max(1, Math.min(max.h, ...dessous));
  return {
    ...p,
    x: xFinal,
    l,
    h: borner(hSouhaite, Math.max(1, min.h), hMax),
  };
}

/**
 * The guides to draw for preview `p`, in pixels: one line per edge or center aligned with another widget, or with
 * home's margins or center. Alignments are looked for within one snap step: the preview is snapped, the neighbor
 * may not be.
 */
export function guidesLibres(o: { p: PlacementLibre; autres: readonly PlacementLibre[]; largeurPx: number }): { x: number[]; y: number[] } {
  const { p, autres, largeurPx } = o;
  const px = (milliemes: number) => (milliemes / LARGEUR_LIBRE) * largeurPx;
  const autresX = autres.filter((a) => a.id !== p.id);
  const ciblesX = [0, largeurPx / 2, largeurPx, ...autresX.flatMap((a) => [px(a.x), px(a.x + a.l / 2), px(a.x + a.l)])];
  const ciblesY = autresX.flatMap((a) => [a.y, a.y + a.h / 2, a.y + a.h]);
  const alignes = (valeurs: number[], cibles: number[], tolerance: number) =>
    [...new Set(valeurs.filter((v) => cibles.some((c) => Math.abs(c - v) <= tolerance)).map((v) => Math.round(v * 100) / 100))];
  return {
    x: alignes([px(p.x), px(p.x + p.l / 2), px(p.x + p.l)], ciblesX, (PAS_X * largeurPx) / LARGEUR_LIBRE),
    y: alignes([p.y, p.y + p.h / 2, p.y + p.h], ciblesY, PAS_Y),
  };
}
