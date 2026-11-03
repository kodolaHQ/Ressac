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
