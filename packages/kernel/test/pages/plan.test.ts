import { expect, test } from "vitest";
import { MAX_PAGE_BLOCKS, MAX_OPERATIONS, PlanPage, evaluate, readPath, readReference } from "../../src/pages/plan.js";

const tickets = [
  { id: 1, project: "B", priority: "haute", title: "a" },
  { id: 2, project: "A", priority: "basse", title: "b" },
  { id: 3, project: "B", priority: "haute", title: "c" },
  { id: 4, project: "C", priority: "moyenne", title: "d" },
  { id: 5, project: "A", priority: "haute", title: "e" },
  { id: 6, project: "B", priority: "haute", title: "f" },
  { id: 7, project: "A", priority: "haute", title: "g" },
];
const announcements = [
  { title: "Renault CLIO", price: 7000 }, { title: "Peugeot 208", price: 9000 }, { title: "Clio", price: 7900 }, { title: "Mégane", price: 12000 },
];
const root = { tickets, announcements: announcements, priority: "ok", without: { x: 1 } };
const val = (text: string, r: unknown = root) => {
  const ref = readReference(text);
  if ("error" in ref) throw new Error(ref.error);
  return evaluate(ref, r);
};

test("compter on 7 tickets", () => expect(val("compter(tickets)")).toEqual({ value: 7 }));
test("trier desc", () => {
  const r = val('trier(tickets, priorite, "desc")') as { value: typeof tickets };
  expect(r.value.map((t) => t.priority)).toEqual(["moyenne", "haute", "haute", "haute", "haute", "haute", "basse"]);
});
test("trier is stable and puts the missing ones at the end", () => {
  const r = val("trier(l, k)", { l: [{ i: 1 }, { i: 2, k: 1 }, { i: 3, k: 1 }, { i: 4, k: 0 }] }) as { value: { i: number }[] };
  expect(r.value.map((e) => e.i)).toEqual([4, 2, 3, 1]);
  const d = val('trier(l, k, "desc")', { l: [{ i: 1 }, { i: 2, k: 1 }, { i: 3, k: 1 }, { i: 4, k: 0 }] }) as { value: { i: number }[] };
  expect(d.value.map((e) => e.i)).toEqual([2, 3, 4, 1]);
});
test("garder(filtrer(...), 3)", () => {
  const r = val('garder(filtrer(tickets, priorite = "haute"), 3)') as { value: typeof tickets };
  expect(r.value.map((t) => t.id)).toEqual([1, 3, 5]);
});
test("filtrer < and >", () => {
  expect((val("filtrer(annonces, prix < 8000)") as { value: unknown[] }).value).toHaveLength(2);
  expect((val("filtrer(annonces, prix > 8000)") as { value: unknown[] }).value).toHaveLength(2);
});
test("filtrer ~ ignores accents and case", () => {
  const r = val('filtrer(annonces, titre ~ "clio")') as { value: { title: string }[] };
  expect(r.value.map((a) => a.title)).toEqual(["Renault CLIO", "Clio"]);
  expect((val('filtrer(annonces, titre ~ "megane")') as { value: unknown[] }).value).toHaveLength(1);
});
test("filtrer = bare word and number", () => {
  expect((val("filtrer(tickets, priorite = basse)") as { value: unknown[] }).value).toHaveLength(1);
  expect((val("filtrer(tickets, id = 4)") as { value: unknown[] }).value).toHaveLength(1);
});
test("regrouper : ordre d'apparition", () => {
  const r = val("regrouper(tickets, projet)") as { value: { value: string; items: unknown[] }[] };
  expect(r.value.map((g) => [g.value, g.items.length])).toEqual([["B", 3], ["A", 3], ["C", 1]]);
  const s = val("regrouper(l, k)", { l: [{ k: 1 }, {}] }) as { value: { value: string }[] };
  expect(s.value.map((g) => g.value)).toEqual(["1", "(sans valeur)"]);
});
test("$ designates the whole value", () => {
  expect(val("$", [1, 2])).toEqual({ value: [1, 2] });
  expect(val("compter($)", [1, 2])).toEqual({ value: 2 });
});
test("espaces permis", () => {
  expect(val('  garder ( trier ( tickets , id , "desc" ) , 2 ) ')).toHaveProperty("valeur");
});
test("missing path: error; nested path", () => {
  expect(val("nulle.part")).toHaveProperty("error");
  expect(val("sans.x")).toEqual({ value: 1 });
  expect(val("tickets.0.id")).toEqual({ value: 1 });
});
test("operations on a non-list: error « liste attendue »", () => {
  expect(val("trier(sans, x)")).toEqual({ error: expect.stringContaining("liste attendue") });
  expect(val("compter(sans)")).toHaveProperty("error");
});
test("__proto__ and constructor are never read", () => {
  expect(readPath({}, "__proto__")).toBeUndefined();
  expect(readPath({}, "constructor")).toBeUndefined();
  expect(readPath({ a: {} }, "a.constructor.name")).toBeUndefined();
  expect(readPath("abc", "length")).toBeUndefined();
  expect(readPath([1], "length")).toBeUndefined();
  expect(val("constructor")).toHaveProperty("error");
  expect(val("filtrer(tickets, __proto__ = x)")).toEqual({ value: [] });
  expect(readPath(JSON.parse('{"__proto__":{"a":1}}'), "__proto__.a")).toBe(1);
});
test("readPath: $ is the root", () => {
  expect(readPath(5, "$")).toBe(5);
});
test("accented key read", () => expect(val("priorité")).toEqual({ value: "ok" }));
test("MAX_OPERATIONS", () => {
  expect(MAX_OPERATIONS).toBe(4);
  expect(readReference("garder(garder(garder(garder(t, 5), 5), 5), 5)")).toHaveProperty("ops");
  expect(readReference("garder(garder(garder(garder(garder(t, 5), 5), 5), 5), 5)")).toHaveProperty("error");
});
test("garder 0 and 201 refused, 1 and 200 allowed", () => {
  expect(readReference("garder(t, 0)")).toHaveProperty("error");
  expect(readReference("garder(t, 201)")).toHaveProperty("error");
  expect(readReference("garder(t, 1)")).toHaveProperty("ops");
  expect(readReference("garder(t, 200)")).toHaveProperty("ops");
  expect(readReference("garder(t, 1.5)")).toHaveProperty("error");
});
test("10,000-character text refused", () => {
  expect(readReference("a".repeat(10_000))).toHaveProperty("error");
  expect(readReference("a".repeat(300))).toHaveProperty("chemin");
  expect(readReference("a".repeat(301))).toHaveProperty("error");
});
test("syntaxe invalide", () => {
  for (const t of ["", "a.", ".a", "a b", "compter(", "compter(t", "compter(t))", "inconnue(t)", "garder(t)", "trier(t)", "filtrer(t, x)", "filtrer(t, x = )",
    'filtrer(t, x = "ab)', "regrouper(t)", "compter(t, x)", "trier(t, x, asc)", "$.a", "a..b", "a-b", "trier(t, a.)"]) {
    expect(readReference(t), t).toHaveProperty("error");
  }
});
test("the read ref: ops from the inside out", () => {
  expect(readReference('garder(trier(a.b, k, "desc"), 3)')).toEqual({
    path: "a.b", ops: [{ op: "trier", field: "k", desc: true }, { op: "garder", n: 3 }],
  });
  expect(readReference("filtrer(t, a.b ~ clio)")).toEqual({ path: "t", ops: [{ op: "filtrer", field: "a.b", comparison: "~", value: "clio" }] });
});
test("evaluer does not modify the results", () => {
  const copy = structuredClone(root);
  val('trier(tickets, priorite, "desc")');
  val("regrouper(tickets, projet)");
  expect(root).toEqual(copy);
});
test("10,000 elements in under 50 ms", () => {
  const big = { l: Array.from({ length: 10_000 }, (_, i) => ({ k: (i * 7919) % 10_000, g: i % 50 })) };
  const ref = readReference("garder(trier(l, k), 200)");
  if ("error" in ref) throw new Error(ref.error);
  const t = performance.now();
  evaluate(ref, big);
  const r2 = readReference("regrouper(l, g)");
  if ("error" in r2) throw new Error(r2.error);
  evaluate(r2, big);
  expect(performance.now() - t).toBeLessThan(50);
});

const block = (component = "titre", extra: object = {}) => ({ component: component, props: {}, ...extra });
test("PlanPage: unknown key removed", () => {
  const p = PlanPage.parse({ blocks: [{ component: "titre", props: { text: "x" }, thing: 1 }], other: 2 });
  expect(p).toEqual({ blocks: [{ component: "titre", props: { text: "x" } }] });
});
test("PlanPage: 40 blocks allowed, 41 refused, counted with the children", () => {
  expect(PlanPage.safeParse({ blocks: Array.from({ length: MAX_PAGE_BLOCKS }, () => block()) }).success).toBe(true);
  expect(PlanPage.safeParse({ blocks: Array.from({ length: 41 }, () => block()) }).success).toBe(false);
  expect(PlanPage.safeParse({ blocks: [block("groupe", { blocks: Array.from({ length: 40 }, () => block()) })] }).success).toBe(false);
  expect(PlanPage.safeParse({ blocks: [] }).success).toBe(false);
});
test("PlanPage : profondeur", () => {
  expect(PlanPage.safeParse({ blocks: [block("groupe", { blocks: [block("colonnes", { left: [block()], right: [block()] })] })] }).success).toBe(true);
  expect(PlanPage.safeParse({ blocks: [block("groupe", { blocks: [block("colonnes", { left: [block("groupe", { blocks: [block()] })] })] })] }).success).toBe(false);
});
test("PlanPage: component and props", () => {
  expect(PlanPage.safeParse({ blocks: [block("Titre")] }).success).toBe(false);
  expect(PlanPage.safeParse({ blocks: [block("a".repeat(41))] }).success).toBe(false);
  expect(PlanPage.safeParse({ blocks: [{ component: "t", props: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1])) }] }).success).toBe(false);
  expect(PlanPage.safeParse({ blocks: [{ component: "t", props: [] }] }).success).toBe(false);
});
