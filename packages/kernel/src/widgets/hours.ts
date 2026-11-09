import type { WidgetState } from "../home/schemas.js";

/** A fixed hour that failed is retried at the earliest 15 min after the last attempt… */
export const RETRY_HOUR_MS = 15 * 60_000;
/** … at most 3 times after the first failure (4 attempts per slot), then we wait for the next hour. */
export const MAX_HOUR_RETRIES = 3;

export type HoursTracking = NonNullable<WidgetState["hours"]>;
/** What a real run does to the tracking: succeeded or partial, failed, or nothing (interrupted, grant, workshop). */
export type HourOutcome = "reussie" | "echec" | "sans-effet";

const two = (n: number) => String(n).padStart(2, "0");

/**
 * The day's last slot (local time, « YYYY-MM-DDTHH:MM ») reached at `maintenant`, or null before the first
 * hour: an hour missed the day before is never caught up, and several missed hours count as one.
 */
export function currentSlot(hours: readonly string[], now: Date): string | null {
  const current = `${two(now.getHours())}:${two(now.getMinutes())}`;
  // « HH:MM » on two digits: the order of the texts is that of the hours.
  const reached = hours.filter((h) => h <= current).sort().at(-1);
  if (!reached) return null;
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${reached}`;
}

/**
 * Does the current slot remain to be done? Not if it is already done; after a failure on this slot, only 15 min
 * after the last attempt, and as long as retries remain.
 */
export function dueHour(hours: readonly string[], tracking: WidgetState["hours"], lastAttempt: string | null, now: Date): boolean {
  const slot = currentSlot(hours, now);
  // « YYYY-MM-DDTHH:MM » sorts like dates: a slot older than the one done (back to winter time,
  // hour added earlier in the day) is already covered.
  if (!slot || (tracking?.done != null && tracking.done >= slot)) return false;
  if (tracking?.failures?.hour !== slot) return true;
  if (tracking.failures.count > MAX_HOUR_RETRIES) return false;
  // Since the most recent of the end of the failure (a watch can last 30 min) and of the last attempt (an attempt
  // with no effect, interrupted, may have followed the failure).
  const markers = [tracking.failures.end, lastAttempt].filter((x): x is string => !!x).map((x) => Date.parse(x));
  if (!markers.length) return true;
  return now.getTime() - Math.max(...markers) >= RETRY_HOUR_MS;
}

/**
 * The tracking after a real run started in slot `creneau` (and finished at `fin`, for a failure). Without a
 * slot (before the day's first hour), nothing changes: the previous day's tracking is not erased.
 */
export function trackingAfter(tracking: WidgetState["hours"], slot: string | null, outcome: HourOutcome, end?: string): HoursTracking {
  const current: HoursTracking = tracking ?? { done: null, failures: null };
  if (!slot || outcome === "sans-effet") return current;
  if (outcome === "reussie") {
    // The most recent slot done stays.
    if (current.done != null && current.done >= slot) return current;
    return { done: slot, failures: null };
  }
  const count = current.failures?.hour === slot ? current.failures.count + 1 : 1;
  return { done: current.done, failures: { hour: slot, count: count, ...(end ? { end: end } : {}) } };
}
