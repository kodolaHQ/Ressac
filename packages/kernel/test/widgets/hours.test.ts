import { expect, test } from "vitest";
import type { WidgetState } from "../../src/home/schemas.js";
import { currentSlot, dueHour, RETRY_HOUR_MS, MAX_HOUR_RETRIES, trackingAfter } from "../../src/widgets/hours.js";

/** Local time of October 29, 2026 (or of the given day). */
const at = (h: number, m: number, day = 29) => new Date(2026, 9, day, h, m);
type Tracking = WidgetState["hours"];

test("values: 15 min between two attempts, 3 retries at most", () => {
  expect(RETRY_HOUR_MS).toBe(15 * 60_000);
  expect(MAX_HOUR_RETRIES).toBe(3);
});

test("07:00: not due at 06:59, due at 07:00, done after a success started at 07:00:30", () => {
  const hours = ["07:00"];
  expect(currentSlot(hours, at(6, 59))).toBeNull();
  expect(dueHour(hours, undefined, null, at(6, 59))).toBe(false);
  expect(currentSlot(hours, at(7, 0))).toBe("2026-10-29T07:00");
  expect(dueHour(hours, undefined, null, at(7, 0))).toBe(true);
  const start = new Date(2026, 9, 29, 7, 0, 30);
  const tracking = trackingAfter(undefined, currentSlot(hours, start), "succeeded");
  expect(tracking).toEqual({ done: "2026-10-29T07:00", failures: null });
  expect(dueHour(hours, tracking, start.toISOString(), at(7, 5))).toBe(false);
  expect(dueHour(hours, tracking, start.toISOString(), at(23, 59))).toBe(false);
});

test("07:00 and 12:00 missed, app opened at 3 pm: a single slot due (12:00)", () => {
  const hours = ["12:00", "07:00"]; // the declared order does not matter
  expect(currentSlot(hours, at(15, 0))).toBe("2026-10-29T12:00");
  expect(dueHour(hours, { done: "2026-10-28T12:00", failures: null }, null, at(15, 0))).toBe(true);
  // Once 12:00 is done, 07:00 is never caught up that day.
  const tracking = trackingAfter({ done: "2026-10-28T12:00", failures: null }, currentSlot(hours, at(15, 0)), "succeeded");
  for (const [h, m] of [[15, 1], [18, 0], [23, 59]] as const) expect(dueHour(hours, tracking, at(15, 0).toISOString(), at(h, m))).toBe(false);
});

test("Mac asleep from 6 am to 10 pm over several hours: a single catch-up on wake", () => {
  const hours = ["07:00", "09:00", "12:00", "18:00"];
  const tracking: Tracking = { done: "2026-10-28T18:00", failures: null };
  expect(dueHour(hours, tracking, null, at(6, 0))).toBe(false);
  // Wake at 10 pm: only 18:00 is due; once done, nothing until the next day 07:00.
  expect(currentSlot(hours, at(22, 0))).toBe("2026-10-29T18:00");
  const after = trackingAfter(tracking, currentSlot(hours, at(22, 0)), "succeeded");
  expect(dueHour(hours, after, at(22, 0).toISOString(), at(22, 1))).toBe(false);
  expect(dueHour(hours, after, at(22, 0).toISOString(), at(6, 59, 30))).toBe(false);
  expect(dueHour(hours, after, at(22, 0).toISOString(), at(7, 0, 30))).toBe(true);
});

test("missed the day before: nothing before 07:00 the next day (midnight included)", () => {
  const hours = ["07:00", "22:00"];
  // 22:00 missed on the 29th; at midnight and after, the 30th, nothing is due before 07:00.
  const tracking: Tracking = { done: "2026-10-29T07:00", failures: null };
  expect(dueHour(hours, tracking, null, at(23, 59))).toBe(true);
  for (const [h, m] of [[0, 0], [0, 1], [6, 59]] as const) {
    expect(currentSlot(hours, at(h, m, 30))).toBeNull();
    expect(dueHour(hours, tracking, null, at(h, m, 30))).toBe(false);
  }
  expect(currentSlot(hours, at(7, 0, 30))).toBe("2026-10-30T07:00");
  expect(dueHour(hours, tracking, null, at(7, 0, 30))).toBe(true);
  // The same hour, done the day before, is due again the next day.
  expect(dueHour(["07:00"], { done: "2026-10-29T07:00", failures: null }, null, at(7, 0, 30))).toBe(true);
});

test("failure: due again 15 min later, 3 retries at most, then nothing until the next hour", () => {
  const hours = ["07:00", "12:00"];
  let tracking: Tracking = { done: "2026-10-28T12:00", failures: null };
  let attempt = at(7, 0);
  const attempts: string[] = [];
  // Every minute from 07:00 to 11:59: each time it is due, the run fails.
  for (let t = at(7, 0).getTime(); t < at(12, 0).getTime(); t += 60_000) {
    const now = new Date(t);
    if (!dueHour(hours, tracking, attempts.length ? attempt.toISOString() : null, now)) continue;
    attempt = now;
    attempts.push(`${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`);
    tracking = trackingAfter(tracking, currentSlot(hours, now), "failure");
  }
  expect(attempts).toEqual(["7:00", "7:15", "7:30", "7:45"]);
  expect(tracking).toEqual({ done: "2026-10-28T12:00", failures: { hour: "2026-10-29T07:00", count: 4 } });
  // The next hour starts from zero.
  expect(dueHour(hours, tracking, attempt.toISOString(), at(12, 0))).toBe(true);
  expect(trackingAfter(tracking, "2026-10-29T12:00", "failure").failures).toEqual({ hour: "2026-10-29T12:00", count: 1 });
  // A success erases the failures.
  expect(trackingAfter(tracking, "2026-10-29T07:00", "succeeded")).toEqual({ done: "2026-10-29T07:00", failures: null });
});

test("a manual run at 07:10 counts for 07:00; one at 06:50 does not count", () => {
  const hours = ["07:00"];
  const watch: Tracking = { done: "2026-10-28T07:00", failures: null };
  const tot = trackingAfter(watch, currentSlot(hours, at(6, 50)), "succeeded");
  // Before the first hour of the day: no effect, the previous day is not erased.
  expect(tot).toEqual(watch);
  expect(dueHour(hours, tot, at(6, 50).toISOString(), at(7, 0))).toBe(true);
  const manual = trackingAfter(tot, currentSlot(hours, at(7, 10)), "succeeded");
  expect(manual).toEqual({ done: "2026-10-29T07:00", failures: null });
  expect(dueHour(hours, manual, at(7, 10).toISOString(), at(7, 30))).toBe(false);
});

test("trackingAfter: sans-effet changes nothing; a failure before the first hour neither; nothing new without tracking", () => {
  const tracking: Tracking = { done: "2026-10-29T07:00", failures: { hour: "2026-10-29T12:00", count: 2 } };
  expect(trackingAfter(tracking, "2026-10-29T12:00", "no-effect")).toEqual(tracking);
  expect(trackingAfter(tracking, null, "failure")).toEqual(tracking);
  expect(trackingAfter(undefined, null, "succeeded")).toEqual({ done: null, failures: null });
  expect(trackingAfter(undefined, "2026-10-29T07:00", "failure")).toEqual({ done: null, failures: { hour: "2026-10-29T07:00", count: 1 } });
});

test("failure of a long run: the 15 min count from its end", () => {
  const hours = ["07:00"];
  // Started at 07:00, failed at 07:30.
  const tracking = trackingAfter(undefined, "2026-10-29T07:00", "failure", at(7, 30).toISOString());
  expect(tracking).toEqual({ done: null, failures: { hour: "2026-10-29T07:00", count: 1, end: at(7, 30).toISOString() } });
  expect(dueHour(hours, tracking, at(7, 0).toISOString(), at(7, 30))).toBe(false);
  expect(dueHour(hours, tracking, at(7, 0).toISOString(), at(7, 44))).toBe(false);
  expect(dueHour(hours, tracking, at(7, 0).toISOString(), at(7, 45))).toBe(true);
});

test("a slot older than the one already done is never redone (back to winter time, hour added earlier)", () => {
  // 02:45 done, the clock goes back to 02:00: the 02:00 slot is already covered.
  expect(dueHour(["02:00", "02:45"], { done: "2026-10-25T02:45", failures: null }, null, new Date(2026, 9, 25, 2, 10))).toBe(false);
  // 07:00 done, 06:00 added during the day.
  expect(dueHour(["06:00", "07:00"], { done: "2026-10-29T07:00", failures: null }, null, at(6, 30))).toBe(false);
  // A success for an older slot keeps the most recent one.
  expect(trackingAfter({ done: "2026-10-29T07:00", failures: null }, "2026-10-29T06:00", "succeeded")).toEqual({ done: "2026-10-29T07:00", failures: null });
});

test("F4: after a failure, a more recent no-effect attempt (interrupted watch) pushes the retry back by 15 min", () => {
  const hours = ["07:00"];
  // Failure ended at 07:20; then an attempt at 07:40, interrupted (no effect on the tracking).
  const tracking: Tracking = { done: null, failures: { hour: "2026-10-29T07:00", count: 1, end: at(7, 20).toISOString() } };
  const attempt = at(7, 40).toISOString();
  expect(dueHour(hours, tracking, attempt, at(7, 45))).toBe(false);
  expect(dueHour(hours, tracking, attempt, at(7, 55))).toBe(true);
  // And the reverse: a failure end more recent than the attempt (30 min watch) still counts.
  const long: Tracking = { done: null, failures: { hour: "2026-10-29T07:00", count: 1, end: at(7, 30).toISOString() } };
  expect(dueHour(hours, long, at(7, 0).toISOString(), at(7, 40))).toBe(false);
  expect(dueHour(hours, long, at(7, 0).toISOString(), at(7, 45))).toBe(true);
});
