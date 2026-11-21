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
const { framesToken } = await import("../chrome/window/frames-root");
const { createFrameBrowser, frameReverter, frameSandboxed, loadFrame, onFrameMessage, REVIVES_PER_MINUTE, sendFrame, setFrameActor } = await import("../chrome/window/remote-frame");

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

test("a frame whose document has no null principal or is out of the frames' process is sent nothing, logged once; about:blank is not logged", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const sendQuery = vi.fn();
  const ours = `webIsolated=resource://ressac-frames-${framesToken()}`;
  const frame = (isNullPrincipal: boolean, spec: string, remoteType = ours) =>
    ({ browsingContext: { currentWindowGlobal: { documentPrincipal: { isNullPrincipal }, documentURI: { spec }, domProcess: { remoteType }, getActor: () => ({ sendQuery }) } } }) as unknown as Element;
  expect(frameSandboxed(frame(false, "about:blank"))).toBe(false);
  expect(err).not.toHaveBeenCalled();
  await sendFrame(frame(false, "resource://x/a.html"), { n: 1 });
  await sendFrame(frame(false, "resource://x/a.html"), { n: 2 });
  expect(sendQuery).not.toHaveBeenCalled();
  expect(err).toHaveBeenCalledTimes(1);
  await sendFrame(frame(true, "resource://x/a.html"), { n: 3 });
  expect(sendQuery).toHaveBeenCalledWith("send", { data: { n: 3 } });
  // A null principal in another process (a shared web one) is not ours either.
  await sendFrame(frame(true, "resource://x/a.html", "web"), { n: 4 });
  expect(sendQuery).toHaveBeenCalledTimes(1);
  expect(frameSandboxed({ browsingContext: null } as unknown as Element)).toBe(false);
  err.mockRestore();
});

test("a frame whose process dies is put back (a new frame loader) at most REVIVES_PER_MINUTE times a minute, then stays empty", () => {
  vi.useFakeTimers();
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  let crash: (e: unknown) => void = () => {};
  const parent = { insertBefore: vi.fn((b: { isConnected: boolean }) => (b.isConnected = true)) };
  const el = {
    isConnected: true,
    parentNode: parent,
    nextSibling: null,
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    addEventListener: (type: string, fn: (e: unknown) => void) => type === "oop-browser-crashed" && (crash = fn),
    remove() {
      this.isConnected = false;
    },
  };
  const got: boolean[] = [];
  const b = createFrameBrowser({ createXULElement: () => el } as unknown as Document, (revived) => got.push(revived));
  expect(el.setAttribute).toHaveBeenCalledWith("disablefullscreen", "true");
  const event = (childID: number) => ({ isTrusted: true, isTopFrame: true, target: b, childID, stopPropagation: vi.fn() });
  for (let i = 0; i <= REVIVES_PER_MINUTE; i++) {
    const e = event(i);
    crash(e);
    expect(e.stopPropagation, "never Firefox's tab crash page").toHaveBeenCalled();
    vi.runAllTimers();
  }
  expect(got).toEqual([...Array(REVIVES_PER_MINUTE).fill(true), false]);
  expect(parent.insertBefore).toHaveBeenCalledTimes(REVIVES_PER_MINUTE);
  expect(err).toHaveBeenCalledTimes(REVIVES_PER_MINUTE + 1);
  // A minute later it comes back again; a second frame of the same crash logs nothing more.
  vi.advanceTimersByTime(60_000);
  crash(event(99));
  crash(event(99));
  vi.runAllTimers();
  expect(got.slice(-2)).toEqual([true, true]);
  expect(err).toHaveBeenCalledTimes(REVIVES_PER_MINUTE + 2);
  err.mockRestore();
  vi.useRealTimers();
});
