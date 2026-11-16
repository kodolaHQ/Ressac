import { expect, test } from "vitest";
import type { ActionShown } from "../shared/actions";
import { normalize, suggestionsActions, SUGGESTIONS_MAX } from "../ui/components/suggestions";

const action = (id: string, name: string, o: Partial<ActionShown> = {}): ActionShown => ({
  id,
  name: name,
  description: "",
  keywords: [],
  input: null,
  account: [],
  public: [],
  grant: true,
  web: false,
  readsNeeded: false,
  last: null,
  ...o,
});

const TICKETS = action("tickets", "Mes tickets GitLab à traiter", { keywords: ["gitlab"] });
const LEBONCOIN = action("lbc", "Leboncoin", { input: { label: "Recherche" } });
const GITLAB = action("gl", "GitLab");

test("normaliser: without accents or case, spaces collapsed", () => {
  expect(normalize("  TîCK   Été ")).toBe("tick ete");
});

test("« git » suggests « Mes tickets GitLab à traiter » (keyword gitlab)", () => {
  expect(suggestionsActions("git", [TICKETS]).map((s) => s.name)).toEqual(["Mes tickets GitLab à traiter"]);
  expect(suggestionsActions("git", [TICKETS])[0]!.input).toBeNull();
});

test("« TICK » and « tîck » suggest it too", () => {
  expect(suggestionsActions("TICK", [TICKETS])).toHaveLength(1);
  expect(suggestionsActions("tîck", [TICKETS])).toHaveLength(1);
});

test("« leboncoin clio lyon » → Leboncoin, entry « clio lyon »", () => {
  expect(suggestionsActions("leboncoin clio lyon", [LEBONCOIN])).toEqual([{ id: "lbc", name: "Leboncoin", input: "clio lyon" }]);
  expect(suggestionsActions("  LeBonCoin   Clio  Lyon ", [LEBONCOIN])[0]!.input).toBe("Clio  Lyon");
});

test("« leboncoin » alone → entry null", () => {
  expect(suggestionsActions("leboncoin", [LEBONCOIN])).toEqual([{ id: "lbc", name: "Leboncoin", input: null }]);
});

test("« gitlab bug » does not suggest GitLab (without an entry)", () => {
  expect(suggestionsActions("gitlab bug", [GITLAB])).toEqual([]);
});

test("7 matching actions: 5", () => {
  const seven = Array.from({ length: 7 }, (_, i) => action(`a${i}`, `Alpha ${i}`));
  expect(SUGGESTIONS_MAX).toBe(5);
  expect(suggestionsActions("alp", seven)).toHaveLength(5);
});

test("empty text: []", () => {
  expect(suggestionsActions("", [TICKETS])).toEqual([]);
  expect(suggestionsActions("   ", [TICKETS])).toEqual([]);
});

test("an action in error is never suggested", () => {
  expect(suggestionsActions("git", [action("x", "GitLab", { error: "illisible" })])).toEqual([]);
});

test("exact terms first, then name order", () => {
  const list = [action("p", "Aide gitlabo"), action("c", "Zèbre"  , { keywords: ["gitlab"] }), action("a", "Gitlab")];
  expect(suggestionsActions("gitlab", list).map((s) => s.id)).toEqual(["a", "c", "p"]);
});
