import { expect, it } from "vitest";
import { etatInitial } from "../../navigateur/src/main/etat/etat-initial";
import { TEXTE_REVOQUE } from "../../navigateur/src/main/outils-dev/inspecteur";
import { createDevTools } from "../chrome/store/devtools";
import { createStore } from "../chrome/store/store";
import type { WindowRegistry } from "../chrome/store/windows";

/** A store with tab "t", and windows that record each tab the dev tools went to load (none attaches without one). */
function setup(isPrivate = false) {
  const store = createStore(etatInitial());
  store.dispatch({ type: "ouvrirOnglet", fenetreId: store.state.fenetres[0]!.id, url: "http://127.0.0.1:5300/", activer: true }, () => "t");
  const loaded: string[] = [];
  const windows = { get: () => ({ window: {}, controller: { ensure: async (id: string) => (loaded.push(id), Promise.reject(new Error("no browser"))) } }) } as unknown as WindowRegistry;
  return { devtools: createDevTools({ store, windows, isPrivate: () => isPrivate }), loaded };
}

it("a private tab is refused before its page is even looked up", async () => {
  const { devtools, loaded } = setup(true);
  const { token } = devtools.owner();
  await expect(devtools.call(token, "attacher", ["t"])).rejects.toMatchObject({ name: "OngletPrive", id: "t" });
  await expect(devtools.call(token, "console", ["t"])).rejects.toMatchObject({ name: "OngletPrive" });
  expect(loaded).toEqual([]);
  expect(devtools.attached()).toEqual([]);
});

it("an unknown tab: OngletIntrouvable", async () => {
  const { devtools } = setup();
  await expect(devtools.call(devtools.owner().token, "console", ["gone"])).rejects.toMatchObject({ name: "OngletIntrouvable", id: "gone" });
});

it("a new owner revokes the previous one; a released owner is refused; a method not provided is refused", async () => {
  const { devtools } = setup();
  const first = devtools.owner().token;
  const second = devtools.owner().token;
  await expect(devtools.call(first, "console", ["t"])).rejects.toThrow(TEXTE_REVOQUE);
  await expect(devtools.call(second, "profiler", ["t", {}])).rejects.toThrow("Pas encore disponible");
  await expect(devtools.call(second, "constructor" as never, [])).rejects.toThrow("Pas encore disponible");
  devtools.release(first); // not the current one: nothing happens
  await expect(devtools.call(second, "console", ["t"])).rejects.toThrow("no browser");
  devtools.release();
  await expect(devtools.call(second, "console", ["t"])).rejects.toThrow(TEXTE_REVOQUE);
});
