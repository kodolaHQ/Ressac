import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHalo, HALO_HOLD_MS } from "../core/halo";

let set: ReturnType<typeof vi.fn<(on: boolean) => void>>;
beforeEach(() => {
  vi.useFakeTimers();
  set = vi.fn<(on: boolean) => void>();
});
afterEach(() => vi.useRealTimers());

test("lights up as soon as the agent works", () => {
  createHalo(set).update(true);
  expect(set.mock.calls).toEqual([[true]]);
});

test("goes out HALO_HOLD_MS after the work ends", () => {
  expect(HALO_HOLD_MS).toBe(1500);
  const h = createHalo(set);
  h.update(true);
  h.update(false);
  vi.advanceTimersByTime(1499);
  expect(set.mock.calls).toEqual([[true]]);
  vi.advanceTimersByTime(1);
  expect(set.mock.calls).toEqual([[true], [false]]);
});

test("work resuming within the hold keeps it lit", () => {
  const h = createHalo(set);
  h.update(true);
  h.update(false);
  vi.advanceTimersByTime(800);
  h.update(true);
  vi.advanceTimersByTime(2000);
  expect(set.mock.calls).toEqual([[true]]);
});

test("set is called only on changes", () => {
  const h = createHalo(set);
  h.update(false);
  vi.advanceTimersByTime(2000);
  h.update(true);
  h.update(true);
  expect(set.mock.calls).toEqual([[true]]);
});

test("dispose cancels the planned switch-off", () => {
  const h = createHalo(set);
  h.update(true);
  h.update(false);
  h.dispose();
  vi.advanceTimersByTime(2000);
  expect(set.mock.calls).toEqual([[true]]);
});

test("off goes out at once and cancels the hold; then lights up again on work", () => {
  const h = createHalo(set);
  h.update(true);
  h.update(false);
  h.off();
  expect(set.mock.calls).toEqual([[true], [false]]);
  vi.advanceTimersByTime(2000);
  h.off();
  expect(set.mock.calls).toEqual([[true], [false]]);
  h.update(true);
  expect(set.mock.calls).toEqual([[true], [false], [true]]);
});
