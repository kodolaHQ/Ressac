import { describe, expect, it, vi } from "vitest";
import { appliquer } from "../../navigateur/src/main/etat/actions";
import { etatInitial } from "../../navigateur/src/main/etat/etat-initial";
import { createStore } from "../chrome/store/store";
import { createWindowRegistry, pickWindow } from "../chrome/store/windows";

// Three state windows: a, b, c.
const state = ["b", "c"].reduce((s, id) => appliquer(s, { type: "ouvrirFenetre", id }), etatInitial(() => "a"));
const [a, b, c] = state.fenetres.map((f) => f.id) as [string, string, string];

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
  vi.stubGlobal("Services", { startup: { shuttingDown: false }, focus: { activeWindow: null } });
  const fakeWindow = () => new EventTarget() as unknown as Window;

  it("a window opened for the state that closes before claiming leaves it; the last real window then keeps its tabs", () => {
    // A restored session: a (with a tab) and b.
    const restored = appliquer(appliquer(etatInitial(() => "a"), { type: "ouvrirFenetre", id: "b" }), { type: "ouvrirOnglet", fenetreId: "a", url: "https://a.test/" }, () => "t");
    const store = createStore(restored);
    const opened: Window[] = [];
    const windows = createWindowRegistry({ store, open: () => opened[opened.push(fakeWindow()) - 1], onRelease: () => {} });
    expect(windows.claim(fakeWindow())).toEqual({ fenetreId: "a", first: true });
    expect(opened).toHaveLength(1);
    // Closed before Firefox's delayed startup: it never claims b.
    opened[0]!.dispatchEvent(new Event("unload"));
    expect(store.state.fenetres.map((f) => f.id)).toEqual(["a"]);
    windows.release("a");
    expect(store.state.fenetres.map((f) => f.id)).toEqual(["a"]);
    expect(store.state.onglets.t).toBeDefined();
    // Kept: the next window takes it back.
    expect(windows.claim(fakeWindow()).fenetreId).toBe("a");
  });
});
