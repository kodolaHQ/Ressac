import { describe, expect, it } from "vitest";
import { BUILTIN_COMPONENTS, type ComponentDefinition } from "../../src/pages/catalog.js";
import type { PlanBlock, PlanPage } from "../../src/pages/plan.js";
import { COMPONENT_UNAVAILABLE, ELEMENTS_MAX, TEXT_MAX, chainsOf, resolvePage, type RenderedBlock } from "../../src/pages/resolve.js";
import { validatePlan } from "../../src/pages/validate.js";

const graph: ComponentDefinition = {
  name: "graphique-barres", description: "Barres", origin: "agent",
  properties: {
    data: { kind: "reference", description: "Les données", required: true },
    label: { kind: "field", description: "Le champ", required: false },
    title: { kind: "text", description: "Le titre", required: false },
    max: { kind: "number", description: "Maximum", required: false },
    stacked: { kind: "checkbox", description: "Empilé", required: false },
  },
};
const catalog = [...BUILTIN_COMPONENTS, graph];
const fr = new Intl.NumberFormat("fr-FR");

const results = {
  project: {
    name: "Ressac", url: "https://gitlab.com/p", total: 1234.5,
    traps: ["javascript:alert(1)", "http://127.0.0.1/admin", "http://192.168.1.2/", "http://[::1]/", "https://user:mdp@gitlab.com/"],
  },
  announcements: [
    { title: "Clio", snapshot: "https://img.example/clio.jpg", price: 7000, mark: "Renault", url: "https://site.example/clio" },
    { title: "208", snapshot: "http://img.example/208.jpg", price: 9000, mark: "Peugeot" },
    { title: "Mégane", price: 12000, mark: "Renault", tags: ["diesel", "break"] },
  ],
};

const render = (blocks: PlanBlock[], o: { account?: boolean; fallback?: boolean; r?: unknown } = {}) =>
  resolvePage({ blocks: blocks }, o.r ?? results, { account: o.account ?? false, catalog: catalog, fallback: o.fallback ?? false });
const one = (block: PlanBlock, o?: Parameters<typeof render>[1]) => render([block], o).blocks[0] as RenderedBlock & { props: Record<string, any> };

describe("resolvePage", () => {
  it("link whose url is in the results: url kept", () => {
    const b = one({ component: "link", props: { object: "project", url: "url", textField: "name" } });
    expect(b).toEqual({ component: "link", props: { link: { text: "Ressac", url: "https://gitlab.com/p" } } });
    const t = one({ component: "link", props: { object: "project", url: "url", text: "Le projet" } });
    expect(t.props.link).toEqual({ text: "Le projet", url: "https://gitlab.com/p" });
  });

  it("literal link written by the writer: property refused at validation", () => {
    for (const url of ["https://tiers.example/?d=x", '"https://tiers.example/?d=" + name', "javascript:alert(1)"]) {
      const r = validatePlan({ blocks: [{ component: "link", props: { object: "project", url } }, { component: "figure", props: { value: "count(announcements)", label: "n" } }] }, { catalog: catalog, results: results });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.plan.blocks.map((b) => b.component)).toEqual(["figure"]);
        expect(r.discarded[0]).toMatch(/^1\. link : url : /);
      }
    }
  });

  it("url javascript:, http://127.0.0.1, http://192.168.1.2 : url null", () => {
    const r = { links: results.project.traps.map((u) => ({ u })) };
    const b = one({ component: "list", props: { items: "links", title: "u", link: "u" } }, { r });
    expect(b.props.items.map((l: any) => l.link.url)).toEqual([null, null, null, null, null]);
    expect(b.props.items.map((l: any) => l.link.text)).toEqual(results.project.traps);
  });

  it("a url absent from the results (read elsewhere): url null", () => {
    const values = { o: { u: "https://tiers.example/" } };
    // The same string is only « present » if it is among the strings of the results passed: here yes.
    expect(one({ component: "link", props: { object: "o", url: "u" } }, { r: values }).props.link.url).toBe("https://tiers.example/");
    // A number or an object is not an address.
    expect(one({ component: "link", props: { object: "o", url: "u" } }, { r: { o: { u: 3 } } }).props.link.url).toBeNull();
  });

  it("https image of an action without an account: { url }; with an account: neutral; over http: null", () => {
    const card = { component: "cards", props: { items: "announcements", title: "title", image: "snapshot" } };
    const without = one(card).props.items.map((c: any) => c.image);
    expect(without).toEqual([{ url: "https://img.example/clio.jpg" }, null, null]);
    const updateEntry = one(card, { account: true }).props.items.map((c: any) => c.image);
    expect(updateEntry).toEqual([{ neutral: true }, { neutral: true }, null]);
    const local = one(card, { r: { announcements: [{ title: "x", snapshot: "https://192.168.1.2/a.png" }] } }).props.items[0].image;
    expect(local).toBeNull();
  });

  it("titre « <img src=x onerror=…> » rendu en texte tel quel", () => {
    const html = "<img src=x onerror=alert(1)>";
    expect(one({ component: "title", props: { text: html } })).toEqual({ component: "title", props: { text: html } });
    const l = one({ component: "list", props: { items: "x", title: "t" } }, { r: { x: [{ t: html }] } });
    expect(l.props.items[0].title).toBe(html);
  });

  it("10,000 tickets in a table: 200 rows, cuts 9800", () => {
    const tickets = Array.from({ length: 10_000 }, (_, i) => ({ id: i, title: `t${i}`, url: `https://gitlab.com/t/${i}` }));
    const page = render([{ component: "table", props: { items: "tickets", columns: [{ field: "id", label: "N°" }, { field: "title", label: "Titre" }], link: "url" } }], { r: { tickets } });
    const b = page.blocks[0] as RenderedBlock & { props: Record<string, any> };
    expect(b.props.items).toHaveLength(ELEMENTS_MAX);
    expect(b.props.others).toBe(9800);
    expect(page.cuts).toBe(9800);
    expect(b.props.columns).toEqual([{ field: "id", label: "N°" }, { field: "title", label: "Titre" }]);
    expect(b.props.items[1]).toEqual({ values: { id: fr.format(1), title: "t1" }, link: { text: "https://gitlab.com/t/1", url: "https://gitlab.com/t/1" } });
    expect(b.props.items[199].values.id).toBe(fr.format(199));
  });

  it("regrouper given to cards: one section per value", () => {
    const b = one({ component: "cards", props: { items: "group(announcements, mark)", title: "title", value: "price", tags: "tags" } });
    expect(b.props.items).toBeUndefined();
    expect(b.props.groups.map((g: any) => [g.value, g.items.map((c: any) => c.title)])).toEqual([["Renault", ["Clio", "Mégane"]], ["Peugeot", ["208"]]]);
    expect(b.props.groups[0].items[0].value).toBe(fr.format(7000));
    expect(b.props.groups[0].items[1].tags).toEqual(["diesel", "break"]);
    expect(b.props.others).toBe(0);
  });

  it("regrouper cut: 200 elements in total, the rest counted", () => {
    const l = Array.from({ length: 300 }, (_, i) => ({ t: `e${i}`, k: i % 2 ? "a" : "b" }));
    const b = one({ component: "list", props: { items: "group(l, k)", title: "t" } }, { r: { l } });
    expect(b.props.groups.reduce((n: number, g: any) => n + g.items.length, 0)).toBe(ELEMENTS_MAX);
    expect(b.props.others).toBe(100);
  });

  it("agent component: reference evaluated, field passed by its name", () => {
    const b = one({ component: "graphique-barres", props: { data: 'filter(announcements, mark = "Renault")', label: "title", title: "Prix", max: 20000, stacked: true } });
    expect(b.component).toBe("graphique-barres");
    expect(b.props.data.map((a: any) => a.title)).toEqual(["Clio", "Mégane"]);
    expect(b.props).toMatchObject({ label: "title", title: "Prix", max: 20000, stacked: true });
  });

  it("agent component: bounded value (lists to 200, texts cut)", () => {
    const l = Array.from({ length: 250 }, () => "x".repeat(TEXT_MAX + 50));
    const page = render([{ component: "graphique-barres", props: { data: "l" } }], { r: { l } });
    const b = page.blocks[0] as RenderedBlock & { props: Record<string, any> };
    expect(b.props.data).toHaveLength(ELEMENTS_MAX);
    expect(b.props.data[0].length).toBeLessThanOrEqual(TEXT_MAX);
    expect(page.cuts).toBe(50);
  });

  it("component missing from the catalog: error callout, the rest displays", () => {
    const page = render([{ component: "camembert", props: { data: "announcements" } }, { component: "title", props: { text: "Après" } }]);
    expect(page.blocks).toEqual([{ component: "error", message: COMPONENT_UNAVAILABLE("camembert") }, { component: "title", props: { text: "Après" } }]);
    expect(COMPONENT_UNAVAILABLE("camembert")).toBe("Composant indisponible : camembert");
  });

  it("texts: numbers in fr-FR, long ones cut to TEXTE_MAX, simple values", () => {
    expect(one({ component: "figure", props: { value: "project.total", label: "Total" } }).props).toEqual({ value: fr.format(1234.5), label: "Total" });
    expect(one({ component: "figure", props: { value: "count(announcements)", label: "n" } }).props.value).toBe("3");
    const long = one({ component: "paragraph", props: { value: "t" } }, { r: { t: "a".repeat(100_000) } });
    expect(long.props.text.length).toBe(TEXT_MAX);
    expect(long.props.text.endsWith("…")).toBe(true);
  });

  it("each built-in component resolves", () => {
    const page = render([
      { component: "title", props: { text: "T" } },
      { component: "paragraph", props: { text: "P" } },
      { component: "callout", props: { level: "info", title: "E", items: "announcements", field: "title" } },
      { component: "figures", props: { figures: [{ value: "count(announcements)", label: "n" }] } },
      { component: "fields", props: { object: "project" } },
      { component: "fields", props: { object: "project", fields: [{ field: "name", label: "Nom" }] } },
      { component: "tags", props: { items: "announcements", field: "mark" } },
      { component: "tags", props: { values: "project.traps" } },
      { component: "group", props: { title: "G", collapsed: true }, blocks: [{ component: "title", props: { text: "dans" } }] },
      { component: "columns", props: {}, left: [{ component: "title", props: { text: "g" } }], right: [] },
    ]);
    const p = page.blocks.map((b) => ("props" in b ? b.props : b));
    expect(p[2]).toEqual({ level: "info", title: "E", text: null, items: ["Clio", "208", "Mégane"], others: 0 });
    expect(p[3]).toEqual({ figures: [{ value: "3", label: "n" }] });
    expect(p[4]).toEqual({ fields: [{ label: "name", value: "Ressac" }, { label: "url", value: "https://gitlab.com/p" }, { label: "total", value: fr.format(1234.5) }], others: 0 });
    expect(p[5]).toEqual({ fields: [{ label: "Nom", value: "Ressac" }], others: 0 });
    expect(p[6]).toEqual({ values: ["Renault", "Peugeot", "Renault"], others: 0 });
    expect(p[7]).toEqual({ values: results.project.traps, others: 0 });
    expect(page.blocks[8]).toEqual({ component: "group", props: { title: "G", collapsed: true }, blocks: [{ component: "title", props: { text: "dans" } }] });
    expect(page.blocks[9]).toEqual({ component: "columns", props: {}, left: [{ component: "title", props: { text: "g" } }], right: [] });
    expect(page).toMatchObject({ fallback: false, empty: false, cuts: 0 });
  });

  it("a reference that no longer evaluates (saved plan, other results): error callout, no exception", () => {
    const page = render([{ component: "list", props: { items: "disparu", title: "t" } }, { component: "title", props: { text: "ok" } }]);
    expect(page.blocks[0]).toMatchObject({ component: "error" });
    expect((page.blocks[0] as { message: string }).message).not.toContain("disparu");
    expect(page.blocks[1]).toEqual({ component: "title", props: { text: "ok" } });
  });

  it("fallback and empty", () => {
    expect(render([{ component: "title", props: { text: "x" } }], { fallback: true }).fallback).toBe(true);
    expect(render([{ component: "title", props: { text: "x" } }], { r: [] }).empty).toBe(true);
    expect(render([{ component: "title", props: { text: "x" } }], { r: { tickets: [] } }).empty).toBe(true);
    expect(render([{ component: "title", props: { text: "x" } }], { r: { total: 0 } }).empty).toBe(false);
  });

  it("damaged plan (no block list, nesting too deep): no exception", () => {
    expect(resolvePage({} as PlanPage, results, { account: false, catalog: catalog, fallback: false }).blocks).toEqual([]);
    let b: PlanBlock = { component: "title", props: { text: "fond" } };
    for (let i = 0; i < 20_000; i++) b = { component: "group", props: { title: "g" }, blocks: [b] };
    expect(() => render([b])).not.toThrow();
  });
});

describe("chainsOf", () => {
  it("all the strings of the results, at any depth, not the keys", () => {
    const s = chainsOf({ a: "x", b: [1, "y", { c: "z", "clé-seule": 2 }], d: null });
    expect([...s].sort()).toEqual(["x", "y", "z"]);
  });
  it("results nested 20,000 levels deep: no exception", () => {
    let r: unknown = "fond";
    for (let i = 0; i < 20_000; i++) r = [r];
    expect(chainsOf(r).has("fond")).toBe(true);
  });

describe("highlight, card warnings and allowed addresses", () => {
  const found = {
    best: { name: "Yuba", price: "1 850 €", url: "https://lbc.fr/a/1", img: "https://img.lbc.fr/1.jpg" },
    items: [{ name: "Babboe", w: ["batterie 70 %"] }],
  };
  const blocks: PlanBlock[] = [
    { component: "highlight", props: { object: "best", label: "Le meilleur", title: "name", value: "price", link: "url", image: "img" } },
    { component: "cards", props: { items: "items", title: "name", warnings: "w" } },
  ];
  const plan = (r: unknown, allowed?: ReadonlySet<string>) =>
    resolvePage({ blocks: blocks }, r, { account: false, catalog: catalog, fallback: false, allowed: allowed }).blocks as any[];

  it("highlight and card warnings resolve", () => {
    const [h, c] = plan(found);
    expect(h.props).toMatchObject({ label: "Le meilleur", title: "Yuba", value: "1 850 €", link: { url: "https://lbc.fr/a/1" }, image: { url: "https://img.lbc.fr/1.jpg" } });
    expect(c.props.items[0].warnings).toEqual(["batterie 70 %"]);
  });
  it("allowed replaces the results rule", () => {
    const [h] = plan(found, new Set(["https://lbc.fr/a/1"]));
    expect(h.props.link.url).toBe("https://lbc.fr/a/1");
    expect(h.props.image).toBeNull();
  });
});
});
