import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { commonRuns, createMarks, MARKS_EVERY_MS } from "../core/hide/marks";

type Rect = { x: number; y: number; width: number; height: number };
const R: Rect = { x: 1, y: 2, width: 3, height: 4 };

let draw: ReturnType<typeof vi.fn<(r: Rect[] | null) => void>>;
let pending: ((r: Rect[]) => void)[];
let measure: ReturnType<typeof vi.fn<() => Promise<Rect[]>>>;
const marks = () => createMarks({ measure, draw, setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) });
/** Resolves the oldest measure in flight and lets its draw run. */
const answer = async (r: Rect[] = [R]) => {
  pending.shift()!(r);
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  draw = vi.fn();
  pending = [];
  measure = vi.fn(() => new Promise<Rect[]>((r) => pending.push(r)));
});
afterEach(() => vi.useRealTimers());

test("start measures once, at once, and draws the answer", async () => {
  marks().start();
  expect(measure).toHaveBeenCalledTimes(1);
  await answer();
  expect(draw.mock.calls).toEqual([[[R]]]);
  await vi.advanceTimersByTimeAsync(5 * MARKS_EVERY_MS);
  expect(measure).toHaveBeenCalledTimes(1);
});

test("three nudges within MARKS_EVERY_MS make one more measure", async () => {
  expect(MARKS_EVERY_MS).toBe(250);
  const m = marks();
  m.start();
  await answer();
  m.nudge();
  await vi.advanceTimersByTimeAsync(100);
  m.nudge();
  await vi.advanceTimersByTimeAsync(100);
  m.nudge();
  expect(measure).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(50);
  expect(measure).toHaveBeenCalledTimes(2);
  await answer();
  await vi.advanceTimersByTimeAsync(5 * MARKS_EVERY_MS);
  expect(measure).toHaveBeenCalledTimes(2);
});

test("a nudge while a measure is in flight waits for it, then for the pause", async () => {
  const m = marks();
  m.start();
  m.nudge();
  await vi.advanceTimersByTimeAsync(5 * MARKS_EVERY_MS);
  expect(measure).toHaveBeenCalledTimes(1);
  await answer();
  await vi.advanceTimersByTimeAsync(MARKS_EVERY_MS);
  expect(measure).toHaveBeenCalledTimes(2);
});

test("stop draws null and cancels the pending measure", async () => {
  const m = marks();
  m.start();
  await answer();
  m.nudge();
  m.stop();
  expect(draw.mock.calls.at(-1)).toEqual([null]);
  await vi.advanceTimersByTimeAsync(5 * MARKS_EVERY_MS);
  expect(measure).toHaveBeenCalledTimes(1);
  m.nudge();
  expect(measure).toHaveBeenCalledTimes(1);
});

test("a measure that resolves after stop is not drawn", async () => {
  const m = marks();
  m.start();
  m.stop();
  await answer();
  expect(draw.mock.calls).toEqual([[null]]);
});

test("a measure of the page before a restart is not drawn over the new one", async () => {
  const m = marks();
  m.start();
  m.stop();
  m.start();
  await answer([R]); // the first page's
  await answer([]);
  expect(draw.mock.calls).toEqual([[null], [[]]]);
});

test("a measure that fails draws nothing over the page", async () => {
  measure.mockImplementationOnce(() => Promise.reject(new Error("gone")));
  marks().start();
  await vi.advanceTimersByTimeAsync(0);
  expect(draw.mock.calls).toEqual([[[]]]);
});

test("commonRuns: only what every window with a session masks; a window without one is left out", () => {
  const run = (start: number, end: number) => ({ start, end });
  expect(commonRuns([])).toEqual([]);
  expect(commonRuns([null, null])).toEqual([]);
  expect(commonRuns([[run(5, 9), run(0, 3)], null])).toEqual([run(0, 3), run(5, 9)]);
  // One conversation masks the name, another masks nothing: no hatch.
  expect(commonRuns([[run(0, 14)], []])).toEqual([]);
  expect(commonRuns([[run(0, 10), run(8, 14)], [run(4, 20)], null])).toEqual([run(4, 14)]);
  expect(commonRuns([[run(0, 5), run(10, 15)], [run(3, 12)]])).toEqual([run(3, 5), run(10, 12)]);
});
