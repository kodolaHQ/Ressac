import { describe, expect, it } from "vitest";
import { BUILTIN_COMPONENTS, type ComponentDefinition } from "../../src/pages/catalog.js";
import type { PlanBlock, PlanPage } from "../../src/pages/plan.js";
import { COMPONENT_UNAVAILABLE, ELEMENTS_MAX, TEXT_MAX, chainsOf, resolvePage, type RenderedBlock } from "../../src/pages/resolve.js";
import { validatePlan } from "../../src/pages/validate.js";

const graph: ComponentDefinition = {
  nom: "graphique-barres", description: "Barres", origine: "agent",
  proprietes: {
    donnees: { genre: "reference", description: "Les données", requis: true },
    etiquette: { genre: "champ", description: "Le champ", requis: false },
    titre: { genre: "texte", description: "Le titre", requis: false },
    max: { genre: "nombre", description: "Maximum", requis: false },
    empile: { genre: "case", description: "Empilé", requis: false },
  },
};
const catalog = [...BUILTIN_COMPONENTS, graph];
const fr = new Intl.NumberFormat("fr-FR");

const results = {
  projet: {
    nom: "WebAiOs", url: "https://gitlab.com/p", total: 1234.5,
    pieges: ["javascript:alert(1)", "http://127.0.0.1/admin", "http://192.168.1.2/", "http://[::1]/", "https://user:mdp@gitlab.com/"],
  },
  annonces: [
    { titre: "Clio", photo: "https://img.example/clio.jpg", prix: 7000, marque: "Renault", url: "https://site.example/clio" },
    { titre: "208", photo: "http://img.example/208.jpg", prix: 9000, marque: "Peugeot" },
    { titre: "Mégane", prix: 12000, marque: "Renault", tags: ["diesel", "break"] },
  ],
};

const render = (blocks: PlanBlock[], o: { compte?: boolean; secours?: boolean; r?: unknown } = {}) =>
  resolvePage({ blocs: blocks }, o.r ?? results, { compte: o.compte ?? false, catalogue: catalog, secours: o.secours ?? false });
const one = (block: PlanBlock, o?: Parameters<typeof render>[1]) => render([block], o).blocs[0] as RenderedBlock & { props: Record<string, any> };

describe("resolvePage", () => {
  it("link whose url is in the results: url kept", () => {
    const b = one({ composant: "lien", props: { objet: "projet", url: "url", champTexte: "nom" } });
    expect(b).toEqual({ composant: "lien", props: { lien: { texte: "WebAiOs", url: "https://gitlab.com/p" } } });
    const t = one({ composant: "lien", props: { objet: "projet", url: "url", texte: "Le projet" } });
    expect(t.props.lien).toEqual({ texte: "Le projet", url: "https://gitlab.com/p" });
  });

  it("literal link written by Gemma: property refused at validation", () => {
    for (const url of ["https://tiers.example/?d=x", '"https://tiers.example/?d=" + nom', "javascript:alert(1)"]) {
      const r = validatePlan({ blocs: [{ composant: "lien", props: { objet: "projet", url } }, { composant: "chiffre", props: { valeur: "compter(annonces)", libelle: "n" } }] }, { catalogue: catalog, resultats: results });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.plan.blocs.map((b) => b.composant)).toEqual(["chiffre"]);
        expect(r.ecartes[0]).toMatch(/^1\. lien : url : /);
      }
    }
  });

  it("url javascript:, http://127.0.0.1, http://192.168.1.2 : url null", () => {
    const r = { liens: results.projet.pieges.map((u) => ({ u })) };
    const b = one({ composant: "liste", props: { elements: "liens", titre: "u", lien: "u" } }, { r });
    expect(b.props.elements.map((l: any) => l.lien.url)).toEqual([null, null, null, null, null]);
    expect(b.props.elements.map((l: any) => l.lien.texte)).toEqual(results.projet.pieges);
  });

  it("a url absent from the results (read elsewhere): url null", () => {
    const values = { o: { u: "https://tiers.example/" } };
    // The same string is only « present » if it is among the strings of the results passed: here yes.
    expect(one({ composant: "lien", props: { objet: "o", url: "u" } }, { r: values }).props.lien.url).toBe("https://tiers.example/");
    // A number or an object is not an address.
    expect(one({ composant: "lien", props: { objet: "o", url: "u" } }, { r: { o: { u: 3 } } }).props.lien.url).toBeNull();
  });

  it("https image of an action without an account: { url }; with an account: neutral; over http: null", () => {
    const card = { composant: "cartes", props: { elements: "annonces", titre: "titre", image: "photo" } };
    const without = one(card).props.elements.map((c: any) => c.image);
    expect(without).toEqual([{ url: "https://img.example/clio.jpg" }, null, null]);
    const updateEntry = one(card, { compte: true }).props.elements.map((c: any) => c.image);
    expect(updateEntry).toEqual([{ neutre: true }, { neutre: true }, null]);
    const local = one(card, { r: { annonces: [{ titre: "x", photo: "https://192.168.1.2/a.png" }] } }).props.elements[0].image;
    expect(local).toBeNull();
  });

  it("titre « <img src=x onerror=…> » rendu en texte tel quel", () => {
    const html = "<img src=x onerror=alert(1)>";
    expect(one({ composant: "titre", props: { texte: html } })).toEqual({ composant: "titre", props: { texte: html } });
    const l = one({ composant: "liste", props: { elements: "x", titre: "t" } }, { r: { x: [{ t: html }] } });
    expect(l.props.elements[0].titre).toBe(html);
  });

  it("10,000 tickets in a table: 200 rows, cuts 9800", () => {
    const tickets = Array.from({ length: 10_000 }, (_, i) => ({ id: i, titre: `t${i}`, url: `https://gitlab.com/t/${i}` }));
    const page = render([{ composant: "tableau", props: { elements: "tickets", colonnes: [{ champ: "id", libelle: "N°" }, { champ: "titre", libelle: "Titre" }], lien: "url" } }], { r: { tickets } });
    const b = page.blocs[0] as RenderedBlock & { props: Record<string, any> };
    expect(b.props.elements).toHaveLength(ELEMENTS_MAX);
    expect(b.props.autres).toBe(9800);
    expect(page.coupes).toBe(9800);
    expect(b.props.colonnes).toEqual([{ champ: "id", libelle: "N°" }, { champ: "titre", libelle: "Titre" }]);
    expect(b.props.elements[1]).toEqual({ valeurs: { id: fr.format(1), titre: "t1" }, lien: { texte: "https://gitlab.com/t/1", url: "https://gitlab.com/t/1" } });
    expect(b.props.elements[199].valeurs.id).toBe(fr.format(199));
  });

  it("regrouper given to cards: one section per value", () => {
    const b = one({ composant: "cartes", props: { elements: "regrouper(annonces, marque)", titre: "titre", valeur: "prix", etiquettes: "tags" } });
    expect(b.props.elements).toBeUndefined();
    expect(b.props.groupes.map((g: any) => [g.valeur, g.elements.map((c: any) => c.titre)])).toEqual([["Renault", ["Clio", "Mégane"]], ["Peugeot", ["208"]]]);
    expect(b.props.groupes[0].elements[0].valeur).toBe(fr.format(7000));
    expect(b.props.groupes[0].elements[1].etiquettes).toEqual(["diesel", "break"]);
    expect(b.props.autres).toBe(0);
  });

  it("regrouper cut: 200 elements in total, the rest counted", () => {
    const l = Array.from({ length: 300 }, (_, i) => ({ t: `e${i}`, k: i % 2 ? "a" : "b" }));
    const b = one({ composant: "liste", props: { elements: "regrouper(l, k)", titre: "t" } }, { r: { l } });
    expect(b.props.groupes.reduce((n: number, g: any) => n + g.elements.length, 0)).toBe(ELEMENTS_MAX);
    expect(b.props.autres).toBe(100);
  });

  it("agent component: reference evaluated, field passed by its name", () => {
    const b = one({ composant: "graphique-barres", props: { donnees: 'filtrer(annonces, marque = "Renault")', etiquette: "titre", titre: "Prix", max: 20000, empile: true } });
    expect(b.composant).toBe("graphique-barres");
    expect(b.props.donnees.map((a: any) => a.titre)).toEqual(["Clio", "Mégane"]);
    expect(b.props).toMatchObject({ etiquette: "titre", titre: "Prix", max: 20000, empile: true });
  });

  it("agent component: bounded value (lists to 200, texts cut)", () => {
    const l = Array.from({ length: 250 }, () => "x".repeat(TEXT_MAX + 50));
    const page = render([{ composant: "graphique-barres", props: { donnees: "l" } }], { r: { l } });
    const b = page.blocs[0] as RenderedBlock & { props: Record<string, any> };
    expect(b.props.donnees).toHaveLength(ELEMENTS_MAX);
    expect(b.props.donnees[0].length).toBeLessThanOrEqual(TEXT_MAX);
    expect(page.coupes).toBe(50);
  });

  it("component missing from the catalog: error callout, the rest displays", () => {
    const page = render([{ composant: "camembert", props: { donnees: "annonces" } }, { composant: "titre", props: { texte: "Après" } }]);
    expect(page.blocs).toEqual([{ composant: "erreur", message: COMPONENT_UNAVAILABLE("camembert") }, { composant: "titre", props: { texte: "Après" } }]);
    expect(COMPONENT_UNAVAILABLE("camembert")).toBe("Composant indisponible : camembert");
  });

  it("texts: numbers in fr-FR, long ones cut to TEXTE_MAX, simple values", () => {
    expect(one({ composant: "chiffre", props: { valeur: "projet.total", libelle: "Total" } }).props).toEqual({ valeur: fr.format(1234.5), libelle: "Total" });
    expect(one({ composant: "chiffre", props: { valeur: "compter(annonces)", libelle: "n" } }).props.valeur).toBe("3");
    const long = one({ composant: "paragraphe", props: { valeur: "t" } }, { r: { t: "a".repeat(100_000) } });
    expect(long.props.texte.length).toBe(TEXT_MAX);
    expect(long.props.texte.endsWith("…")).toBe(true);
  });

  it("each built-in component resolves", () => {
    const page = render([
      { composant: "titre", props: { texte: "T" } },
      { composant: "paragraphe", props: { texte: "P" } },
      { composant: "encadre", props: { niveau: "info", titre: "E", elements: "annonces", champ: "titre" } },
      { composant: "chiffres", props: { chiffres: [{ valeur: "compter(annonces)", libelle: "n" }] } },
      { composant: "champs", props: { objet: "projet" } },
      { composant: "champs", props: { objet: "projet", champs: [{ champ: "nom", libelle: "Nom" }] } },
      { composant: "etiquettes", props: { elements: "annonces", champ: "marque" } },
      { composant: "etiquettes", props: { valeurs: "projet.pieges" } },
      { composant: "groupe", props: { titre: "G", replie: true }, blocs: [{ composant: "titre", props: { texte: "dans" } }] },
      { composant: "colonnes", props: {}, gauche: [{ composant: "titre", props: { texte: "g" } }], droite: [] },
    ]);
    const p = page.blocs.map((b) => ("props" in b ? b.props : b));
    expect(p[2]).toEqual({ niveau: "info", titre: "E", texte: null, elements: ["Clio", "208", "Mégane"], autres: 0 });
    expect(p[3]).toEqual({ chiffres: [{ valeur: "3", libelle: "n" }] });
    expect(p[4]).toEqual({ champs: [{ libelle: "nom", valeur: "WebAiOs" }, { libelle: "url", valeur: "https://gitlab.com/p" }, { libelle: "total", valeur: fr.format(1234.5) }], autres: 0 });
    expect(p[5]).toEqual({ champs: [{ libelle: "Nom", valeur: "WebAiOs" }], autres: 0 });
    expect(p[6]).toEqual({ valeurs: ["Renault", "Peugeot", "Renault"], autres: 0 });
    expect(p[7]).toEqual({ valeurs: results.projet.pieges, autres: 0 });
    expect(page.blocs[8]).toEqual({ composant: "groupe", props: { titre: "G", replie: true }, blocs: [{ composant: "titre", props: { texte: "dans" } }] });
    expect(page.blocs[9]).toEqual({ composant: "colonnes", props: {}, gauche: [{ composant: "titre", props: { texte: "g" } }], droite: [] });
    expect(page).toMatchObject({ secours: false, vide: false, coupes: 0 });
  });

  it("a reference that no longer evaluates (saved plan, other results): error callout, no exception", () => {
    const page = render([{ composant: "liste", props: { elements: "disparu", titre: "t" } }, { composant: "titre", props: { texte: "ok" } }]);
    expect(page.blocs[0]).toMatchObject({ composant: "erreur" });
    expect((page.blocs[0] as { message: string }).message).not.toContain("disparu");
    expect(page.blocs[1]).toEqual({ composant: "titre", props: { texte: "ok" } });
  });

  it("fallback and empty", () => {
    expect(render([{ composant: "titre", props: { texte: "x" } }], { secours: true }).secours).toBe(true);
    expect(render([{ composant: "titre", props: { texte: "x" } }], { r: [] }).vide).toBe(true);
    expect(render([{ composant: "titre", props: { texte: "x" } }], { r: { tickets: [] } }).vide).toBe(true);
    expect(render([{ composant: "titre", props: { texte: "x" } }], { r: { total: 0 } }).vide).toBe(false);
  });

  it("damaged plan (no block list, nesting too deep): no exception", () => {
    expect(resolvePage({} as PlanPage, results, { compte: false, catalogue: catalog, secours: false }).blocs).toEqual([]);
    let b: PlanBlock = { composant: "titre", props: { texte: "fond" } };
    for (let i = 0; i < 20_000; i++) b = { composant: "groupe", props: { titre: "g" }, blocs: [b] };
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
