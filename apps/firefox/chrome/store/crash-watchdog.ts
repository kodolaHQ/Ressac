/** A window the extension process has to answer a ping in; two missed in a row are a hang (Firefox's slow-script limit is 10 s). */
export const WINDOW_MS = 10_000;
/** A window's timer firing this much later than due means the parent stalled or slept: that window is not counted. */
export const LATE_MS = 1_000;
const MISSES_TO_KILL = 2;

/**
 * The hang watchdog of the extension process (spike S7: a hung background freezes it, with no signal). One ping out at a
 * time; `kill` after MISSES_TO_KILL consecutive windows of WINDOW_MS without its answer, measured on `now` (monotonic).
 * Armed only while `active()` (an agent background runs).
 */
export function createWatchdog<T>(o: {
  now(): number;
  setTimer(f: () => void, ms: number): T;
  clearTimer(t: T): void;
  ping(): Promise<unknown>;
  active(): boolean;
  kill(): void;
  /** Tests only: a shorter window. */
  windowMs?: number;
}) {
  const windowMs = o.windowMs ?? WINDOW_MS;
  let timer: T | null = null;
  let windowStart = 0;
  let missed = 0;
  /** The ping out, by number: an answer to an older one changes nothing. */
  let pending: number | null = null;
  let sent = 0;

  const send = () => {
    const n = (pending = ++sent);
    // A rejection (no actor, the process went) is an answer, not a hang.
    const answered = () => {
      if (pending !== n) return;
      pending = null;
      missed = 0;
    };
    o.ping().then(answered, answered);
  };
  const arm = () => {
    if (timer !== null || !o.active()) return;
    windowStart = o.now();
    timer = o.setTimer(tick, windowMs);
    if (pending === null) send();
  };
  function tick() {
    timer = null;
    const late = o.now() - windowStart - windowMs > LATE_MS;
    if (pending !== null && !late && ++missed >= MISSES_TO_KILL) {
      missed = 0;
      pending = null;
      o.kill();
    }
    arm();
  }
  const stop = () => {
    if (timer !== null) o.clearTimer(timer);
    timer = null;
  };
  return {
    start: arm,
    stop,
    /** The machine woke: the window and its count start again. */
    wake() {
      missed = 0;
      stop();
      arm();
    },
  };
}
