import { expect, it } from "vitest";
import { etatInitial } from "../../navigateur/src/main/etat/etat-initial";
import { Questions } from "../chrome/agent/questions";
import { createStore } from "../chrome/store/store";

it("a question already stale when asked (tab gone) is refused at once, without a card", async () => {
  const store = createStore(etatInitial());
  const questions = new Questions(store);
  const fenetre = store.state.fenetres[0]!.id;
  const answer = questions.ask({ id: "gone", titre: "A", url: "https://a.test/", espace: "" }, fenetre);
  expect(questions.pending()).toEqual([]);
  expect(await answer).toBe(false);
});

it("a question of a closed window moves to the other, or is refused without one", async () => {
  const store = createStore(etatInitial());
  const questions = new Questions(store);
  const a = store.state.fenetres[0]!.id;
  store.dispatch({ type: "ouvrirFenetre", id: "b" });
  store.dispatch({ type: "ouvrirOnglet", fenetreId: a, url: "https://a.test/", activer: true }, () => "t");
  store.dispatch({ type: "ouvrirOnglet", fenetreId: "b", url: "https://b.test/", activer: true }, () => "u");
  const answer = questions.ask({ id: "t", titre: "A", url: "https://a.test/", espace: "" }, a);
  expect(questions.pending()).toMatchObject([{ fenetreId: a, ongletId: "t" }]);
  questions.windowClosed(a, "b");
  expect(questions.pending()).toMatchObject([{ fenetreId: "b", ongletId: "u" }]);
  questions.windowClosed("b", undefined);
  expect(questions.pending()).toEqual([]);
  expect(await answer).toBe(false);
});

it("an extension card: Activer answers accepte with the card's empreinte; a renforcée one needs confirme", async () => {
  const store = createStore(etatInitial());
  const questions = new Questions(store);
  const fenetre = store.state.fenetres[0]!.id;
  const espace = store.state.espaces[0]!;
  const carte = {
    cle: "agent:essai", nom: "Essai", source: "agent" as const, version: "1.0.0", droits: [], sites: [], tousLesSites: false, reseau: [],
    renforce: false, espace: espace.nom, espaceId: espace.id, autresEspaces: [], remplaceAussi: [], maj: null, empreinte: "e".repeat(64),
  };
  let answer = questions.askExtension(carte, fenetre);
  expect(questions.pending()).toMatchObject([{ fenetreId: fenetre, ongletId: null, permissions: ["extension"], extension: carte }]);
  questions.answer(questions.pending()[0]!.id, "autoriser");
  expect(await answer).toEqual({ accepte: true, empreinte: carte.empreinte });

  answer = questions.askExtension({ ...carte, renforce: true }, fenetre);
  questions.answer(questions.pending()[0]!.id, "autoriser");
  expect(await answer).toEqual({ accepte: false, empreinte: carte.empreinte });

  answer = questions.askExtension({ ...carte, renforce: true }, fenetre);
  questions.answer(questions.pending()[0]!.id, "autoriser", { confirme: true });
  expect(await answer).toEqual({ accepte: true, empreinte: carte.empreinte });

  // Its space gone: the card falls, « retirée ».
  expect(await questions.askExtension({ ...carte, espaceId: "gone" }, fenetre)).toEqual({ accepte: false, empreinte: carte.empreinte, retiree: true });
  expect(questions.pending()).toEqual([]);
});

it("a site's question waits without a delay; it falls (« retiree ») on its signal or when its tab closes", async () => {
  const store = createStore(etatInitial());
  const questions = new Questions(store);
  const fenetre = store.state.fenetres[0]!.id;
  store.dispatch({ type: "ouvrirOnglet", fenetreId: fenetre, url: "https://a.test/", activer: true }, () => "t");
  const site = { ongletId: "t", fenetreId: fenetre, origine: "https://a.test", permissions: ["notifications" as const] };
  let answer = questions.askSite(site);
  // Electron's site question: on its tab only (no fenetreId), shown as a banner.
  expect(questions.pending()).toEqual([{ id: expect.any(String), ongletId: "t", origine: "https://a.test", permissions: ["notifications"] }]);
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
  const store = createStore(etatInitial());
  const questions = new Questions(store);
  const fenetre = store.state.fenetres[0]!.id;
  store.dispatch({ type: "ouvrirOnglet", fenetreId: fenetre, url: "https://a.test/", activer: true }, () => "t");
  const o = { id: "t", titre: "A", url: "https://a.test/", espace: "" };
  const d = { droits: ["console" as const, "reseau" as const], raison: "Pourquoi.", agent: "Claude Code" };
  let answer = questions.askDevTools(o, d, fenetre);
  expect(questions.pending()).toMatchObject([{ cible: "t", origine: "https://a.test", permissions: ["outils-dev"], ...d }]);
  questions.answer(questions.pending()[0]!.id, "autoriser", undefined, ["console"]);
  expect(await answer).toEqual(["console"]);

  answer = questions.askDevTools(o, d, fenetre);
  questions.answer(questions.pending()[0]!.id, "refuser", undefined, ["console"]);
  expect(await answer).toEqual([]);

  const ac = new AbortController();
  answer = questions.askDevTools(o, d, fenetre, ac.signal);
  ac.abort();
  expect(await answer).toEqual([]);

  answer = questions.askDevTools(o, d, fenetre);
  store.dispatch({ type: "majOnglet", id: "t", champs: { url: "https://b.test/" } });
  expect(await answer).toEqual([]);
  expect(questions.pending()).toEqual([]);
});
