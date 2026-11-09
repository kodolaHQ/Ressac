import { expect, test } from "vitest";
import { GESTURE_DELAY_MS, gestureGuard } from "../shared/widget-gesture";

function clock() {
  const h = { t: 10_000, maintenant: () => h.t };
  return h;
}

test("without a real gesture, no link", () => {
  const g = gestureGuard<string>(clock().maintenant);
  expect(g.accepter("f1", "meteo")).toBe(false);
});

test("a recent gesture from the right widget accepts a single link", () => {
  const h = clock();
  const g = gestureGuard<string>(h.maintenant);
  g.geste("f1", "meteo");
  h.t += 400;
  expect(g.accepter("f1", "meteo")).toBe(true);
  expect(g.accepter("f1", "meteo")).toBe(false);
});

test("a gesture from another widget refuses, and does not use it up", () => {
  const g = gestureGuard<string>(clock().maintenant);
  g.geste("f1", "meteo");
  expect(g.accepter("f1", "actus")).toBe(false);
  expect(g.accepter("f1", "meteo")).toBe(true);
});

test("a gesture from another window does not count", () => {
  const g = gestureGuard<string>(clock().maintenant);
  g.geste("f2", "meteo");
  expect(g.accepter("f1", "meteo")).toBe(false);
  expect(g.accepter("f2", "meteo")).toBe(true);
});

test("a gesture older than 1,500 ms refuses", () => {
  const h = clock();
  const g = gestureGuard<string>(h.maintenant);
  expect(GESTURE_DELAY_MS).toBe(1500);
  g.geste("f1", "meteo");
  h.t += 1400;
  expect(g.accepter("f1", "meteo")).toBe(true);
  g.geste("f1", "meteo");
  h.t += 1600;
  expect(g.accepter("f1", "meteo")).toBe(false);
});
