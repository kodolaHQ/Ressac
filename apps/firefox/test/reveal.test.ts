import { describe, expect, it } from "vitest";
import { hide, INITIAL_REVEAL, onZone, leftZone, exitZone, type Reveal, type LeftZone } from "../shared/reveal";

/** Replays mouse positions (px from the left edge); a requested hide is applied right away. */
function walk(xs: number[], start: Reveal = INITIAL_REVEAL): boolean[] {
  let r = start;
  return xs.map((x) => {
    const zone = leftZone(x);
    const s = onZone(r, zone);
    r = s.hide ? hide(zone) : { revealed: s.revealed, armed: s.armed };
    return r.revealed;
  });
}

describe("left edge zones", () => {
  it("edge under 16 px, bar up to 280 px (240 + margin), far beyond", () => {
    expect([0, 15, 16, 239, 279, 280, 900].map(leftZone)).toEqual<LeftZone[]>(["edge", "edge", "bar", "bar", "bar", "far", "far"]);
  });
  it("a fast exit through the left counts as the edge", () => {
    expect(exitZone(40)).toBe("edge");
    expect(exitZone(60)).toBe("bar");
    expect(exitZone(500)).toBe("far");
  });
});

describe("compact-mode bar reveal", () => {
  it("reveals at the edge and stays open while the mouse is on the bar or its margin", () => {
    expect(walk([600, 100, 10, 3, 3, 100, 260, 279])).toEqual([false, false, true, true, true, true, true, true]);
  });
  it("a mouse still at the edge, seen again in the same place, closes nothing (the page shifted underneath)", () => {
    expect(walk([3, 3, 3, 3])).toEqual([true, true, true, true]);
  });
  it("closes beyond the bar and its margin", () => {
    const s = onZone({ revealed: true, armed: true }, "far");
    expect(s).toMatchObject({ revealed: true, hide: true });
    expect(walk([5, 120, 300])).toEqual([true, true, false]);
  });
  it("does not request a hide while the mouse stays on the bar", () => {
    expect(onZone({ revealed: true, armed: true }, "bar").hide).toBe(false);
    expect(onZone({ revealed: true, armed: true }, "edge").hide).toBe(false);
  });
  it("hidden with the mouse at the edge, it only comes back after the mouse left then found the edge again", () => {
    const r = hide("edge");
    expect(walk([3, 5, 2], r)).toEqual([false, false, false]);
    expect(walk([3, 40, 3], r)).toEqual([false, false, true]);
  });
});
