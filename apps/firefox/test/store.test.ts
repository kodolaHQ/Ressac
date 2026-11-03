import { describe, expect, it, vi } from "vitest";
import { etatInitial } from "../../navigateur/src/main/etat/etat-initial";
import { createStore } from "../chrome/store/store";

describe("createStore", () => {
  it("returns the same object and notifies nobody when an action changes nothing", () => {
    const store = createStore(etatInitial());
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.state;
    expect(store.dispatch({ type: "activerOnglet", id: "nope" })).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it("applies an action and passes (new, previous) to subscribers", () => {
    const initial = etatInitial();
    const store = createStore(initial);
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch({ type: "ouvrirOnglet", fenetreId: initial.fenetres[0]!.id, url: "https://a.test" }, () => "t1");
    expect(store.state.onglets["t1"]?.url).toBe("https://a.test");
    expect(listener).toHaveBeenCalledWith(store.state, initial);
  });

  it("clones the action: mutating it afterwards changes nothing", () => {
    const store = createStore(etatInitial());
    const action = { type: "ouvrirOnglet" as const, fenetreId: store.state.fenetres[0]!.id, url: "https://a.test" };
    store.dispatch(action, () => "t1");
    action.url = "https://evil.test";
    expect(store.state.onglets["t1"]?.url).toBe("https://a.test");
  });

  it("unsubscribes", () => {
    const store = createStore(etatInitial());
    const listener = vi.fn();
    store.subscribe(listener)();
    store.dispatch({ type: "ouvrirOnglet", fenetreId: store.state.fenetres[0]!.id, url: "x" }, () => "t1");
    expect(listener).not.toHaveBeenCalled();
  });

  it("a throwing listener neither skips the next ones nor fails the dispatch", () => {
    const store = createStore(etatInitial());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const next = vi.fn();
    store.subscribe(() => {
      throw new Error("dead window");
    });
    store.subscribe(next);
    store.dispatch({ type: "ouvrirOnglet", fenetreId: store.state.fenetres[0]!.id, url: "x" }, () => "t1");
    expect(next).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
