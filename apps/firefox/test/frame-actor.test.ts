import { expect, test, vi } from "vitest";

vi.stubGlobal("JSWindowActorParent", class {});
vi.stubGlobal("JSWindowActorChild", class {});
let testFlag = false;
vi.stubGlobal("Services", { cpmm: { sharedData: { get: () => testFlag } } });
vi.stubGlobal("Cu", {
  cloneInto: (v: unknown) => ({ cloned: v }),
  Sandbox: () => ({}),
  evalInSandbox: async (expr: string) => ({ expr }),
});
const { RessacFrameChild, RessacFrameParent, onFrameMessage } = await import("../chrome/agent/frame-actor");

/** A child over fake window and chrome event handler; `fire` runs the listeners of a type. */
function setup() {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const add = (t: string, f: (e: any) => void) => (listeners[t] ??= []).push(f);
  const rm = (t: string, f: unknown) => (listeners[t] = (listeners[t] ?? []).filter((g) => g !== f));
  const win = { addEventListener: add, removeEventListener: rm, postMessage: vi.fn() };
  const doc = { documentURI: "resource://x/a.html", nodePrincipal: {} };
  const child = new RessacFrameChild() as any;
  const sent: [string, unknown][] = [];
  Object.assign(child, {
    contentWindow: win,
    document: doc,
    docShell: { chromeEventHandler: { addEventListener: (t: string, f: any) => add(t, f), removeEventListener: rm } },
    sendAsyncMessage: (n: string, d: unknown) => sent.push([n, d]),
  });
  child.handleEvent({ type: "DOMWindowCreated" });
  return { child, win, doc, sent, fire: (t: string, e: object) => listeners[t]?.forEach((f) => f({ type: t, ...e })) };
}

test("page events forward only string details, clipped to 64 KiB", () => {
  const { sent, fire } = setup();
  fire("ressac-open", { detail: "https://a.test/" });
  fire("ressac-home", { detail: "x".repeat(70000) });
  fire("ressac-component", { detail: { not: "a string" } });
  expect(sent[0]).toEqual(["open", { url: "https://a.test/" }]);
  expect(sent[1]?.[0]).toBe("home");
  expect((sent[1]?.[1] as any).detail).toHaveLength(65536);
  expect(sent).toHaveLength(2);
});

test("only trusted pointerdown and window focus are forwarded", () => {
  const { sent, fire, win } = setup();
  fire("pointerdown", { isTrusted: false });
  fire("focus", { isTrusted: true, target: {} });
  expect(sent).toEqual([]);
  fire("pointerdown", { isTrusted: true });
  fire("focus", { isTrusted: true, target: win });
  expect(sent).toEqual([["press", {}], ["focus", {}]]);
});

test("DOMContentLoaded of the top document sends loaded", () => {
  const { child, doc, sent } = setup();
  child.handleEvent({ type: "DOMContentLoaded", target: {} });
  child.handleEvent({ type: "DOMContentLoaded", target: doc });
  expect(sent).toEqual([["loaded", { uri: "resource://x/a.html" }]]);
});

test("send posts a clone into the window", async () => {
  const { child, win } = setup();
  await child.receiveMessage({ name: "send", data: { data: { a: 1 } } });
  expect(win.postMessage).toHaveBeenCalledWith({ cloned: { a: 1 } }, "*");
});

test("test is refused without the flag and answers JSON with it", async () => {
  const { child } = setup();
  testFlag = false;
  await expect(child.receiveMessage({ name: "test", data: { expr: "1" } })).rejects.toThrow();
  testFlag = true;
  expect(await child.receiveMessage({ name: "test", data: { expr: "1+1" } })).toBe('{"expr":"1+1"}');
  testFlag = false;
});

test("the parent drops messages of an unregistered browser and calls the owner once registered", () => {
  const browser = {};
  const parent = new RessacFrameParent() as any;
  parent.browsingContext = { top: { embedderElement: browser } };
  const cb = vi.fn();
  parent.receiveMessage({ name: "press", data: {} });
  const stop = onFrameMessage(browser as Element, cb);
  parent.receiveMessage({ name: "press", data: {} });
  expect(cb).toHaveBeenCalledTimes(1);
  expect(cb).toHaveBeenCalledWith("press", {});
  stop();
  parent.receiveMessage({ name: "press", data: {} });
  expect(cb).toHaveBeenCalledTimes(1);
});
