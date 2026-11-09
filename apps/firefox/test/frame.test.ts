import { describe, expect, it } from "vitest";
import { visibleFrame } from "../chrome/window/frame";

const screens = [{ x: 0, y: 0, width: 1440, height: 875 }];

describe("visibleFrame", () => {
  it("a frame off every screen is ignored", () => {
    expect(visibleFrame({ x: 3000, y: 100, width: 800, height: 600 }, screens)).toBeUndefined();
    expect(visibleFrame(null, screens)).toBeUndefined();
  });

  it("a frame overlapping a screen is kept, rounded", () => {
    expect(visibleFrame({ x: -100.4, y: 50.6, width: 999.5, height: 700.2 }, screens)).toEqual({ x: -100, y: 51, width: 1000, height: 700 });
  });
});
