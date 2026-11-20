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
const { loadFrame, onFrameMessage, setFrameActor } = await import("../chrome/window/remote-frame");

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


test("a frame browser inserted before its window's DOMContentLoaded waits for it; removed by then, it does not load", () => {
  const listeners: (() => void)[] = [];
  const win = { addEventListener: (type: string, fn: () => void, o: { once?: boolean }) => type === "DOMContentLoaded" && o.once && listeners.push(fn) };
  const browser = { browsingContext: {}, isConnected: false, ownerDocument: { defaultView: win }, loadURI: vi.fn() } as unknown as Element;
  // No webNavigation yet: the <browser> is not constructed (delayConnectedCallback).
  expect(loadFrame(browser, "resource://x/index.html")).toBe(true);
  expect(listeners).toHaveLength(1);
  listeners[0]!();
  expect((browser as unknown as { loadURI: ReturnType<typeof vi.fn> }).loadURI).not.toHaveBeenCalled();
});
