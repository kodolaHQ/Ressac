import type { FreePlacement } from "../../../packages/kernel/src/home/schemas";

// Gestures of the free home (thousandths in width, pixels in height). Placing widgets without a position is done
// by the kernel (placeMissingFree): here, only snapping, guides and the gesture's bounds.
/** Horizontal snap step, in thousandths of the width. */
export const STEP_X = 5;
/** Vertical snap step, in pixels. */
export const STEP_Y = 8;
/** Thousandths of the home width (same value as the kernel; copied so as not to load zod in the interface). */
export const FREE_WIDTH = 1000;
/** Columns and rows declared by a widget: the size sent to the display is rounded to these units. */
export const COLUMNS = 12;
export const ROW_PX = 90;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));
const snapX = (x: number) => Math.round(x / STEP_X) * STEP_X;
const snapY = (y: number) => Math.round(y / STEP_Y) * STEP_Y;

const overlap = (a: FreePlacement, b: FreePlacement) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Declared sizes (units 1…12) to free units (thousandths, pixels): the copy of the kernel's `freeSizes`. */
export function freeSizes(t: { w: number; h: number }): { w: number; h: number } {
  return { w: Math.max(1, Math.round((t.w * FREE_WIDTH) / COLUMNS)), h: Math.max(1, t.h * ROW_PX) };
}

/** The reverse: the real size (thousandths, pixels) in rounded units, for `postMessage`. */
export function freeUnits(t: { w: number; h: number }): { w: number; h: number } {
  return { w: Math.max(1, Math.round((t.w * COLUMNS) / FREE_WIDTH)), h: Math.max(1, Math.round(t.h / ROW_PX)) };
}

/**
 * The place of widget `p` if it were dropped at (x, y): snapped, within home, and stopped at another widget's edge
 * without moving it (the move pushes the preview off the others, it does not pack them). A drag passes over a
 * neighbor when the pointer aims beyond its opposite edge; only a pointer that overlaps it by the near edge
 * stops.
 */
export function moveFree(o: { p: FreePlacement; x: number; y: number; others: readonly FreePlacement[]; widthPx: number }): FreePlacement {
  const { p, others: others, widthPx: widthPx } = o;
  // The pointer's target, fixed: bounds reached along the way do not change the gesture's direction.
  const targetX = clamp(snapX(o.x), 0, FREE_WIDTH - p.w);
  const targetY = Math.max(0, snapY(o.y));
  const dx = targetX - p.x;
  const dy = targetY - p.y;
  let x = targetX;
  let y = targetY;
  // Several walls may follow one another: we do another pass as long as another widget is touched.
  for (let turn = 0; turn < 8; turn++) {
    const blocker = others.find((a) => a.id !== p.id && overlap({ ...p, x, y }, a));
    if (!blocker) break;
    // Crossing is only allowed if the targeted place is really free: the pointer's target may be beyond the
    // neighbor while the home edge brings the widget back onto it (we then stop at the near edge).
    const clampX = () => {
      if (dx > 0) {
        if (targetX >= blocker.x + blocker.w && !overlap({ ...p, x: targetX, y }, blocker)) x = targetX;
        else x = Math.min(x, Math.max(p.x, blocker.x - p.w));
      } else if (dx < 0) {
        if (targetX + p.w <= blocker.x && !overlap({ ...p, x: targetX, y }, blocker)) x = targetX;
        else x = Math.min(p.x, Math.max(x, blocker.x + blocker.w));
      }
    };
    const clampY = () => {
      if (dy > 0) {
        if (targetY >= blocker.y + blocker.h && !overlap({ ...p, x, y: targetY }, blocker)) y = targetY;
        else y = Math.min(y, Math.max(p.y, blocker.y - p.h));
      } else if (dy < 0) {
        if (targetY + p.h <= blocker.y && !overlap({ ...p, x, y: targetY }, blocker)) y = targetY;
        else y = Math.min(p.y, Math.max(y, blocker.y + blocker.h));
      }
    };
    // The last edge touched wins: the axis that moved the most is bounded first, the other only if the overlap
    // remains (a diagonal drag does not jump to the neighbor's corner). Both axes are compared in pixels.
    if (Math.abs(dx) * widthPx >= Math.abs(dy) * FREE_WIDTH) {
      clampX();
      if (overlap({ ...p, x, y }, blocker)) clampY();
    } else {
      clampY();
      if (overlap({ ...p, x, y }, blocker)) clampX();
    }
  }
  // A stop on a left edge coming from the right may aim at home's right edge: we stay there.
  x = clamp(x, 0, FREE_WIDTH - p.w);
  return { ...p, x, y };
}

/**
 * The size of widget `p` after a gesture: bounded between min and max, never beyond home's right edge, and
 * stopped at the left edge of a neighbor to its right or at the top edge of a neighbor that crosses its width, on the
 * left as on the right (never a written overlap).
 */
export function resizeFree(o: {
  p: FreePlacement;
  w: number;
  h: number;
  min: { w: number; h: number };
  max: { w: number; h: number };
  others: readonly FreePlacement[];
}): FreePlacement {
  const { p, min, max, others: others } = o;
  const minL = Math.max(1, Math.min(min.w, FREE_WIDTH));
  // Requested height: it tells which neighbors cross the height during the width computation.
  const wantedH = clamp(snapY(o.h), Math.max(1, min.h), max.h);
  // Only neighbors on the current rows block the width: a lower neighbor is stopped by the h computation.
  const vertical = (a: FreePlacement) => a.id !== p.id && a.y < p.y + p.h && p.y < a.y + a.h;
  const edge = (from: number) => Math.min(FREE_WIDTH, ...others.filter((a) => vertical(a) && a.x >= from).map((a) => a.x));
  // The minimum does not fit before the neighbour (or the right edge): the widget moves back instead of going under its
  // minimum. It moves back without entering a neighbour on its left.
  const left = Math.max(0, ...others.filter((a) => vertical(a) && a.x + a.w <= p.x).map((a) => a.x + a.w));
  const x = Math.max(left, Math.min(p.x, edge(p.x) - minL));
  const right = edge(x);
  const xFinal = Math.max(left, Math.min(x, right - minL));
  const maxL = Math.max(1, Math.min(max.w, right - xFinal));
  const w = clamp(snapX(o.w), Math.max(1, Math.min(minL, maxL)), maxL);
  // Growing downward touches a neighbor as soon as the widths cross, whether it is on the left or the right.
  const below = others
    .filter((a) => a.id !== p.id && a.x < xFinal + w && xFinal < a.x + a.w && a.y >= p.y)
    .map((a) => a.y - p.y);
  const hMax = Math.max(1, Math.min(max.h, ...below));
  return {
    ...p,
    x: xFinal,
    w,
    h: clamp(wantedH, Math.max(1, min.h), hMax),
  };
}

/**
 * The guides to draw for preview `p`, in pixels: one line per edge or center aligned with another widget, or with
 * home's margins or center. Alignments are looked for within one snap step: the preview is snapped, the neighbor
 * may not be.
 */
export function freeGuides(o: { p: FreePlacement; others: readonly FreePlacement[]; widthPx: number }): { x: number[]; y: number[] } {
  const { p, others: others, widthPx: widthPx } = o;
  const px = (thousandths: number) => (thousandths / FREE_WIDTH) * widthPx;
  const otherXs = others.filter((a) => a.id !== p.id);
  const targetXs = [0, widthPx / 2, widthPx, ...otherXs.flatMap((a) => [px(a.x), px(a.x + a.w / 2), px(a.x + a.w)])];
  const targetYs = otherXs.flatMap((a) => [a.y, a.y + a.h / 2, a.y + a.h]);
  const aligned = (values: number[], targets: number[], tolerance: number) =>
    [...new Set(values.filter((v) => targets.some((c) => Math.abs(c - v) <= tolerance)).map((v) => Math.round(v * 100) / 100))];
  return {
    x: aligned([px(p.x), px(p.x + p.w / 2), px(p.x + p.w)], targetXs, (STEP_X * widthPx) / FREE_WIDTH),
    y: aligned([p.y, p.y + p.h / 2, p.y + p.h], targetYs, STEP_Y),
  };
}
