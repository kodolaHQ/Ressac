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
const { onFrameMessage, setFrameActor } = await import("../chrome/window/remote-frame");

test("a frame subscribed before the store set the actor gets its messages once it does; a stopped one does not", () => {
  const early = {} as Element;
  const gone = {} as Element;
  const got: string[] = [];
  onFrameMessage(early, (name) => got.push(name));
  onFrameMessage(gone, () => got.push("gone"))();
  expect(registry.size).toBe(0);
  setFrameActor("resource://test/frame-actor.sys.mjs");
  expect([...registry.keys()]).toEqual([early]);
  registry.get(early)!("loaded", {});
  expect(got).toEqual(["loaded"]);
});
