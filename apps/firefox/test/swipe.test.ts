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

test("a second swipe during the first one's momentum still switches, one swipe never switches twice", () => {
  const got: number[] = [];
  let now = 0;
  const swipe = createSwipe((d) => got.push(d), () => now);
  const feed = (deltas: number[]) => deltas.forEach((x) => (swipe({ deltaX: x, deltaY: 0 }), (now += 16)));
  // Fingers accelerate past the threshold, then macOS momentum decays: one step.
  feed([4, 10, 20, 35, 50, 60, 40, 25, 14, 8, 4, 2, 1]);
  expect(got).toEqual([1]);
  // New fingers on the pad before the momentum is quiet: the deltas rise again, a second step.
  feed([3, 8, 18, 30, 45, 30, 10, 3, 1]);
  expect(got).toEqual([1, 1]);
});
