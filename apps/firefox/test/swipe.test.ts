import { expect, test } from "vitest";
import { createSwipe } from "../ui/components/swipe";

test("a two-finger swipe switches once, small or vertical moves never", () => {
  const got: number[] = [];
  let now = 0;
  const swipe = createSwipe((d) => got.push(d), () => now);
  // A small horizontal move, then a vertical scroll: nothing.
  swipe({ deltaX: 30, deltaY: 0 });
  now += 500;
  swipe({ deltaX: 50, deltaY: 200 });
  expect(got).toEqual([]);
  // A clear swipe to the left (fingers move left, deltaX > 0): the next space, once, momentum included.
  now += 500;
  for (let i = 0; i < 10; i++) (swipe({ deltaX: 40, deltaY: 0 }), (now += 16));
  expect(got).toEqual([1]);
  // After the gesture is over, a swipe to the right: the previous space.
  now += 500;
  for (let i = 0; i < 5; i++) (swipe({ deltaX: -40, deltaY: 0 }), (now += 16));
  expect(got).toEqual([1, -1]);
});

test("a strong swipe, its momentum uneven, moves one space only", () => {
  const got: number[] = [];
  let now = 0;
  const swipe = createSwipe((d) => got.push(d), () => now);
  // What a real trackpad sends: fingers past the threshold, then momentum that dips and rises again before it ends.
  [4, 30, 90, 140, 120, 60, 20, 8, 25, 60, 30, 6, 2, 9, 3, 1].forEach((x) => (swipe({ deltaX: x, deltaY: 0 }), (now += 16)));
  expect(got).toEqual([1]);
});
