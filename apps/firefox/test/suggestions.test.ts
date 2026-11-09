import { expect, test } from "vitest";
import type { ActionShown } from "../shared/actions";
import { normaliser, suggestionsActions, SUGGESTIONS_MAX } from "../ui/composants/suggestions";

const action = (id: string, nom: string, o: Partial<ActionShown> = {}): ActionShown => ({
  id,
  nom,
  description: "",
  motsCles: [],
  saisie: null,
  compte: [],
  publiques: [],
  accord: true,
  dernier: null,
  ...o,
});

const TICKETS = action("tickets", "Mes tickets GitLab à traiter", { motsCles: ["gitlab"] });
const LEBONCOIN = action("lbc", "Leboncoin", { saisie: { libelle: "Recherche" } });
const GITLAB = action("gl", "GitLab");

test("normaliser: without accents or case, spaces collapsed", () => {
  expect(normaliser("  TîCK   Été ")).toBe("tick ete");
});

test("« git » suggests « Mes tickets GitLab à traiter » (keyword gitlab)", () => {
  expect(suggestionsActions("git", [TICKETS]).map((s) => s.nom)).toEqual(["Mes tickets GitLab à traiter"]);
  expect(suggestionsActions("git", [TICKETS])[0]!.saisie).toBeNull();
});

test("« TICK » and « tîck » suggest it too", () => {
  expect(suggestionsActions("TICK", [TICKETS])).toHaveLength(1);
  expect(suggestionsActions("tîck", [TICKETS])).toHaveLength(1);
});

test("« leboncoin clio lyon » → Leboncoin, entry « clio lyon »", () => {
  expect(suggestionsActions("leboncoin clio lyon", [LEBONCOIN])).toEqual([{ id: "lbc", nom: "Leboncoin", saisie: "clio lyon" }]);
  expect(suggestionsActions("  LeBonCoin   Clio  Lyon ", [LEBONCOIN])[0]!.saisie).toBe("Clio  Lyon");
});

test("« leboncoin » alone → entry null", () => {
  expect(suggestionsActions("leboncoin", [LEBONCOIN])).toEqual([{ id: "lbc", nom: "Leboncoin", saisie: null }]);
});

test("« gitlab bug » does not suggest GitLab (without an entry)", () => {
  expect(suggestionsActions("gitlab bug", [GITLAB])).toEqual([]);
});

test("7 matching actions: 5", () => {
  const sept = Array.from({ length: 7 }, (_, i) => action(`a${i}`, `Alpha ${i}`));
  expect(SUGGESTIONS_MAX).toBe(5);
  expect(suggestionsActions("alp", sept)).toHaveLength(5);
});

test("empty text: []", () => {
  expect(suggestionsActions("", [TICKETS])).toEqual([]);
  expect(suggestionsActions("   ", [TICKETS])).toEqual([]);
});

test("an action in error is never suggested", () => {
  expect(suggestionsActions("git", [action("x", "GitLab", { erreur: "illisible" })])).toEqual([]);
});

test("exact terms first, then name order", () => {
  const liste = [action("p", "Aide gitlabo"), action("c", "Zèbre"  , { motsCles: ["gitlab"] }), action("a", "Gitlab")];
  expect(suggestionsActions("gitlab", liste).map((s) => s.id)).toEqual(["a", "c", "p"]);
});
