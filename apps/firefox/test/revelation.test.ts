import { describe, expect, it } from "vitest";
import { hide, INITIAL_REVEAL, onZone, leftZone, exitZone, type Reveal, type LeftZone } from "../shared/revelation";

/** Replays mouse positions (px from the left edge); a requested hide is applied right away. */
function walk(xs: number[], start: Reveal = INITIAL_REVEAL): boolean[] {
  let r = start;
  return xs.map((x) => {
    const zone = leftZone(x);
    const s = onZone(r, zone);
    r = s.masquer ? hide(zone) : { revelee: s.revelee, armee: s.armee };
    return r.revelee;
  });
}

describe("left edge zones", () => {
  it("edge under 16 px, bar up to 280 px (240 + margin), far beyond", () => {
    expect([0, 15, 16, 239, 279, 280, 900].map(leftZone)).toEqual<LeftZone[]>(["bord", "bord", "barre", "barre", "barre", "loin", "loin"]);
  });
  it("a fast exit through the left counts as the edge", () => {
    expect(exitZone(40)).toBe("bord");
    expect(exitZone(60)).toBe("barre");
    expect(exitZone(500)).toBe("loin");
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
    const s = onZone({ revelee: true, armee: true }, "loin");
    expect(s).toMatchObject({ revelee: true, masquer: true });
    expect(walk([5, 120, 300])).toEqual([true, true, false]);
  });
  it("does not request a hide while the mouse stays on the bar", () => {
    expect(onZone({ revelee: true, armee: true }, "barre").masquer).toBe(false);
    expect(onZone({ revelee: true, armee: true }, "bord").masquer).toBe(false);
  });
  it("hidden with the mouse at the edge, it only comes back after the mouse left then found the edge again", () => {
    const r = hide("bord");
    expect(walk([3, 5, 2], r)).toEqual([false, false, false]);
    expect(walk([3, 40, 3], r)).toEqual([false, false, true]);
  });
});
