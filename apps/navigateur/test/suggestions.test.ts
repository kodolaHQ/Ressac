import { expect, test } from "vitest";
import type { ActionAffichee } from "../src/commun/actions";
import { normaliser, suggestionsActions, SUGGESTIONS_MAX } from "../src/renderer/composants/suggestions";

const action = (id: string, nom: string, o: Partial<ActionAffichee> = {}): ActionAffichee => ({
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

test("normaliser : sans accents ni casse, espaces resserrés", () => {
  expect(normaliser("  TîCK   Été ")).toBe("tick ete");
});

test("« git » propose « Mes tickets GitLab à traiter » (mot-clé gitlab)", () => {
  expect(suggestionsActions("git", [TICKETS]).map((s) => s.nom)).toEqual(["Mes tickets GitLab à traiter"]);
  expect(suggestionsActions("git", [TICKETS])[0]!.saisie).toBeNull();
});

test("« TICK » et « tîck » le proposent aussi", () => {
  expect(suggestionsActions("TICK", [TICKETS])).toHaveLength(1);
  expect(suggestionsActions("tîck", [TICKETS])).toHaveLength(1);
});

test("« leboncoin clio lyon » → Leboncoin, saisie « clio lyon »", () => {
  expect(suggestionsActions("leboncoin clio lyon", [LEBONCOIN])).toEqual([{ id: "lbc", nom: "Leboncoin", saisie: "clio lyon" }]);
  expect(suggestionsActions("  LeBonCoin   Clio  Lyon ", [LEBONCOIN])[0]!.saisie).toBe("Clio  Lyon");
});

test("« leboncoin » seul → saisie null", () => {
  expect(suggestionsActions("leboncoin", [LEBONCOIN])).toEqual([{ id: "lbc", nom: "Leboncoin", saisie: null }]);
});

test("« gitlab bug » ne propose pas GitLab (sans saisie)", () => {
  expect(suggestionsActions("gitlab bug", [GITLAB])).toEqual([]);
});

test("7 actions qui correspondent : 5", () => {
  const sept = Array.from({ length: 7 }, (_, i) => action(`a${i}`, `Alpha ${i}`));
  expect(SUGGESTIONS_MAX).toBe(5);
  expect(suggestionsActions("alp", sept)).toHaveLength(5);
});

test("texte vide : []", () => {
  expect(suggestionsActions("", [TICKETS])).toEqual([]);
  expect(suggestionsActions("   ", [TICKETS])).toEqual([]);
});

test("une action en erreur n'est jamais proposée", () => {
  expect(suggestionsActions("git", [action("x", "GitLab", { erreur: "illisible" })])).toEqual([]);
});

test("termes exacts d'abord, puis ordre du nom", () => {
  const liste = [action("p", "Aide gitlabo"), action("c", "Zèbre"  , { motsCles: ["gitlab"] }), action("a", "Gitlab")];
  expect(suggestionsActions("gitlab", liste).map((s) => s.id)).toEqual(["a", "c", "p"]);
});
