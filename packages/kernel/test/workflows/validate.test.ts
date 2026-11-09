import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { DEFAULT_CONTEXT, STREAMING_ACTION, OUTPUT_PAGE_DENIED, OUTPUT_PAGE_REQUIRED, WEB_REQUIRED, validateWorkflow, implicitWorkflow } from "../../src/index.js";
import { BLOCK_REGISTRY } from "../../src/workflows/blocks/index.js";

const output = (id = "s", extra: object = {}) => ({ id, type: "output", params: { to: "widget", ...extra } });
const wf = (blocks: unknown[], links: unknown[] = []) => ({ version: 1, blocks: blocks, links: links });
const denial = (raw: unknown): string => {
  const r = validateWorkflow(raw);
  if (r.ok) throw new Error("accepté à tort");
  expect(r.error.startsWith("Workflow invalide : ")).toBe(true);
  expect(r.error.length).toBeLessThanOrEqual(300);
  return r.error;
};

test("a valid workflow gives the topological order, ties in block order", () => {
  const r = validateWorkflow(
    wf(
      [
        { id: "c", type: "list.keep", params: { count: 3 } },
        { id: "a", type: "source.feed", params: { urls: ["https://x.fr/rss"] } },
        { id: "b", type: "source.feed", params: { urls: ["https://y.fr/rss"] } },
        output(),
      ],
      [{ from: "a", to: "c" }, { from: "b", to: "c" }, { from: "c", to: "s" }],
    ),
  );
  if (!r.ok) throw new Error(r.error);
  expect(r.valid.order).toEqual(["a", "b", "c", "s"]);
  expect(r.valid.predecessors).toEqual({ c: ["a", "b"], a: [], b: [], s: ["c"] });
  expect(r.valid.output).toEqual({ id: "s", to: "widget" });
});

test("parameters receive their defaults", () => {
  const r = validateWorkflow(wf([{ id: "src", type: "source.feed", params: { urls: ["https://x.fr/rss"] } }, { id: "tri", type: "ai.sort", params: { question: "q", text: "t" } }, output()], [{ from: "src", to: "tri" }, { from: "tri", to: "s" }]));
  if (!r.ok) throw new Error(r.error);
  const sorting = r.valid.workflow.blocks[1]!;
  expect(sorting.params).toMatchObject({ threshold: 0.5, field: "score", onError: "skip" });
  expect(sorting.position).toEqual({ x: 0, y: 0 });
  expect(r.valid.workflow.blocks[2]!.params).toEqual({ to: "widget" });
});

test("the implicit workflow is valid", () => {
  const r = validateWorkflow(implicitWorkflow());
  expect(r.ok && r.valid.order).toEqual(["harvest", "output"]);
});

test("a JSON not conforming to the schema is refused", () => {
  expect(denial({ version: 2, blocks: [] })).toContain("version");
  expect(denial("pas un objet")).toMatch(/^Workflow invalide : /);
  expect(denial(wf([{ id: "A B", type: "output" }]))).toContain("blocks.0.id");
});

test("an unknown type is refused", () => {
  expect(denial(wf([{ id: "x", type: "web.inconnu" }, output()]))).toBe("Workflow invalide : type inconnu : web.inconnu");
});

test("a cycle is named", () => {
  const blocks = [{ id: "a", type: "list.keep", params: { count: 1 } }, { id: "b", type: "list.keep", params: { count: 1 } }, output()];
  expect(denial(wf(blocks, [{ from: "a", to: "b" }, { from: "b", to: "a" }]))).toBe("Workflow invalide : cycle : a → b → a");
  expect(denial(wf(blocks, [{ from: "a", to: "a" }]))).toBe("Workflow invalide : cycle : a → a");
});

test("a link to a missing block is refused", () => {
  expect(denial(wf([output()], [{ from: "s", to: "x" }]))).toBe("Workflow invalide : lien vers un bloc absent : x");
});

test("a duplicate block id is refused", () => {
  const b = { id: "a", type: "list.keep", params: { count: 1 } };
  expect(denial(wf([b, b, output()]))).toBe("Workflow invalide : id de bloc en double : a");
});

test("one output is mandatory and unique", () => {
  expect(denial(wf([{ id: "a", type: "list.keep", params: { count: 1 } }]))).toBe("Workflow invalide : aucune sortie");
  expect(denial(wf([output("s1"), output("s2")]))).toBe("Workflow invalide : plusieurs sorties : s1, s2");
});

test("an unknown output destination is refused", () => {
  expect(denial(wf([output("s", { to: "notification" })]))).toContain("s.to : to inconnu : notification");
});

test("invalid parameters are named by the block id", () => {
  expect(denial(wf([{ id: "tri", type: "ai.sort", params: { question: "q", text: "t", threshold: 2 } }, output()]))).toMatch(/^Workflow invalide : tri\.threshold : /);
  expect(denial(wf([{ id: "tri", type: "ai.sort", params: { text: "t" } }, output()]))).toMatch(/tri\.question/);
});

test("source.page: scroll an integer from 0 to 20, optional and without a default (an existing block's hash does not change)", () => {
  const page = (params: object) => wf([{ id: "p", type: "source.page", params: { url: "https://a.fr/", ...params } }, output()], [{ from: "p", to: "s" }]);
  for (const scroll of [21, -1, 1.5, "8"]) expect(denial(page({ scroll: scroll }))).toMatch(/^Workflow invalide : p\.scroll : /);
  const r = validateWorkflow(page({ scroll: 8 }));
  expect(r.ok && r.valid.workflow.blocks[0]!.params.scroll).toBe(8);
  const without = validateWorkflow(page({}));
  expect(without.ok && without.valid.workflow.blocks[0]!.params).not.toHaveProperty("scroll");
});

test("a code block file outside the folder is refused", () => {
  for (const source of ["../x.mjs", "/etc/x.mjs", "x.js", "a/b.mjs"]) {
    expect(denial(wf([{ id: "c", type: "code", params: { source } }, output()]))).toMatch(/^Workflow invalide : c\.source : /);
  }
});

test("perItem is refused on a type that does not accept it", () => {
  expect(denial(wf([{ id: "g", type: "list.keep", params: { count: 1, perItem: true } }, output()]))).toContain("g.perItem");
});

test("each registry type has a module and a parameter schema", () => {
  const types = ["source.page", "source.feed", "source.fetch", "web.search", "list.new", "list.dedupe", "list.keep", "ai.sort", "ai.write", "code", "output"];
  expect([...BLOCK_REGISTRY.keys()].sort()).toEqual([...types].sort());
  for (const t of types) expect(typeof BLOCK_REGISTRY.get(t)!.params.safeParse).toBe("function");
  expect(BLOCK_REGISTRY.get("ai.sort")!.perItem).toBe("always");
});

test("zod's common messages are worded in French", () => {
  expect(denial({ version: 2, blocks: [] })).toBe('Workflow invalide : version : 1 attendu');
  expect(denial({ version: 1, blocks: "x" })).toBe("Workflow invalide : blocks : liste attendue");
  expect(denial({ version: 1 })).toBe("Workflow invalide : blocks : manquant (liste attendue)");
  expect(denial(wf([{ id: "t", type: "ai.sort", params: { question: "q", text: "t", onError: "ignorer" } }, output()]))).toBe(
    'Workflow invalide : t.onError : une valeur parmi "skip", "fail" attendue',
  );
  expect(denial(wf([{ id: "f", type: "source.feed", params: { urls: [] } }, output()]))).toMatch(/^Workflow invalide : f\.urls : au moins 1 élément$/);
  expect(denial(wf([output()], [{ from: "", to: "s" }]))).toBe("Workflow invalide : links.0.from : vide");
  expect(denial(wf([{ ...output(), name: "x".repeat(61) }]))).toBe("Workflow invalide : blocks.0.name : 60 caractères au plus");
  expect(denial({ ...wf([output()]), other: 1 })).toBe("Workflow invalide : other : paramètre inconnu");
  // A message written in a schema is kept as is.
  expect(denial(wf([output("ID!")]))).toContain("id de bloc invalide");
});

test("more than 100 blocks, or more than 400 links: refused", () => {
  const blocks = Array.from({ length: 101 }, (_, i) => ({ id: `b${i}`, type: "list.keep", params: { count: 1 } }));
  expect(denial(wf(blocks))).toBe("Workflow invalide : blocks : 100 éléments au plus");
  const liens = Array.from({ length: 401 }, () => ({ from: "s", to: "s" }));
  expect(denial(wf([output()], liens))).toBe("Workflow invalide : links : 400 éléments au plus");
  // At the limit: accepted by the schema (100 blocks, 400 links).
  const hundred = [{ id: "b0", type: "source.feed", params: { urls: ["https://x.fr/rss"] } }, ...blocks.slice(1, 99), output()];
  const chain = hundred.slice(1).map((b, i) => ({ from: hundred[i]!.id, to: b.id }));
  const duplicates = Array.from({ length: 400 - chain.length }, () => chain[0]!);
  const r = validateWorkflow(wf(hundred, [...chain, ...duplicates]));
  if (!r.ok) throw new Error(r.error);
  expect(r.valid.order).toHaveLength(100);
});

const errorBlock = (raw: unknown): string | undefined => {
  const r = validateWorkflow(raw);
  if (r.ok) throw new Error("accepté à tort");
  return r.block;
};

test("a parameter error names the block concerned", () => {
  const raw = wf([{ id: "tri", type: "ai.sort", params: { question: "q", text: "t", threshold: 2 } }, output()], [{ from: "tri", to: "s" }]);
  expect(errorBlock(raw)).toBe("tri");
  expect(errorBlock(wf([{ id: "x", type: "web.inconnu" }, output()]))).toBe("x");
  expect(errorBlock(wf([{ id: "c", type: "list.keep", params: { count: 1, perItem: true } }, output()]))).toBe("c");
  expect(errorBlock(wf([{ id: "d", type: "code", params: { source: "d.mjs" } }, { id: "d", type: "code", params: { source: "d.mjs" } }, output()]))).toBe("d");
  expect(errorBlock(wf([output()], [{ from: "s", to: "absent" }]))).toBe("s");
  expect(errorBlock(wf([output()], [{ from: "absent", to: "s" }]))).toBe("s");
  expect(errorBlock(wf([output()], [{ from: "a", to: "b" }]))).toBeUndefined();
});

test("a cycle names its first block in the array order", () => {
  const blocks = [{ id: "b", type: "list.keep", params: { count: 1 } }, { id: "a", type: "list.keep", params: { count: 1 } }, output()];
  expect(errorBlock(wf(blocks, [{ from: "a", to: "b" }, { from: "b", to: "a" }]))).toBe("b");
});

test("a block whose input is required and without a predecessor is refused", () => {
  const raw = wf([{ id: "top", type: "list.keep", params: { count: 3 } }, output()], [{ from: "top", to: "s" }]);
  expect(denial(raw)).toBe("Workflow invalide : top : entrée manquante (relie un bloc avant lui)");
  expect(errorBlock(raw)).toBe("top");
  const sorting = wf([{ id: "tri", type: "ai.sort", params: { question: "q", text: "t" } }, output()], [{ from: "tri", to: "s" }]);
  expect(denial(sorting)).toContain("tri : entrée manquante");
});

test("an output without a predecessor is refused", () => {
  expect(denial(wf([output()]))).toBe("Workflow invalide : s : entrée manquante (relie un bloc avant lui)");
});

test("source.page without perItem needs no input; with perItem, it does", () => {
  const updateEntry = (perItem: boolean) =>
    wf([{ id: "p", type: "source.page", params: { url: "https://x.fr", perItem: perItem } }, output()], [{ from: "p", to: "s" }]);
  expect(validateWorkflow(updateEntry(false)).ok).toBe(true);
  expect(denial(updateEntry(true))).toContain("p : entrée manquante");
});

test("the missing input comes after the unique output and the cycles", () => {
  expect(denial(wf([{ id: "top", type: "list.keep", params: { count: 3 } }]))).toBe("Workflow invalide : aucune sortie");
});

test("the implicit workflow and the three shipped templates stay valid", () => {
  expect(validateWorkflow(implicitWorkflow()).ok).toBe(true);
  for (const m of ["meteo", "actus-tech", "daily-dev"]) {
    const raw = JSON.parse(readFileSync(new URL(`../../modeles/widgets/${m}/workflow.json`, import.meta.url), "utf8"));
    const r = validateWorkflow(raw);
    expect(r.ok, m + (r.ok ? "" : " : " + r.error)).toBe(true);
  }
});

const withPage = (params: Record<string, unknown>) =>
  wf(
    [{ id: "f", type: "source.feed", params: { urls: ["https://x.fr/rss"] } }, { id: "p", type: "source.page", params: { url: "https://x.fr/{url}", perItem: true, ...params } }, output()],
    [{ from: "f", to: "p" }, { from: "p", to: "s" }],
  );

test("budgetSeconds 600 refused without a duration (170 at most), accepted with maxDurationMinutes 30, 1900 refused (1800 at most)", () => {
  expect(denial(withPage({ budgetSeconds: 600 }))).toBe("Workflow invalide : p.budgetSeconds : 170 au plus");
  expect(validateWorkflow(withPage({ budgetSeconds: 170 })).ok).toBe(true);
  const long = { web: false, maxDurationMinutes: 30, owner: "widget" as const, input: false };
  expect(validateWorkflow(withPage({ budgetSeconds: 600 }), long).ok).toBe(true);
  const r = validateWorkflow(withPage({ budgetSeconds: 1900 }), long);
  expect(r).toEqual({ ok: false, error: "Workflow invalide : p.budgetSeconds : 1800 au plus", block: "p" });
  expect(validateWorkflow(withPage({ budgetSeconds: 3601 }), { web: false, maxDurationMinutes: 60, owner: "widget" as const, input: false }).ok).toBe(false);
  expect(validateWorkflow(withPage({ budgetSeconds: 600 }), DEFAULT_CONTEXT).ok).toBe(false);
  expect(DEFAULT_CONTEXT).toEqual({ web: false, maxDurationMinutes: null, owner: "widget" as const, input: false });
});

test("keepDays without reuse refused on source.page, accepted on list.new", () => {
  const r = validateWorkflow(withPage({ keepDays: 7 }));
  expect(r).toEqual({ ok: false, error: "Workflow invalide : p.keepDays : seulement avec reuse", block: "p" });
  const updateEntry = validateWorkflow(withPage({ keepDays: 7, reuse: "url" }));
  expect(updateEntry.ok && updateEntry.valid.workflow.blocks[1]!.params.keepDays).toBe(7);
  const fresh = wf(
    [{ id: "f", type: "source.feed", params: { urls: ["https://x.fr/rss"] } }, { id: "n", type: "list.new", params: { key: "url", keepDays: 30 } }, output()],
    [{ from: "f", to: "n" }, { from: "n", to: "s" }],
  );
  const lu = validateWorkflow(fresh);
  expect(lu.ok && lu.valid.workflow.blocks[1]!.params).toEqual({ key: "url", keepDays: 30 });
});

test("keepDays 0 and 366 refused", () => {
  expect(denial(withPage({ keepDays: 0, reuse: "url" }))).toBe("Workflow invalide : p.keepDays : au moins 1");
  expect(denial(withPage({ keepDays: 366, reuse: "url" }))).toBe("Workflow invalide : p.keepDays : 365 au plus");
  expect(denial(withPage({ keepDays: 1.5, reuse: "url" }))).toContain("p.keepDays");
});

test("output: live optional, absent from the validated parameters when not written", () => {
  const base = wf([{ id: "f", type: "source.feed", params: { urls: ["https://x.fr/rss"] } }, output()], [{ from: "f", to: "s" }]);
  const r = validateWorkflow(base);
  expect(r.ok && r.valid.workflow.blocks[1]!.params).toEqual({ to: "widget" });
  const stream = validateWorkflow(wf([{ id: "f", type: "source.feed", params: { urls: ["https://x.fr/rss"] } }, output("s", { live: true })], [{ from: "f", to: "s" }]));
  expect(stream.ok && stream.valid.workflow.blocks[1]!.params).toEqual({ to: "widget", live: true });
  expect(denial(wf([output("s", { live: "oui" })]))).toContain("s.live");
});

test("the three shipped templates and the implicit workflow stay valid, default context", () => {
  expect(validateWorkflow(implicitWorkflow(), DEFAULT_CONTEXT).ok).toBe(true);
  for (const m of ["meteo", "actus-tech", "daily-dev"]) {
    const raw = JSON.parse(readFileSync(new URL(`../../modeles/widgets/${m}/workflow.json`, import.meta.url), "utf8"));
    const r = validateWorkflow(raw, DEFAULT_CONTEXT);
    expect(r.ok, m + (r.ok ? "" : " : " + r.error)).toBe(true);
  }
});

const withSearch = (params: Record<string, unknown> = {}) =>
  wf(
    [{ id: "f", type: "source.feed", params: { urls: ["https://x.fr/rss"] } }, { id: "w", type: "web.search", params: { query: "{title} avis", perItem: true, ...params } }, output()],
    [{ from: "f", to: "w" }, { from: "w", to: "s" }],
  );

test('web.search without web: « Workflow invalide : web.search : le widget doit déclarer "web": true », block concerned', () => {
  expect(WEB_REQUIRED).toBe('web.search : le widget doit déclarer "web": true');
  const expected = { ok: false, error: 'Workflow invalide : web.search : le widget doit déclarer "web": true', block: "w" };
  expect(validateWorkflow(withSearch())).toEqual(expected);
  expect(validateWorkflow(withSearch(), { web: false, maxDurationMinutes: 30, owner: "widget" as const, input: false })).toEqual(expected);
});

test("web.search with web: valid, count 8 and default field search", () => {
  const r = validateWorkflow(withSearch(), { web: true, maxDurationMinutes: null, owner: "widget" as const, input: false });
  if (!r.ok) throw new Error(r.error);
  expect(r.valid.workflow.blocks[1]!.params).toEqual({ query: "{title} avis", count: 8, perItem: true, onError: "skip", field: "search" });
  const web = { web: true, maxDurationMinutes: null, owner: "widget" as const, input: false };
  expect(validateWorkflow(withSearch({ count: 21 }), web)).toMatchObject({ ok: false, error: "Workflow invalide : w.count : 20 au plus", block: "w" });
  expect(validateWorkflow(withSearch({ count: 0 }), web).ok).toBe(false);
  expect(validateWorkflow(withSearch({ field: "x".repeat(41) }), web).ok).toBe(false);
});

const action = { web: false, maxDurationMinutes: null, owner: "action" as const, input: false };
const stream = { id: "f", type: "source.feed", params: { urls: ["https://x.fr/rss"] } };
const withOutput = (extra: object, to?: string) =>
  wf([stream, { id: "s", type: "output", params: { ...(to === undefined ? {} : { to: to }), ...extra } }], [{ from: "f", to: "s" }]);

test("a widget with to \"page\" is refused (OUTPUT_PAGE_DENIED, block = the output)", () => {
  expect(OUTPUT_PAGE_DENIED).toBe('output : to "page" seulement dans une action');
  expect(validateWorkflow(withOutput({}, "page"))).toEqual({ ok: false, error: "Workflow invalide : " + OUTPUT_PAGE_DENIED, block: "s" });
});

test("an action with to \"widget\" or without to is refused (OUTPUT_PAGE_REQUIRED)", () => {
  expect(OUTPUT_PAGE_REQUIRED).toBe('output : une action rend une page (to: "page")');
  const expected = { ok: false, error: "Workflow invalide : " + OUTPUT_PAGE_REQUIRED, block: "s" };
  expect(validateWorkflow(withOutput({}, "widget"), action)).toEqual(expected);
  expect(validateWorkflow(withOutput({}), action)).toEqual(expected);
});

test("an action with to \"page\" is valid, output.to === \"page\"", () => {
  const r = validateWorkflow(withOutput({}, "page"), action);
  if (!r.ok) throw new Error(r.error);
  expect(r.valid.output).toEqual({ id: "s", to: "page" });
});

test("live in an action: STREAMING_ACTION", () => {
  expect(STREAMING_ACTION).toBe("output.live : pas dans une action");
  expect(validateWorkflow(withOutput({ live: true }, "page"), action)).toEqual({ ok: false, error: "Workflow invalide : " + STREAMING_ACTION, block: "s" });
  expect(validateWorkflow(withOutput({ live: false }, "page"), action).ok).toBe(true);
});

test("a widget's validated parameters are identical to before (to \"widget\", no key added)", () => {
  const r = validateWorkflow(implicitWorkflow(), DEFAULT_CONTEXT);
  if (!r.ok) throw new Error(r.error);
  expect(DEFAULT_CONTEXT).toEqual({ web: false, maxDurationMinutes: null, owner: "widget", input: false });
  expect(r.valid.workflow.blocks.find((b) => b.id === "output")!.params).toEqual({ to: "widget" });
  expect(validateWorkflow(withOutput({})).ok).toBe(true);
});
