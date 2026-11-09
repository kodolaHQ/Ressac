import { expect, test } from "vitest";
import { MAX_BLOCS_PAGE, MAX_OPERATIONS, PlanPage, evaluate, readPath, lireReference } from "../../src/pages/plan.js";

const tickets = [
  { id: 1, projet: "B", priorite: "haute", titre: "a" },
  { id: 2, projet: "A", priorite: "basse", titre: "b" },
  { id: 3, projet: "B", priorite: "haute", titre: "c" },
  { id: 4, projet: "C", priorite: "moyenne", titre: "d" },
  { id: 5, projet: "A", priorite: "haute", titre: "e" },
  { id: 6, projet: "B", priorite: "haute", titre: "f" },
  { id: 7, projet: "A", priorite: "haute", titre: "g" },
];
const annonces = [
  { titre: "Renault CLIO", prix: 7000 }, { titre: "Peugeot 208", prix: 9000 }, { titre: "Clio", prix: 7900 }, { titre: "Mégane", prix: 12000 },
];
const racine = { tickets, annonces, priorité: "ok", sans: { x: 1 } };
const val = (texte: string, r: unknown = racine) => {
  const ref = lireReference(texte);
  if ("erreur" in ref) throw new Error(ref.erreur);
  return evaluate(ref, r);
};

test("compter on 7 tickets", () => expect(val("compter(tickets)")).toEqual({ valeur: 7 }));
test("trier desc", () => {
  const r = val('trier(tickets, priorite, "desc")') as { valeur: typeof tickets };
  expect(r.valeur.map((t) => t.priorite)).toEqual(["moyenne", "haute", "haute", "haute", "haute", "haute", "basse"]);
});
test("trier is stable and puts the missing ones at the end", () => {
  const r = val("trier(l, k)", { l: [{ i: 1 }, { i: 2, k: 1 }, { i: 3, k: 1 }, { i: 4, k: 0 }] }) as { valeur: { i: number }[] };
  expect(r.valeur.map((e) => e.i)).toEqual([4, 2, 3, 1]);
  const d = val('trier(l, k, "desc")', { l: [{ i: 1 }, { i: 2, k: 1 }, { i: 3, k: 1 }, { i: 4, k: 0 }] }) as { valeur: { i: number }[] };
  expect(d.valeur.map((e) => e.i)).toEqual([2, 3, 4, 1]);
});
test("garder(filtrer(...), 3)", () => {
  const r = val('garder(filtrer(tickets, priorite = "haute"), 3)') as { valeur: typeof tickets };
  expect(r.valeur.map((t) => t.id)).toEqual([1, 3, 5]);
});
test("filtrer < and >", () => {
  expect((val("filtrer(annonces, prix < 8000)") as { valeur: unknown[] }).valeur).toHaveLength(2);
  expect((val("filtrer(annonces, prix > 8000)") as { valeur: unknown[] }).valeur).toHaveLength(2);
});
test("filtrer ~ ignores accents and case", () => {
  const r = val('filtrer(annonces, titre ~ "clio")') as { valeur: { titre: string }[] };
  expect(r.valeur.map((a) => a.titre)).toEqual(["Renault CLIO", "Clio"]);
  expect((val('filtrer(annonces, titre ~ "megane")') as { valeur: unknown[] }).valeur).toHaveLength(1);
});
test("filtrer = bare word and number", () => {
  expect((val("filtrer(tickets, priorite = basse)") as { valeur: unknown[] }).valeur).toHaveLength(1);
  expect((val("filtrer(tickets, id = 4)") as { valeur: unknown[] }).valeur).toHaveLength(1);
});
test("regrouper : ordre d'apparition", () => {
  const r = val("regrouper(tickets, projet)") as { valeur: { valeur: string; elements: unknown[] }[] };
  expect(r.valeur.map((g) => [g.valeur, g.elements.length])).toEqual([["B", 3], ["A", 3], ["C", 1]]);
  const s = val("regrouper(l, k)", { l: [{ k: 1 }, {}] }) as { valeur: { valeur: string }[] };
  expect(s.valeur.map((g) => g.valeur)).toEqual(["1", "(sans valeur)"]);
});
test("$ designates the whole value", () => {
  expect(val("$", [1, 2])).toEqual({ valeur: [1, 2] });
  expect(val("compter($)", [1, 2])).toEqual({ valeur: 2 });
});
test("espaces permis", () => {
  expect(val('  garder ( trier ( tickets , id , "desc" ) , 2 ) ')).toHaveProperty("valeur");
});
test("missing path: error; nested path", () => {
  expect(val("nulle.part")).toHaveProperty("erreur");
  expect(val("sans.x")).toEqual({ valeur: 1 });
  expect(val("tickets.0.id")).toEqual({ valeur: 1 });
});
test("operations on a non-list: error « liste attendue »", () => {
  expect(val("trier(sans, x)")).toEqual({ erreur: expect.stringContaining("liste attendue") });
  expect(val("compter(sans)")).toHaveProperty("erreur");
});
test("__proto__ and constructor are never read", () => {
  expect(readPath({}, "__proto__")).toBeUndefined();
  expect(readPath({}, "constructor")).toBeUndefined();
  expect(readPath({ a: {} }, "a.constructor.name")).toBeUndefined();
  expect(readPath("abc", "length")).toBeUndefined();
  expect(readPath([1], "length")).toBeUndefined();
  expect(val("constructor")).toHaveProperty("erreur");
  expect(val("filtrer(tickets, __proto__ = x)")).toEqual({ valeur: [] });
  expect(readPath(JSON.parse('{"__proto__":{"a":1}}'), "__proto__.a")).toBe(1);
});
test("lireChemin: $ is the root", () => {
  expect(readPath(5, "$")).toBe(5);
});
test("accented key read", () => expect(val("priorité")).toEqual({ valeur: "ok" }));
test("MAX_OPERATIONS", () => {
  expect(MAX_OPERATIONS).toBe(4);
  expect(lireReference("garder(garder(garder(garder(t, 5), 5), 5), 5)")).toHaveProperty("ops");
  expect(lireReference("garder(garder(garder(garder(garder(t, 5), 5), 5), 5), 5)")).toHaveProperty("erreur");
});
test("garder 0 and 201 refused, 1 and 200 allowed", () => {
  expect(lireReference("garder(t, 0)")).toHaveProperty("erreur");
  expect(lireReference("garder(t, 201)")).toHaveProperty("erreur");
  expect(lireReference("garder(t, 1)")).toHaveProperty("ops");
  expect(lireReference("garder(t, 200)")).toHaveProperty("ops");
  expect(lireReference("garder(t, 1.5)")).toHaveProperty("erreur");
});
test("10,000-character text refused", () => {
  expect(lireReference("a".repeat(10_000))).toHaveProperty("erreur");
  expect(lireReference("a".repeat(300))).toHaveProperty("chemin");
  expect(lireReference("a".repeat(301))).toHaveProperty("erreur");
});
test("syntaxe invalide", () => {
  for (const t of ["", "a.", ".a", "a b", "compter(", "compter(t", "compter(t))", "inconnue(t)", "garder(t)", "trier(t)", "filtrer(t, x)", "filtrer(t, x = )",
    'filtrer(t, x = "ab)', "regrouper(t)", "compter(t, x)", "trier(t, x, asc)", "$.a", "a..b", "a-b", "trier(t, a.)"]) {
    expect(lireReference(t), t).toHaveProperty("erreur");
  }
});
test("the read ref: ops from the inside out", () => {
  expect(lireReference('garder(trier(a.b, k, "desc"), 3)')).toEqual({
    chemin: "a.b", ops: [{ op: "trier", champ: "k", desc: true }, { op: "garder", n: 3 }],
  });
  expect(lireReference("filtrer(t, a.b ~ clio)")).toEqual({ chemin: "t", ops: [{ op: "filtrer", champ: "a.b", comparaison: "~", valeur: "clio" }] });
});
test("evaluer does not modify the results", () => {
  const copie = structuredClone(racine);
  val('trier(tickets, priorite, "desc")');
  val("regrouper(tickets, projet)");
  expect(racine).toEqual(copie);
});
test("10,000 elements in under 50 ms", () => {
  const gros = { l: Array.from({ length: 10_000 }, (_, i) => ({ k: (i * 7919) % 10_000, g: i % 50 })) };
  const ref = lireReference("garder(trier(l, k), 200)");
  if ("erreur" in ref) throw new Error(ref.erreur);
  const t = performance.now();
  evaluate(ref, gros);
  const r2 = lireReference("regrouper(l, g)");
  if ("erreur" in r2) throw new Error(r2.erreur);
  evaluate(r2, gros);
  expect(performance.now() - t).toBeLessThan(50);
});

const bloc = (composant = "titre", extra: object = {}) => ({ composant, props: {}, ...extra });
test("PlanPage: unknown key removed", () => {
  const p = PlanPage.parse({ blocs: [{ composant: "titre", props: { texte: "x" }, truc: 1 }], autre: 2 });
  expect(p).toEqual({ blocs: [{ composant: "titre", props: { texte: "x" } }] });
});
test("PlanPage: 40 blocks allowed, 41 refused, counted with the children", () => {
  expect(PlanPage.safeParse({ blocs: Array.from({ length: MAX_BLOCS_PAGE }, () => bloc()) }).success).toBe(true);
  expect(PlanPage.safeParse({ blocs: Array.from({ length: 41 }, () => bloc()) }).success).toBe(false);
  expect(PlanPage.safeParse({ blocs: [bloc("groupe", { blocs: Array.from({ length: 40 }, () => bloc()) })] }).success).toBe(false);
  expect(PlanPage.safeParse({ blocs: [] }).success).toBe(false);
});
test("PlanPage : profondeur", () => {
  expect(PlanPage.safeParse({ blocs: [bloc("groupe", { blocs: [bloc("colonnes", { gauche: [bloc()], droite: [bloc()] })] })] }).success).toBe(true);
  expect(PlanPage.safeParse({ blocs: [bloc("groupe", { blocs: [bloc("colonnes", { gauche: [bloc("groupe", { blocs: [bloc()] })] })] })] }).success).toBe(false);
});
test("PlanPage: component and props", () => {
  expect(PlanPage.safeParse({ blocs: [bloc("Titre")] }).success).toBe(false);
  expect(PlanPage.safeParse({ blocs: [bloc("a".repeat(41))] }).success).toBe(false);
  expect(PlanPage.safeParse({ blocs: [{ composant: "t", props: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1])) }] }).success).toBe(false);
  expect(PlanPage.safeParse({ blocs: [{ composant: "t", props: [] }] }).success).toBe(false);
});
