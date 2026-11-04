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
