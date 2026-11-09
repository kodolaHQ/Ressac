import { expect, test } from "vitest";
import { nextRun } from "../ui/components/next";

// Fixed clocks, local time (like the declared hours).
const a = (h: number, m = 0) => new Date(2026, 9, 29, h, m, 0, 0);

test("at 06:00 with 07:00: today 07:00", () => {
  expect(nextRun(["07:00"], a(6))).toBe("aujourd'hui 07:00");
});

test("at 08:00 with 07:00: tomorrow 07:00", () => {
  expect(nextRun(["07:00"], a(8))).toBe("demain 07:00");
});

test("without hours: null", () => {
  expect(nextRun([], a(8))).toBeNull();
});

test("the nearest of the upcoming hours, whatever their order; the current hour is past", () => {
  expect(nextRun(["19:00", "07:00", "12:30"], a(8))).toBe("aujourd'hui 12:30");
  expect(nextRun(["19:00", "07:00"], a(19, 0))).toBe("demain 07:00");
  expect(nextRun(["19:00", "07:00"], a(18, 59))).toBe("aujourd'hui 19:00");
  expect(nextRun(["00:00"], a(23, 59))).toBe("demain 00:00");
});

test("minutes and hours: the nearest of the two (derniereMaj + minutes, or the next hour)", () => {
  const update = (h: number, m = 0) => a(h, m).toISOString();
  // Frequency nearer than the hour.
  expect(nextRun(["19:00"], a(8), { minutes: 120, derniereMaj: update(7, 30) })).toBe("aujourd'hui 09:30");
  // Hour nearer than the frequency.
  expect(nextRun(["09:00"], a(8), { minutes: 120, derniereMaj: update(7, 30) })).toBe("aujourd'hui 09:00");
  // Frequency tomorrow, nearer than tomorrow's hour.
  expect(nextRun(["07:00"], a(23), { minutes: 90, derniereMaj: update(23) })).toBe("demain 00:30");
  // Frequency already exceeded, or never harvested: right away.
  expect(nextRun(["19:00"], a(8, 15), { minutes: 60, derniereMaj: update(6) })).toBe("aujourd'hui 08:15");
  expect(nextRun(["19:00"], a(8, 15), { minutes: 60, derniereMaj: null })).toBe("aujourd'hui 08:15");
  // Without hours: nothing, as before (the frequency alone is not displayed).
  expect(nextRun([], a(8), { minutes: 60, derniereMaj: update(7) })).toBeNull();
});

// Scheduler rules (packages/kernel/src/widgets/heures.ts and planificateur.ts): a failure is retried 15 min
// after the last attempt (or the end of the failure), never « now ».
const iso = (h: number, m = 0) => a(h, m).toISOString();
const inError = (lastAttempt: string | null, hours?: { faite: string | null; echecs: { heure: string; nombre: number; fin?: string } | null }) => ({
  statut: "erreur" as const,
  derniereTentative: lastAttempt,
  ...(hours ? { heures: hours } : {}),
});

test("frequency in error: 15 min after the last attempt, not now", () => {
  // Old data (long overdue), failure at 08:10: next at 08:25.
  expect(nextRun(["19:00"], a(8, 15), { minutes: 60, derniereMaj: iso(6) }, inError(iso(8, 10)))).toBe("aujourd'hui 08:25");
  // Never harvested, failure at 08:10: same.
  expect(nextRun(["19:00"], a(8, 15), { minutes: 60, derniereMaj: null }, inError(iso(8, 10)))).toBe("aujourd'hui 08:25");
  // The frequency further than the 15 min: the frequency.
  expect(nextRun(["19:00"], a(8, 15), { minutes: 60, derniereMaj: iso(8) }, inError(iso(8, 5)))).toBe("aujourd'hui 09:00");
  // The 15 min already passed: right away.
  expect(nextRun(["19:00"], a(8, 30), { minutes: 60, derniereMaj: iso(6) }, inError(iso(8, 10)))).toBe("aujourd'hui 08:30");
  // Status ok: the attempt does not count (like the scheduler).
  expect(nextRun(["19:00"], a(8, 15), { minutes: 60, derniereMaj: iso(6) }, { statut: "ok", derniereTentative: iso(8, 10) })).toBe("aujourd'hui 08:15");
});

test("fixed hour in failure: retry 15 min after the later of the failure's end and the last attempt", () => {
  const failure = (count: number, fin?: string) => ({ faite: null, echecs: { heure: "2026-10-29T07:00", nombre: count, ...(fin ? { fin } : {}) } });
  // Failure of the 07:00 slot, attempt at 07:00, watch finished at 07:30: retry at 07:45.
  expect(nextRun(["07:00", "19:00"], a(7, 35), undefined, inError(iso(7), failure(1, iso(7, 30))))).toBe("aujourd'hui 07:45");
  // Without an end: since the last attempt.
  expect(nextRun(["07:00", "19:00"], a(7, 5), undefined, inError(iso(7), failure(1)))).toBe("aujourd'hui 07:15");
  // Attempt more recent than the failure's end (interrupted afterwards): since the attempt.
  expect(nextRun(["07:00", "19:00"], a(8), undefined, inError(iso(7, 50), failure(2, iso(7, 20))))).toBe("aujourd'hui 08:05");
  // Retry due: right away.
  expect(nextRun(["07:00", "19:00"], a(8), undefined, inError(iso(7), failure(1, iso(7, 10))))).toBe("aujourd'hui 08:00");
  // No more retry (3 already done, 4 failures): the next hour.
  expect(nextRun(["07:00", "19:00"], a(8), undefined, inError(iso(7, 50), failure(4, iso(7, 55))))).toBe("aujourd'hui 19:00");
  // The retry would fall after the next hour: the next hour.
  expect(nextRun(["07:00", "07:30"], a(7, 20), undefined, inError(iso(7, 20), failure(1)))).toBe("aujourd'hui 07:30");
  // The failing slot is yesterday's: no retry, the next hour.
  expect(nextRun(["07:00"], a(6), undefined, inError(iso(7), { faite: null, echecs: { heure: "2026-10-28T07:00", nombre: 1 } }))).toBe("aujourd'hui 07:00");
  // Slot already done: the next hour.
  expect(nextRun(["07:00", "19:00"], a(8), undefined, inError(iso(7), { faite: "2026-10-29T07:00", echecs: { heure: "2026-10-29T07:00", nombre: 1 } }))).toBe("aujourd'hui 19:00");
});

test("fixed hour in failure in the evening: a retry after midnight does not happen (yesterday's slot is never caught up)", () => {
  const failure = { faite: null, echecs: { heure: "2026-10-29T23:50", nombre: 1 } };
  expect(nextRun(["07:00", "23:50"], a(23, 55), undefined, inError(iso(23, 50), failure))).toBe("demain 07:00");
});

test("hours and frequency in error: the nearest of the two rules", () => {
  const failure = { faite: null, echecs: { heure: "2026-10-29T07:00", nombre: 1, fin: iso(7, 30) } };
  // Frequency: max(06:00 + 60 min, 07:30 + 15 min) = 07:45; hour: retry at 07:45 too.
  expect(nextRun(["07:00", "19:00"], a(7, 35), { minutes: 60, derniereMaj: iso(6) }, inError(iso(7, 30), failure))).toBe("aujourd'hui 07:45");
});
