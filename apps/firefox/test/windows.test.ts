import { describe, expect, it } from "vitest";
import { appliquer } from "../../navigateur/src/main/etat/actions";
import { etatInitial } from "../../navigateur/src/main/etat/etat-initial";
import { pickWindow } from "../chrome/store/windows";

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
