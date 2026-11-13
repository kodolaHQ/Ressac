import { describe, expect, it, vi } from "vitest";
import { apply } from "../core/state/actions";
import { initialState } from "../core/state/initial-state";
import { createStore } from "../chrome/store/store";
import { createWindowRegistry, pickWindow } from "../chrome/store/windows";

// Three state windows: a, b, c.
const state = ["b", "c"].reduce((s, id) => apply(s, { type: "openWindow", id }), initialState(() => "a"));
const [a, b, c] = state.windows.map((f) => f.id) as [string, string, string];

describe("pickWindow", () => {
  it("takes the window being opened first", () => {
    expect(pickWindow(state, { bound: new Set([a]), kept: b, opening: [c] })).toBe(c);
  });

  it("then the kept window", () => {
    expect(pickWindow(state, { bound: new Set([a]), kept: c, opening: [] })).toBe(c);
  });

  it("then a state window without a Firefox window", () => {
    expect(pickWindow(state, { bound: new Set([a, b]), kept: null, opening: [] })).toBe(c);
  });

  it("null when every state window is bound", () => {
    expect(pickWindow(state, { bound: new Set([a, b, c]), kept: null, opening: [] })).toBeNull();
    // A stale entry (gone from the state, or already bound) is never taken.
    expect(pickWindow(state, { bound: new Set([a, b, c]), kept: "gone", opening: [a] })).toBeNull();
  });
});

describe("createWindowRegistry", () => {
  const observers = new Set<(subject: unknown) => void>();
  const obs = { addObserver: (f: (subject: unknown) => void) => void observers.add(f), removeObserver: (f: (subject: unknown) => void) => void observers.delete(f) };
  vi.stubGlobal("Services", { startup: { shuttingDown: false }, focus: { activeWindow: null }, obs });
  const fakeWindow = () => new EventTarget() as unknown as Window;

  it("a window opened for the state that closes before claiming leaves it; the last real window then keeps its tabs", () => {
    // A restored session: a (with a tab) and b.
    const restored = apply(apply(initialState(() => "a"), { type: "openWindow", id: "b" }), { type: "openTab", windowId: "a", url: "https://a.test/" }, () => "t");
    const store = createStore(restored);
    const opened: Window[] = [];
    const windows = createWindowRegistry({ store, open: () => opened[opened.push(fakeWindow()) - 1], onRelease: () => {} });
    expect(windows.claim(fakeWindow())).toEqual({ windowId: "a", first: true });
    expect(opened).toHaveLength(1);
    // Closed before Firefox's delayed startup: it never claims b.
    // Its initial about:blank giving way to the browser is not a close.
    opened[0]!.dispatchEvent(new Event("unload"));
    expect(store.state.windows.map((f) => f.id)).toEqual(["a", "b"]);
    for (const f of [...observers]) f(opened[0]);
    expect(store.state.windows.map((f) => f.id)).toEqual(["a"]);
    expect(observers.size).toBe(0);
    windows.release("a");
    expect(store.state.windows.map((f) => f.id)).toEqual(["a"]);
    expect(store.state.tabs.t).toBeDefined();
    // Kept: the next window takes it back.
    expect(windows.claim(fakeWindow()).windowId).toBe("a");
  });
});
