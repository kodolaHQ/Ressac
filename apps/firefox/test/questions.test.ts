import { expect, it } from "vitest";
import { initialState } from "../core/state/initial-state";
import { Questions } from "../chrome/agent/questions";
import { createStore } from "../chrome/store/store";

it("a question already stale when asked (tab gone) is refused at once, without a card", async () => {
  const store = createStore(initialState());
  const questions = new Questions(store);
  const win = store.state.windows[0]!.id;
  const answer = questions.ask({ id: "gone", title: "A", url: "https://a.test/", space: "" }, win);
  expect(questions.pending()).toEqual([]);
  expect(await answer).toBe(false);
});

it("a question of a closed window moves to the other, or is refused without one", async () => {
  const store = createStore(initialState());
  const questions = new Questions(store);
  const a = store.state.windows[0]!.id;
  store.dispatch({ type: "ouvrirFenetre", id: "b" });
  store.dispatch({ type: "ouvrirOnglet", windowId: a, url: "https://a.test/", activate: true }, () => "t");
  store.dispatch({ type: "ouvrirOnglet", windowId: "b", url: "https://b.test/", activate: true }, () => "u");
  const answer = questions.ask({ id: "t", title: "A", url: "https://a.test/", space: "" }, a);
  expect(questions.pending()).toMatchObject([{ windowId: a, tabId: "t" }]);
  questions.windowClosed(a, "b");
  expect(questions.pending()).toMatchObject([{ windowId: "b", tabId: "u" }]);
  questions.windowClosed("b", undefined);
  expect(questions.pending()).toEqual([]);
  expect(await answer).toBe(false);
});

it("an extension card: Activer answers accepte with the card's empreinte; a renforcée one needs confirme", async () => {
  const store = createStore(initialState());
  const questions = new Questions(store);
  const win = store.state.windows[0]!.id;
  const space = store.state.spaces[0]!;
  const card = {
    key: "agent:essai", name: "Essai", source: "agent" as const, version: "1.0.0", rights: [], sites: [], allSites: false, network: [],
    hardened: false, space: space.name, spaceId: space.id, otherSpaces: [], alsoReplaces: [], update: null, hash: "e".repeat(64),
  };
  let answer = questions.askExtension(card, win);
  expect(questions.pending()).toMatchObject([{ windowId: win, tabId: null, permissions: ["extension"], extension: card }]);
  questions.answer(questions.pending()[0]!.id, "autoriser");
  expect(await answer).toEqual({ accepted: true, hash: card.hash });

  answer = questions.askExtension({ ...card, hardened: true }, win);
  questions.answer(questions.pending()[0]!.id, "autoriser");
  expect(await answer).toEqual({ accepted: false, hash: card.hash });

  answer = questions.askExtension({ ...card, hardened: true }, win);
  questions.answer(questions.pending()[0]!.id, "autoriser", { confirmed: true });
  expect(await answer).toEqual({ accepted: true, hash: card.hash });

  // Its space gone: the card falls, « retirée ».
  expect(await questions.askExtension({ ...card, spaceId: "gone" }, win)).toEqual({ accepted: false, hash: card.hash, removed: true });
  expect(questions.pending()).toEqual([]);
});

it("a site's question waits without a delay; it falls (« retiree ») on its signal or when its tab closes", async () => {
  const store = createStore(initialState());
  const questions = new Questions(store);
  const win = store.state.windows[0]!.id;
  store.dispatch({ type: "ouvrirOnglet", windowId: win, url: "https://a.test/", activate: true }, () => "t");
  const site = { tabId: "t", windowId: win, origin: "https://a.test", permissions: ["notifications" as const] };
  let answer = questions.askSite(site);
  // A site question: on its tab only (no fenetreId), shown as a banner.
  expect(questions.pending()).toEqual([{ id: expect.any(String), tabId: "t", origin: "https://a.test", permissions: ["notifications"] }]);
  questions.answer(questions.pending()[0]!.id, "autoriser");
  expect(await answer).toBe("autoriser");

  const ac = new AbortController();
  answer = questions.askSite(site, ac.signal);
  ac.abort();
  expect(await answer).toBe("retiree");
  expect(questions.pending()).toEqual([]);

  answer = questions.askSite(site);
  store.dispatch({ type: "fermerOnglet", id: "t" });
  expect(await answer).toBe("retiree");
  expect(await questions.askSite(site)).toBe("retiree");
  expect(questions.pending()).toEqual([]);
});

it("the dev tools card answers the ticked rights, [] on a refusal, on its signal or when its tab goes to another site", async () => {
  const store = createStore(initialState());
  const questions = new Questions(store);
  const win = store.state.windows[0]!.id;
  store.dispatch({ type: "ouvrirOnglet", windowId: win, url: "https://a.test/", activate: true }, () => "t");
  const o = { id: "t", title: "A", url: "https://a.test/", space: "" };
  const d = { rights: ["console" as const, "network" as const], reason: "Pourquoi.", agent: "Claude Code" };
  let answer = questions.askDevTools(o, d, win);
  expect(questions.pending()).toMatchObject([{ target: "t", origin: "https://a.test", permissions: ["outils-dev"], ...d }]);
  questions.answer(questions.pending()[0]!.id, "autoriser", undefined, ["console"]);
  expect(await answer).toEqual(["console"]);

  answer = questions.askDevTools(o, d, win);
  questions.answer(questions.pending()[0]!.id, "refuser", undefined, ["console"]);
  expect(await answer).toEqual([]);

  const ac = new AbortController();
  answer = questions.askDevTools(o, d, win, ac.signal);
  ac.abort();
  expect(await answer).toEqual([]);

  answer = questions.askDevTools(o, d, win);
  store.dispatch({ type: "majOnglet", id: "t", fields: { url: "https://b.test/" } });
  expect(await answer).toEqual([]);
  expect(questions.pending()).toEqual([]);
});

it("the widget data card: the origin per kind; Autoriser answers true; a site app's dev tools card falls when its window closes", async () => {
  const store = createStore(initialState());
  let open = [{ id: "vidola", url: "https://vidola.test/" }];
  const questions = new Questions(store, () => open);
  const win = store.state.windows[0]!.id;
  const kinds = [
    questions.askWidgetData({ id: "meteo", name: "Météo", agent: "Claude" }, win),
    questions.askWidgetData({ id: "envoi", name: "Envoi", agent: "Claude", kind: "action" }, win),
    questions.askWidgetData({ id: "vidola", name: "Vidola", agent: "Claude", kind: "site" }, win),
  ];
  expect(questions.pending()).toMatchObject([
    { origin: "webaios-widget://meteo", permissions: ["donnees-widget"], title: "Météo", widget: "meteo", agent: "Claude", windowId: win },
    { origin: "webaios://action/envoi", action: "envoi" },
    { origin: "webaios-site://vidola", site: "vidola" },
  ]);
  for (const q of questions.pending()) questions.answer(q.id, "autoriser");
  expect(await Promise.all(kinds)).toEqual([true, true, true]);

  const rights = questions.askDevTools({ id: "site:vidola", title: "Vidola", url: "https://vidola.test/", space: "" }, { rights: ["console"], reason: "r", agent: "Claude" }, win);
  expect(questions.pending()).toHaveLength(1);
  open = [];
  questions.dropStale();
  expect(questions.pending()).toEqual([]);
  expect(await rights).toEqual([]);
});

it("a card on an agent app window falls when the window closes or goes to another origin (a relaunch on another port)", async () => {
  const store = createStore(initialState());
  let open = [{ folder: "essai", url: "http://localhost:15280/" }];
  const questions = new Questions(store, () => [], () => open);
  const win = store.state.windows[0]!.id;
  const ask = () => questions.ask({ id: "app:essai", title: "Essai", url: "http://localhost:15280/", space: "" }, win);
  const first = ask();
  expect(questions.pending()).toHaveLength(1);
  open = [{ folder: "essai", url: "http://localhost:15281/" }];
  questions.dropStale();
  expect(questions.pending()).toEqual([]);
  expect(await first).toBe(false);
  open = [{ folder: "essai", url: "http://localhost:15280/" }];
  const second = ask();
  expect(questions.pending()).toHaveLength(1);
  open = [];
  questions.dropStale();
  expect(questions.pending()).toEqual([]);
  expect(await second).toBe(false);
});
