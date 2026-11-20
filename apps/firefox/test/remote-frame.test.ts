import { expect, test, vi } from "vitest";

const registry = new Map<object, (name: string, data: unknown) => void>();
vi.stubGlobal("ChromeUtils", {
  importESModule: () => ({
    onFrameMessage: (b: object, cb: (name: string, data: unknown) => void) => {
      registry.set(b, cb);
      return () => registry.delete(b);
    },
  }),
});
const { frameReverter, loadFrame, onFrameMessage, setFrameActor } = await import("../chrome/window/remote-frame");

test("a frame subscribed before the store set the actor gets its messages once it does; a stopped one does not; a stop after the flush unsubscribes", () => {
  const early = {} as Element;
  const gone = {} as Element;
  const got: string[] = [];
  const stop = onFrameMessage(early, (name) => got.push(name));
  onFrameMessage(gone, () => got.push("gone"))();
  expect(registry.size).toBe(0);
  setFrameActor("resource://test/frame-actor.sys.mjs");
  expect([...registry.keys()]).toEqual([early]);
  registry.get(early)!("loaded", {});
  expect(got).toEqual(["loaded"]);
  // Stopped after the flush: the subscription made then goes.
  stop();
  expect(registry.size).toBe(0);
});

test.each(["loading", "interactive"])("a frame browser inserted before its window's DOMContentLoaded (%s) waits for it; removed by then, it does not load", (readyState) => {
  const listeners: (() => void)[] = [];
  const win = { addEventListener: (type: string, fn: () => void, o: { once?: boolean }) => type === "DOMContentLoaded" && o.once && listeners.push(fn) };
  const browser = { browsingContext: {}, isConnected: false, ownerDocument: { defaultView: win, readyState }, loadURI: vi.fn() } as unknown as Element;
  // No webNavigation yet: the <browser> is not constructed (delayConnectedCallback).
  expect(loadFrame(browser, "resource://x/index.html")).toBe(true);
  expect(listeners).toHaveLength(1);
  listeners[0]!();
  expect((browser as unknown as { loadURI: ReturnType<typeof vi.fn> }).loadURI).not.toHaveBeenCalled();
});

test("a frame browser without web navigation in a loaded document loads nothing and does not wait", () => {
  const win = { addEventListener: vi.fn() };
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const browser = { browsingContext: {}, ownerDocument: { defaultView: win, readyState: "complete" } } as unknown as Element;
  expect(loadFrame(browser, "resource://x/index.html")).toBe(false);
  expect(win.addEventListener).not.toHaveBeenCalled();
  expect(err).toHaveBeenCalled();
  err.mockRestore();
});

test("frameReverter: one revert per address until a kept load, at least a second apart", () => {
  vi.useFakeTimers();
  let loads = 0;
  // loadFrame reads browsingContext first: each read is one load asked.
  const browser = {
    isConnected: true,
    get browsingContext() {
      loads++;
      return null;
    },
  } as unknown as Element;
  const r = frameReverter(browser);
  const notOurs = () => r.loaded(() => r.revert("a"));
  notOurs(); // the initial about:blank: loads at once
  expect(loads).toBe(1);
  notOurs(); // a missing copy's neterror: no more
  vi.advanceTimersByTime(5000);
  expect(loads).toBe(1);
  r.loaded(() => {}); // kept
  notOurs(); // left again 5 s later: at once
  expect(loads).toBe(2);
  r.loaded(() => {});
  notOurs(); // left again at once: after the floor
  expect(loads).toBe(2);
  vi.advanceTimersByTime(1000);
  expect(loads).toBe(3);
  vi.useRealTimers();
});
