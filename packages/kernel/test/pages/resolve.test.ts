import { describe, expect, it } from "vitest";
import { BUILTIN_COMPONENTS, type ComponentDefinition } from "../../src/pages/catalog.js";
import type { PlanBlock, PlanPage } from "../../src/pages/plan.js";
import { COMPONENT_UNAVAILABLE, ELEMENTS_MAX, TEXT_MAX, chainsOf, resolvePage, type RenderedBlock } from "../../src/pages/resolve.js";
import { validatePlan } from "../../src/pages/validate.js";

const graph: ComponentDefinition = {
  name: "graphique-barres", description: "Barres", origin: "agent",
  properties: {
    data: { kind: "reference", description: "Les données", required: true },
    label: { kind: "champ", description: "Le champ", required: false },
    title: { kind: "texte", description: "Le titre", required: false },
    max: { kind: "nombre", description: "Maximum", required: false },
    stacked: { kind: "case", description: "Empilé", required: false },
  },
};
const catalog = [...BUILTIN_COMPONENTS, graph];
const fr = new Intl.NumberFormat("fr-FR");

const results = {
  project: {
    name: "WebAiOs", url: "https://gitlab.com/p", total: 1234.5,
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
    const b = one({ component: "lien", props: { object: "projet", url: "url", textField: "nom" } });
    expect(b).toEqual({ component: "lien", props: { link: { text: "WebAiOs", url: "https://gitlab.com/p" } } });
    const t = one({ component: "lien", props: { object: "projet", url: "url", text: "Le projet" } });
    expect(t.props.lien).toEqual({ text: "Le projet", url: "https://gitlab.com/p" });
  });

  it("literal link written by Gemma: property refused at validation", () => {
    for (const url of ["https://tiers.example/?d=x", '"https://tiers.example/?d=" + nom', "javascript:alert(1)"]) {
      const r = validatePlan({ blocks: [{ component: "lien", props: { object: "projet", url } }, { component: "chiffre", props: { value: "compter(annonces)", label: "n" } }] }, { catalog: catalog, results: results });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.plan.blocks.map((b) => b.component)).toEqual(["chiffre"]);
        expect(r.discarded[0]).toMatch(/^1\. lien : url : /);
      }
    }
  });

  it("url javascript:, http://127.0.0.1, http://192.168.1.2 : url null", () => {
    const r = { links: results.project.traps.map((u) => ({ u })) };
    const b = one({ component: "liste", props: { items: "liens", title: "u", link: "u" } }, { r });
    expect(b.props.elements.map((l: any) => l.lien.url)).toEqual([null, null, null, null, null]);
    expect(b.props.elements.map((l: any) => l.lien.texte)).toEqual(results.project.traps);
  });

  it("a url absent from the results (read elsewhere): url null", () => {
    const values = { o: { u: "https://tiers.example/" } };
    // The same string is only « present » if it is among the strings of the results passed: here yes.
    expect(one({ component: "lien", props: { object: "o", url: "u" } }, { r: values }).props.lien.url).toBe("https://tiers.example/");
    // A number or an object is not an address.
    expect(one({ component: "lien", props: { object: "o", url: "u" } }, { r: { o: { u: 3 } } }).props.lien.url).toBeNull();
  });

  it("https image of an action without an account: { url }; with an account: neutral; over http: null", () => {
    const card = { component: "cartes", props: { items: "annonces", title: "titre", image: "photo" } };
    const without = one(card).props.elements.map((c: any) => c.image);
    expect(without).toEqual([{ url: "https://img.example/clio.jpg" }, null, null]);
    const updateEntry = one(card, { account: true }).props.elements.map((c: any) => c.image);
    expect(updateEntry).toEqual([{ neutral: true }, { neutral: true }, null]);
    const local = one(card, { r: { announcements: [{ title: "x", snapshot: "https://192.168.1.2/a.png" }] } }).props.elements[0].image;
    expect(local).toBeNull();
  });

  it("titre « <img src=x onerror=…> » rendu en texte tel quel", () => {
    const html = "<img src=x onerror=alert(1)>";
    expect(one({ component: "titre", props: { text: html } })).toEqual({ component: "titre", props: { text: html } });
    const l = one({ component: "liste", props: { items: "x", title: "t" } }, { r: { x: [{ t: html }] } });
    expect(l.props.elements[0].titre).toBe(html);
  });

  it("10,000 tickets in a table: 200 rows, cuts 9800", () => {
    const tickets = Array.from({ length: 10_000 }, (_, i) => ({ id: i, title: `t${i}`, url: `https://gitlab.com/t/${i}` }));
    const page = render([{ component: "tableau", props: { items: "tickets", columns: [{ field: "id", label: "N°" }, { field: "titre", label: "Titre" }], link: "url" } }], { r: { tickets } });
    const b = page.blocks[0] as RenderedBlock & { props: Record<string, any> };
    expect(b.props.elements).toHaveLength(ELEMENTS_MAX);
    expect(b.props.autres).toBe(9800);
    expect(page.cuts).toBe(9800);
    expect(b.props.colonnes).toEqual([{ field: "id", label: "N°" }, { field: "titre", label: "Titre" }]);
    expect(b.props.elements[1]).toEqual({ values: { id: fr.format(1), title: "t1" }, link: { text: "https://gitlab.com/t/1", url: "https://gitlab.com/t/1" } });
    expect(b.props.elements[199].valeurs.id).toBe(fr.format(199));
  });

  it("regrouper given to cards: one section per value", () => {
    const b = one({ component: "cartes", props: { items: "regrouper(annonces, marque)", title: "titre", value: "prix", tags: "tags" } });
    expect(b.props.elements).toBeUndefined();
    expect(b.props.groupes.map((g: any) => [g.valeur, g.elements.map((c: any) => c.titre)])).toEqual([["Renault", ["Clio", "Mégane"]], ["Peugeot", ["208"]]]);
    expect(b.props.groupes[0].elements[0].valeur).toBe(fr.format(7000));
    expect(b.props.groupes[0].elements[1].etiquettes).toEqual(["diesel", "break"]);
    expect(b.props.autres).toBe(0);
  });

  it("regrouper cut: 200 elements in total, the rest counted", () => {
    const l = Array.from({ length: 300 }, (_, i) => ({ t: `e${i}`, k: i % 2 ? "a" : "b" }));
    const b = one({ component: "liste", props: { items: "regrouper(l, k)", title: "t" } }, { r: { l } });
    expect(b.props.groupes.reduce((n: number, g: any) => n + g.elements.length, 0)).toBe(ELEMENTS_MAX);
    expect(b.props.autres).toBe(100);
  });

  it("agent component: reference evaluated, field passed by its name", () => {
    const b = one({ component: "graphique-barres", props: { data: 'filtrer(annonces, marque = "Renault")', label: "titre", title: "Prix", max: 20000, stacked: true } });
    expect(b.component).toBe("graphique-barres");
    expect(b.props.donnees.map((a: any) => a.titre)).toEqual(["Clio", "Mégane"]);
    expect(b.props).toMatchObject({ label: "titre", title: "Prix", max: 20000, stacked: true });
  });

  it("agent component: bounded value (lists to 200, texts cut)", () => {
    const l = Array.from({ length: 250 }, () => "x".repeat(TEXT_MAX + 50));
    const page = render([{ component: "graphique-barres", props: { data: "l" } }], { r: { l } });
    const b = page.blocks[0] as RenderedBlock & { props: Record<string, any> };
    expect(b.props.donnees).toHaveLength(ELEMENTS_MAX);
    expect(b.props.donnees[0].length).toBeLessThanOrEqual(TEXT_MAX);
    expect(page.cuts).toBe(50);
  });

  it("component missing from the catalog: error callout, the rest displays", () => {
    const page = render([{ component: "camembert", props: { data: "annonces" } }, { component: "titre", props: { text: "Après" } }]);
    expect(page.blocks).toEqual([{ component: "erreur", message: COMPONENT_UNAVAILABLE("camembert") }, { component: "titre", props: { text: "Après" } }]);
    expect(COMPONENT_UNAVAILABLE("camembert")).toBe("Composant indisponible : camembert");
  });

  it("texts: numbers in fr-FR, long ones cut to TEXTE_MAX, simple values", () => {
    expect(one({ component: "chiffre", props: { value: "projet.total", label: "Total" } }).props).toEqual({ value: fr.format(1234.5), label: "Total" });
    expect(one({ component: "chiffre", props: { value: "compter(annonces)", label: "n" } }).props.valeur).toBe("3");
    const long = one({ component: "paragraphe", props: { value: "t" } }, { r: { t: "a".repeat(100_000) } });
    expect(long.props.texte.length).toBe(TEXT_MAX);
    expect(long.props.texte.endsWith("…")).toBe(true);
  });

  it("each built-in component resolves", () => {
    const page = render([
      { component: "titre", props: { text: "T" } },
      { component: "paragraphe", props: { text: "P" } },
      { component: "encadre", props: { level: "info", title: "E", items: "annonces", field: "titre" } },
      { component: "chiffres", props: { figures: [{ value: "compter(annonces)", label: "n" }] } },
      { component: "champs", props: { object: "projet" } },
      { component: "champs", props: { object: "projet", fields: [{ field: "nom", label: "Nom" }] } },
      { component: "etiquettes", props: { items: "annonces", field: "marque" } },
      { component: "etiquettes", props: { values: "projet.pieges" } },
      { component: "groupe", props: { title: "G", collapsed: true }, blocks: [{ component: "titre", props: { text: "dans" } }] },
      { component: "colonnes", props: {}, left: [{ component: "titre", props: { text: "g" } }], right: [] },
    ]);
    const p = page.blocks.map((b) => ("props" in b ? b.props : b));
    expect(p[2]).toEqual({ level: "info", title: "E", text: null, items: ["Clio", "208", "Mégane"], others: 0 });
    expect(p[3]).toEqual({ figures: [{ value: "3", label: "n" }] });
    expect(p[4]).toEqual({ fields: [{ label: "nom", value: "WebAiOs" }, { label: "url", value: "https://gitlab.com/p" }, { label: "total", value: fr.format(1234.5) }], others: 0 });
    expect(p[5]).toEqual({ fields: [{ label: "Nom", value: "WebAiOs" }], others: 0 });
    expect(p[6]).toEqual({ values: ["Renault", "Peugeot", "Renault"], others: 0 });
    expect(p[7]).toEqual({ values: results.project.traps, others: 0 });
    expect(page.blocks[8]).toEqual({ component: "groupe", props: { title: "G", collapsed: true }, blocks: [{ component: "titre", props: { text: "dans" } }] });
    expect(page.blocks[9]).toEqual({ component: "colonnes", props: {}, left: [{ component: "titre", props: { text: "g" } }], right: [] });
    expect(page).toMatchObject({ fallback: false, empty: false, cuts: 0 });
  });

  it("a reference that no longer evaluates (saved plan, other results): error callout, no exception", () => {
    const page = render([{ component: "liste", props: { items: "disparu", title: "t" } }, { component: "titre", props: { text: "ok" } }]);
    expect(page.blocks[0]).toMatchObject({ component: "erreur" });
    expect((page.blocks[0] as { message: string }).message).not.toContain("disparu");
    expect(page.blocks[1]).toEqual({ component: "titre", props: { text: "ok" } });
  });

  it("fallback and empty", () => {
    expect(render([{ component: "titre", props: { text: "x" } }], { fallback: true }).fallback).toBe(true);
    expect(render([{ component: "titre", props: { text: "x" } }], { r: [] }).empty).toBe(true);
    expect(render([{ component: "titre", props: { text: "x" } }], { r: { tickets: [] } }).empty).toBe(true);
    expect(render([{ component: "titre", props: { text: "x" } }], { r: { total: 0 } }).empty).toBe(false);
  });

  it("damaged plan (no block list, nesting too deep): no exception", () => {
    expect(resolvePage({} as PlanPage, results, { account: false, catalog: catalog, fallback: false }).blocks).toEqual([]);
    let b: PlanBlock = { component: "titre", props: { text: "fond" } };
    for (let i = 0; i < 20_000; i++) b = { component: "groupe", props: { title: "g" }, blocks: [b] };
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
});
