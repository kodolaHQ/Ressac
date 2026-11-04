import { describe, expect, it } from "vitest";
import { createWatchdog, LATE_MS, WINDOW_MS } from "../chrome/store/crash-watchdog";

/** A watchdog on a fake clock: `advance` fires the timers due; `answer` settles the pending ping. */
function setup(o: { active?: () => boolean } = {}) {
  let now = 0;
  let timers: { at: number; f: () => void; id: number }[] = [];
  let nextId = 0;
  const pings: (() => void)[] = [];
  let kills = 0;
  const w = createWatchdog({
    now: () => now,
    setTimer: (f, ms) => (timers.push({ at: now + ms, f, id: ++nextId }), nextId),
    clearTimer: (id) => void (timers = timers.filter((t) => t.id !== id)),
    ping: () => new Promise<void>((r) => pings.push(r)),
    active: o.active ?? (() => true),
    kill: () => void kills++,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    w,
    pings,
    kills: () => kills,
    /** Moves the clock by `ms`, firing each timer due (late timers fire at the new time). */
    async advance(ms: number, o: { late?: boolean } = {}) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = o.late ? target : due.at;
        due.f();
        await flush();
      }
      now = target;
    },
    async answer() {
      pings.shift()?.();
      await flush();
    },
    timers: () => timers.length,
  };
}

describe("crash watchdog", () => {
  it("kills after two missed windows, never after one", async () => {
    const s = setup();
    s.w.start();
    expect(s.pings).toHaveLength(1);
    await s.advance(WINDOW_MS);
    expect(s.kills()).toBe(0);
    await s.advance(WINDOW_MS);
    expect(s.kills()).toBe(1);
  });

  it("an answer resets the count, and the next ping goes out at the next window", async () => {
    const s = setup();
    s.w.start();
    await s.advance(WINDOW_MS);
    await s.answer();
    await s.advance(WINDOW_MS);
    expect(s.pings).toHaveLength(1);
    await s.advance(WINDOW_MS);
    expect(s.kills()).toBe(0);
    await s.advance(WINDOW_MS);
    expect(s.kills()).toBe(1);
  });

  it("a window whose timer fires late (sleep, throttling) is not counted", async () => {
    const s = setup();
    s.w.start();
    await s.advance(WINDOW_MS);
    await s.advance(WINDOW_MS + LATE_MS + 1, { late: true });
    expect(s.kills()).toBe(0);
    await s.advance(WINDOW_MS);
    expect(s.kills()).toBe(1);
  });

  it("a wake restarts the window and its count", async () => {
    const s = setup();
    s.w.start();
    await s.advance(WINDOW_MS);
    await s.advance(WINDOW_MS / 2);
    s.w.wake();
    await s.advance(WINDOW_MS);
    expect(s.kills()).toBe(0);
    await s.advance(WINDOW_MS);
    expect(s.kills()).toBe(1);
  });

  it("nothing is armed or pinged while no agent background runs; stop clears the timer", async () => {
    let active = false;
    const s = setup({ active: () => active });
    s.w.start();
    expect(s.pings).toHaveLength(0);
    expect(s.timers()).toBe(0);
    active = true;
    s.w.start();
    await s.answer();
    active = false;
    s.w.stop();
    expect(s.timers()).toBe(0);
    await s.advance(5 * WINDOW_MS);
    expect(s.pings).toHaveLength(0);
    expect(s.kills()).toBe(0);
  });
});
