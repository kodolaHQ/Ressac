import { describe, expect, it } from "vitest";
import type { FreePlacement } from "../../../packages/kernel/src/home/schemas";
import { moveFree, freeGuides, FREE_WIDTH, resizeFree } from "../ui/free-grid";

const place = (o: Partial<FreePlacement> = {}): FreePlacement => ({ id: "a", x: 0, y: 0, w: 200, h: 180, ...o });

describe("moveFree", () => {
  it("stops at another widget's edge without moving it", () => {
    const other = place({ id: "b", x: 400 });
    const r = moveFree({ p: place(), x: 350, y: 0, others: [other], widthPx: 1000 });
    expect(r).toEqual({ id: "a", x: 200, y: 0, w: 200, h: 180 });
    expect(other).toEqual({ id: "b", x: 400, y: 0, w: 200, h: 180 });
  });

  it("never goes beyond x + l ≤ 1000", () => {
    const r = moveFree({ p: place({ x: 100 }), x: 950, y: 0, others: [], widthPx: 1000 });
    expect(r.x + r.w).toBeLessThanOrEqual(FREE_WIDTH);
    expect(r.x).toBe(800);
  });

  it("also stops when coming from the right and from the bottom", () => {
    const other = place({ id: "b", x: 400, y: 200 });
    expect(moveFree({ p: place({ x: 700, y: 200 }), x: 450, y: 200, others: [other], widthPx: 1000 }).x).toBe(600);
    expect(moveFree({ p: place({ x: 400, y: 0 }), x: 400, y: 300, others: [other], widthPx: 1000 }).y).toBe(20);
  });

  it("does not teleport the preview on a diagonal drag: a single axis is bounded", () => {
    // The neighbour is at the bottom right; the horizontal axis moved the most: its left edge wins, y stays where the pointer
    // put it (no jump to the neighbour's (200, 20) corner).
    const other = place({ id: "b", x: 400, y: 200 });
    const r = moveFree({ p: place(), x: 350, y: 304, others: [other], widthPx: 1000 });
    expect(r.x).toBe(200);
    expect(r.y).toBe(304);
  });

  it("compares both axes in pixels: on a narrow home, the vertical wins", () => {
    // 350 ‰ of 500 px = 175 px, less than the 304 vertical px: the top edge wins.
    const other = place({ id: "b", x: 400, y: 200 });
    const r = moveFree({ p: place(), x: 350, y: 304, others: [other], widthPx: 500 });
    expect(r.x).toBe(350);
    expect(r.y).toBe(20);
  });

  it("a long drag crosses a neighbour up to the right edge, without moving it", () => {
    // The pointer goes well beyond the neighbour (500…750): the preview flies over it and stops at the right edge (1000 - 250).
    const other = place({ id: "b", x: 500, w: 250 });
    const r = moveFree({ p: place({ w: 250 }), x: 1200, y: 0, others: [other], widthPx: 1000 });
    expect(r.x).toBe(750);
    expect(r.x + r.w).toBe(FREE_WIDTH);
    expect(other).toEqual({ id: "b", x: 500, y: 0, w: 250, h: 180 });
  });

  it("a neighbour stuck to the right edge stops the drag: the targeted spot is taken", () => {
    // Target 1200 brought back to the right edge (750), which is exactly the 750…1000 neighbour: we stop at the near edge.
    const other = place({ id: "b", x: 750, w: 250 });
    const r = moveFree({ p: place({ w: 250 }), x: 1200, y: 0, others: [other], widthPx: 1000 });
    expect(r.x).toBe(500);
    expect(r.x + r.w).toBe(750);
  });
});

describe("resizeFree", () => {
  it("clamps the size between min and max", () => {
    const large = resizeFree({ p: place(), w: 900, h: 900, min: { w: 100, h: 90 }, max: { w: 500, h: 360 }, others: [] });
    expect(large).toMatchObject({ w: 500, h: 360 });
    const small = resizeFree({ p: place(), w: 1, h: 1, min: { w: 100, h: 90 }, max: { w: 500, h: 360 }, others: [] });
    expect(small).toMatchObject({ w: 100, h: 90 });
  });

  it("does not overflow the home's right side", () => {
    const r = resizeFree({ p: place({ x: 900 }), w: 300, h: 180, min: { w: 50, h: 90 }, max: { w: 500, h: 360 }, others: [] });
    expect(r.x + r.w).toBeLessThanOrEqual(FREE_WIDTH);
    expect(r.w).toBe(100);
  });

  it("stops at a neighbour's left edge, never overlapping", () => {
    const other = place({ id: "b", x: 500 });
    const r = resizeFree({ p: place(), w: 900, h: 180, min: { w: 167, h: 90 }, max: { w: 900, h: 360 }, others: [other] });
    expect(r.x + r.w).toBe(500);
    expect(r.w).toBe(500);
  });

  it("stops at the top edge of a neighbour placed at the bottom left (exact case from the review)", () => {
    // The neighbour overlaps the widget's width (300…600 vs 500…700) without being to its right: growing h would touch it.
    const p = place({ x: 500, y: 0, w: 200, h: 90 });
    const other = place({ id: "b", x: 300, y: 200, w: 300, h: 90 });
    const r = resizeFree({ p, w: 200, h: 290, min: { w: 100, h: 90 }, max: { w: 500, h: 360 }, others: [other] });
    expect(r.h).toBe(200);
    expect(r.y + r.h).toBeLessThanOrEqual(other.y);
    expect(r.x < other.x + other.w && other.x < r.x + r.w).toBe(true); // the widths do overlap
  });

  it("does not step back into a neighbour on its left when dragging for the minimum", () => {
    // p = 900…1000, neighbour on the left = 750…850: stepping back to fit the minimum (200 ‰) must not overlap it.
    const other = place({ id: "b", x: 750, y: 0, w: 100, h: 180 });
    const r = resizeFree({ p: place({ x: 900, w: 100, h: 180 }), w: 200, h: 180, min: { w: 200, h: 90 }, max: { w: 500, h: 360 }, others: [other] });
    expect(r.x).toBeGreaterThanOrEqual(other.x + other.w);
    expect(r.x + r.w).toBeLessThanOrEqual(FREE_WIDTH);
    expect(r.x < other.x + other.w && other.x < r.x + r.w && r.y < other.y + other.h && other.y < r.y + r.h).toBe(false);
  });

  it("steps back instead of going below the minimum near the right edge", () => {
    // The minimum (200 ‰) does not fit after x = 950: the widget slides left, its width stays at the minimum.
    const r = resizeFree({ p: place({ x: 950 }), w: 200, h: 180, min: { w: 200, h: 90 }, max: { w: 500, h: 360 }, others: [] });
    expect(r.x).toBe(800);
    expect(r.w).toBe(200);
    expect(r.x + r.w).toBe(FREE_WIDTH);
  });
});

describe("freeGuides", () => {
  it("returns a guide when the left edges coincide", () => {
    // 400 ‰ of 1280 px: the guide is returned in pixels, not in thousandths.
    const r = freeGuides({ p: place({ x: 400 }), others: [place({ id: "b", x: 400, y: 300 })], widthPx: 1280 });
    expect(r.x).toContain(512);
  });

  it("returns no guide without alignment", () => {
    const r = freeGuides({ p: place({ x: 100 }), others: [place({ id: "b", x: 700, y: 300 })], widthPx: 1000 });
    expect(r.x).not.toContain(100);
    expect(r.x).not.toContain(700);
  });

  it("returns a guide for an off-grid neighbour, within one snap step", () => {
    // Neighbour at 333 ‰, preview snapped at 335 ‰: 2 px apart, under the 5 ‰ step (5 px for 1000 px).
    const r = freeGuides({ p: place({ x: 335 }), others: [place({ id: "b", x: 333, y: 300 })], widthPx: 1000 });
    expect(r.x).toContain(335);
  });
});
