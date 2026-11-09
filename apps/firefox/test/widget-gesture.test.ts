import { expect, test } from "vitest";
import { GESTURE_DELAY_MS, gestureGuard } from "../shared/widget-gesture";

function clock() {
  const h = { t: 10_000, now: () => h.t };
  return h;
}

test("without a real gesture, no link", () => {
  const g = gestureGuard<string>(clock().now);
  expect(g.accept("f1", "meteo")).toBe(false);
});

test("a recent gesture from the right widget accepts a single link", () => {
  const h = clock();
  const g = gestureGuard<string>(h.now);
  g.gesture("f1", "meteo");
  h.t += 400;
  expect(g.accept("f1", "meteo")).toBe(true);
  expect(g.accept("f1", "meteo")).toBe(false);
});

test("a gesture from another widget refuses, and does not use it up", () => {
  const g = gestureGuard<string>(clock().now);
  g.gesture("f1", "meteo");
  expect(g.accept("f1", "actus")).toBe(false);
  expect(g.accept("f1", "meteo")).toBe(true);
});

test("a gesture from another window does not count", () => {
  const g = gestureGuard<string>(clock().now);
  g.gesture("f2", "meteo");
  expect(g.accept("f1", "meteo")).toBe(false);
  expect(g.accept("f2", "meteo")).toBe(true);
});

test("a gesture older than 1,500 ms refuses", () => {
  const h = clock();
  const g = gestureGuard<string>(h.now);
  expect(GESTURE_DELAY_MS).toBe(1500);
  g.gesture("f1", "meteo");
  h.t += 1400;
  expect(g.accept("f1", "meteo")).toBe(true);
  g.gesture("f1", "meteo");
  h.t += 1600;
  expect(g.accept("f1", "meteo")).toBe(false);
});
