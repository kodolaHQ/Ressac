import { describe, expect, it, vi } from "vitest";
import { alertObserver, focusRecentWindow } from "../chrome/store/notifications";

const STATE_MINIMIZED = 2;
const fakeWindow = (windowState: number) => {
  const calls: string[] = [];
  return { calls, windowState, STATE_MINIMIZED, restore: () => calls.push("restore"), focus: () => calls.push("focus") };
};
const wmWith = (w: unknown) => ({ getMostRecentBrowserWindow: () => w });

describe("focusRecentWindow", () => {
  it("restores a minimized window, then focuses it", () => {
    const w = fakeWindow(STATE_MINIMIZED);
    focusRecentWindow(wmWith(w));
    expect(w.calls).toEqual(["restore", "focus"]);
  });

  it("only focuses a window that is not minimized", () => {
    const w = fakeWindow(1);
    focusRecentWindow(wmWith(w));
    expect(w.calls).toEqual(["focus"]);
  });

  it("does nothing without a window", () => {
    expect(() => focusRecentWindow(wmWith(null))).not.toThrow();
  });
});

describe("alertObserver", () => {
  it("ignores alertfinished and focuses the last window on alertclickcallback", () => {
    const w = fakeWindow(STATE_MINIMIZED);
    vi.stubGlobal("Services", { wm: wmWith(w) });
    alertObserver.observe(null, "alertfinished", "");
    alertObserver.observe(null, "alertshow", "");
    expect(w.calls).toEqual([]);
    alertObserver.observe(null, "alertclickcallback", "");
    expect(w.calls).toEqual(["restore", "focus"]);
    vi.unstubAllGlobals();
  });
});
