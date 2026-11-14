import type { WidgetState } from "@ressac/kernel";
import { format } from "../../shared/i18n";

const two = (n: number) => String(n).padStart(2, "0");
const MINUTE = 60_000;
// Copied from the scheduler (packages/kernel/src/widgets/heures.ts: RETRY_HOUR_MS, MAX_HOUR_RETRIES;
// scheduler.ts: RETRY_ERROR_MS): the rendering only imports types from the kernel.
/** A failure is retried at the earliest 15 min after the last attempt (or the end of the failure, for a fixed hour). */
const RETRY_MS = 15 * MINUTE;
/** At most 3 retries at a fixed hour after its first failure. */
const MAX_HOUR_RETRIES = 3;

/** What « prochaine » reads from the widget's state: the scheduler's rules after a failure. */
export type NextState = Pick<WidgetState, "status" | "lastAttempt" | "hours">;

/** « aujourd'hui HH:MM » or « demain HH:MM » (never further: a fixed hour comes back tomorrow at the latest). */
function label(when: Date, now: Date, locale: string): string {
  const sameDay = when.toDateString() === now.toDateString();
  return format(locale, sameDay ? "sidebar-next-today" : "sidebar-next-tomorrow", { time: `${two(when.getHours())}:${two(when.getMinutes())}` });
}

const instant = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * The retry of the failed fixed hour of the current slot, like `heureDue` (hours.ts): 15 min after the later of the
 * end of the failure and the last attempt, as long as retries remain and only the same day (yesterday's slot is
 * never caught up). Null with no retry to come.
 */
function retryHour(hours: readonly string[], now: Date, appState: NextState | undefined): Date | null {
  const tracking = appState?.hours;
  if (!appState || !tracking?.failures) return null;
  const current = `${two(now.getHours())}:${two(now.getMinutes())}`;
  const reached = hours.filter((h) => h <= current).sort().at(-1);
  if (!reached) return null;
  const slot = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}T${reached}`;
  if (tracking.done != null && tracking.done >= slot) return null;
  if (tracking.failures.hour !== slot || tracking.failures.count > MAX_HOUR_RETRIES) return null;
  const markers = [tracking.failures.end, appState.lastAttempt].map(instant).filter((t) => !Number.isNaN(t));
  const when = new Date(Math.max(now.getTime(), ...markers.map((t) => t + RETRY_MS)));
  return when.toDateString() === now.toDateString() ? when : null;
}

/**
 * The next run of a fixed-hours widget (« HH:MM », local time) after `maintenant`: « aujourd'hui 19:00 » or
 * « demain 07:00 »; null without hours. The current minute's hour is past (it is already running). With a
 * frequency (`minutes`) too, the nearer of the two: `derniereMaj + minutes` (right away if it is past or without
 * data). With `state`, the scheduler's rules after a failure: the frequency of a widget in error also waits 15 min
 * since the last attempt, and a failed fixed hour is retried (see `reessaiHeure`).
 */
export function nextRun(
  hours: readonly string[],
  now: Date,
  frequency?: { minutes: number; lastUpdate: string | null },
  appState?: NextState,
  locale = "fr",
): string | null {
  if (hours.length === 0) return null;
  const current = `${two(now.getHours())}:${two(now.getMinutes())}`;
  // « HH:MM » on two digits: the order of the texts is the order of the hours.
  const sorted = [...hours].sort();
  const today = sorted.find((h) => h > current);
  const [h, m] = (today ?? sorted[0]!).split(":").map(Number);
  let next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (today ? 0 : 1), h, m);
  const retry = retryHour(hours, now, appState);
  if (retry && retry < next) {
    next = retry;
    // To the minute: the second is not shown.
    next.setSeconds(0, 0);
  }
  if (!frequency) return label(next, now, locale);
  const markers = [now.getTime()];
  const last = instant(frequency.lastUpdate);
  if (!Number.isNaN(last)) markers.push(last + frequency.minutes * MINUTE);
  const attempt = instant(appState?.lastAttempt);
  if (appState?.status === "error" && !Number.isNaN(attempt)) markers.push(attempt + RETRY_MS);
  const byFrequency = new Date(Math.max(...markers));
  // To the minute: the second is not shown.
  byFrequency.setSeconds(0, 0);
  return label(byFrequency < next ? byFrequency : next, now, locale);
}
