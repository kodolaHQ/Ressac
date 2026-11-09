import { expect, test } from "vitest";
import { rectCapture } from "../../core/design/viewfinder";

test("rectCapture: margin of 16 on each side, clamped to the view", () => {
  expect(rectCapture({ x: 10, y: 10, width: 100, height: 20 }, { width: 800, height: 600 }, 1)).toEqual({ x: 0, y: 0, width: 126, height: 46 });
});

test("rectCapture: the zoom doubles everything then clamps to 1600×1200", () => {
  expect(rectCapture({ x: 10, y: 10, width: 100, height: 20 }, { width: 800, height: 600 }, 2)).toEqual({ x: 4, y: 4, width: 232, height: 72 });
  expect(rectCapture({ x: 0, y: 0, width: 900, height: 700 }, { width: 800, height: 600 }, 2)).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
});

test("rectCapture: an element at the bottom-right edge is clamped to the view", () => {
  expect(rectCapture({ x: 700, y: 560, width: 100, height: 40 }, { width: 800, height: 600 }, 1)).toEqual({ x: 684, y: 544, width: 116, height: 56 });
});

test("rectCapture: offset by the frame's place in its page, after clamping to the frame's view", () => {
  expect(rectCapture({ x: 0, y: 0, width: 50, height: 20 }, { width: 800, height: 600 }, 1, { x: 10, y: 36 })).toEqual({ x: 10, y: 36, width: 66, height: 36 });
});
