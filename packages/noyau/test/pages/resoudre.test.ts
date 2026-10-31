import { describe, expect, it } from "vitest";
import { COMPOSANTS_INTEGRES, type DefinitionComposant } from "../../src/pages/catalogue.js";
import type { BlocPlan, PlanPage } from "../../src/pages/plan.js";
import { COMPOSANT_INDISPONIBLE, ELEMENTS_MAX, TEXTE_MAX, chainesDe, resoudrePage, type BlocRendu } from "../../src/pages/resoudre.js";
import { validerPlan } from "../../src/pages/valider.js";

const graphique: DefinitionComposant = {
  nom: "graphique-barres", description: "Barres", origine: "agent",
  proprietes: {
    donnees: { genre: "reference", description: "Les données", requis: true },
    etiquette: { genre: "champ", description: "Le champ", requis: false },
    titre: { genre: "texte", description: "Le titre", requis: false },
    max: { genre: "nombre", description: "Maximum", requis: false },
    empile: { genre: "case", description: "Empilé", requis: false },
  },
};
const catalogue = [...COMPOSANTS_INTEGRES, graphique];
const fr = new Intl.NumberFormat("fr-FR");

const resultats = {
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

const rendre = (blocs: BlocPlan[], o: { compte?: boolean; secours?: boolean; r?: unknown } = {}) =>
  resoudrePage({ blocs }, o.r ?? resultats, { compte: o.compte ?? false, catalogue, secours: o.secours ?? false });
const un = (bloc: BlocPlan, o?: Parameters<typeof rendre>[1]) => rendre([bloc], o).blocs[0] as BlocRendu & { props: Record<string, any> };

describe("resoudrePage", () => {
  it("lien dont l'url est dans les résultats : url gardée", () => {
    const b = un({ composant: "lien", props: { objet: "projet", url: "url", champTexte: "nom" } });
    expect(b).toEqual({ composant: "lien", props: { lien: { texte: "WebAiOs", url: "https://gitlab.com/p" } } });
    const t = un({ composant: "lien", props: { objet: "projet", url: "url", texte: "Le projet" } });
    expect(t.props.lien).toEqual({ texte: "Le projet", url: "https://gitlab.com/p" });
  });

  it("lien littéral écrit par Gemma : propriété refusée à la validation", () => {
    for (const url of ["https://tiers.example/?d=x", '"https://tiers.example/?d=" + nom', "javascript:alert(1)"]) {
      const r = validerPlan({ blocs: [{ composant: "lien", props: { objet: "projet", url } }, { composant: "chiffre", props: { valeur: "compter(annonces)", libelle: "n" } }] }, { catalogue, resultats });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.plan.blocs.map((b) => b.composant)).toEqual(["chiffre"]);
        expect(r.ecartes[0]).toMatch(/^1\. lien : url : /);
      }
    }
  });

  it("url javascript:, http://127.0.0.1, http://192.168.1.2 : url null", () => {
    const r = { liens: resultats.projet.pieges.map((u) => ({ u })) };
    const b = un({ composant: "liste", props: { elements: "liens", titre: "u", lien: "u" } }, { r });
    expect(b.props.elements.map((l: any) => l.lien.url)).toEqual([null, null, null, null, null]);
    expect(b.props.elements.map((l: any) => l.lien.texte)).toEqual(resultats.projet.pieges);
  });

  it("une url absente des résultats (lue ailleurs) : url null", () => {
    const valeurs = { o: { u: "https://tiers.example/" } };
    // La même chaîne n'est « présente » que si elle figure parmi les chaînes des résultats passés : ici oui.
    expect(un({ composant: "lien", props: { objet: "o", url: "u" } }, { r: valeurs }).props.lien.url).toBe("https://tiers.example/");
    // Un nombre ou un objet n'est pas une adresse.
    expect(un({ composant: "lien", props: { objet: "o", url: "u" } }, { r: { o: { u: 3 } } }).props.lien.url).toBeNull();
  });

  it("image https d'une action sans compte : { url } ; avec compte : neutre ; en http : null", () => {
    const carte = { composant: "cartes", props: { elements: "annonces", titre: "titre", image: "photo" } };
    const sans = un(carte).props.elements.map((c: any) => c.image);
    expect(sans).toEqual([{ url: "https://img.example/clio.jpg" }, null, null]);
    const avec = un(carte, { compte: true }).props.elements.map((c: any) => c.image);
    expect(avec).toEqual([{ neutre: true }, { neutre: true }, null]);
    const local = un(carte, { r: { annonces: [{ titre: "x", photo: "https://192.168.1.2/a.png" }] } }).props.elements[0].image;
    expect(local).toBeNull();
  });

  it("titre « <img src=x onerror=…> » rendu en texte tel quel", () => {
    const html = "<img src=x onerror=alert(1)>";
    expect(un({ composant: "titre", props: { texte: html } })).toEqual({ composant: "titre", props: { texte: html } });
    const l = un({ composant: "liste", props: { elements: "x", titre: "t" } }, { r: { x: [{ t: html }] } });
    expect(l.props.elements[0].titre).toBe(html);
  });

  it("10 000 tickets dans un tableau : 200 lignes, coupes 9800", () => {
    const tickets = Array.from({ length: 10_000 }, (_, i) => ({ id: i, titre: `t${i}`, url: `https://gitlab.com/t/${i}` }));
    const page = rendre([{ composant: "tableau", props: { elements: "tickets", colonnes: [{ champ: "id", libelle: "N°" }, { champ: "titre", libelle: "Titre" }], lien: "url" } }], { r: { tickets } });
    const b = page.blocs[0] as BlocRendu & { props: Record<string, any> };
    expect(b.props.elements).toHaveLength(ELEMENTS_MAX);
    expect(b.props.autres).toBe(9800);
    expect(page.coupes).toBe(9800);
    expect(b.props.colonnes).toEqual([{ champ: "id", libelle: "N°" }, { champ: "titre", libelle: "Titre" }]);
    expect(b.props.elements[1]).toEqual({ valeurs: { id: fr.format(1), titre: "t1" }, lien: { texte: "https://gitlab.com/t/1", url: "https://gitlab.com/t/1" } });
    expect(b.props.elements[199].valeurs.id).toBe(fr.format(199));
  });

  it("regrouper donné à cartes : une section par valeur", () => {
    const b = un({ composant: "cartes", props: { elements: "regrouper(annonces, marque)", titre: "titre", valeur: "prix", etiquettes: "tags" } });
    expect(b.props.elements).toBeUndefined();
    expect(b.props.groupes.map((g: any) => [g.valeur, g.elements.map((c: any) => c.titre)])).toEqual([["Renault", ["Clio", "Mégane"]], ["Peugeot", ["208"]]]);
    expect(b.props.groupes[0].elements[0].valeur).toBe(fr.format(7000));
    expect(b.props.groupes[0].elements[1].etiquettes).toEqual(["diesel", "break"]);
    expect(b.props.autres).toBe(0);
  });

  it("regrouper coupé : 200 éléments au total, le reste compté", () => {
    const l = Array.from({ length: 300 }, (_, i) => ({ t: `e${i}`, k: i % 2 ? "a" : "b" }));
    const b = un({ composant: "liste", props: { elements: "regrouper(l, k)", titre: "t" } }, { r: { l } });
    expect(b.props.groupes.reduce((n: number, g: any) => n + g.elements.length, 0)).toBe(ELEMENTS_MAX);
    expect(b.props.autres).toBe(100);
  });

  it("composant de l'agent : reference évaluée, champ transmis par son nom", () => {
    const b = un({ composant: "graphique-barres", props: { donnees: 'filtrer(annonces, marque = "Renault")', etiquette: "titre", titre: "Prix", max: 20000, empile: true } });
    expect(b.composant).toBe("graphique-barres");
    expect(b.props.donnees.map((a: any) => a.titre)).toEqual(["Clio", "Mégane"]);
    expect(b.props).toMatchObject({ etiquette: "titre", titre: "Prix", max: 20000, empile: true });
  });

  it("composant de l'agent : valeur bornée (listes à 200, textes coupés)", () => {
    const l = Array.from({ length: 250 }, () => "x".repeat(TEXTE_MAX + 50));
    const page = rendre([{ composant: "graphique-barres", props: { donnees: "l" } }], { r: { l } });
    const b = page.blocs[0] as BlocRendu & { props: Record<string, any> };
    expect(b.props.donnees).toHaveLength(ELEMENTS_MAX);
    expect(b.props.donnees[0].length).toBeLessThanOrEqual(TEXTE_MAX);
    expect(page.coupes).toBe(50);
  });

  it("composant absent du catalogue : encadré d'erreur, le reste s'affiche", () => {
    const page = rendre([{ composant: "camembert", props: { donnees: "annonces" } }, { composant: "titre", props: { texte: "Après" } }]);
    expect(page.blocs).toEqual([{ composant: "erreur", message: COMPOSANT_INDISPONIBLE("camembert") }, { composant: "titre", props: { texte: "Après" } }]);
    expect(COMPOSANT_INDISPONIBLE("camembert")).toBe("Composant indisponible : camembert");
  });

  it("textes : nombres en fr-FR, longs coupés à TEXTE_MAX, valeurs simples", () => {
    expect(un({ composant: "chiffre", props: { valeur: "projet.total", libelle: "Total" } }).props).toEqual({ valeur: fr.format(1234.5), libelle: "Total" });
    expect(un({ composant: "chiffre", props: { valeur: "compter(annonces)", libelle: "n" } }).props.valeur).toBe("3");
    const long = un({ composant: "paragraphe", props: { valeur: "t" } }, { r: { t: "a".repeat(100_000) } });
    expect(long.props.texte.length).toBe(TEXTE_MAX);
    expect(long.props.texte.endsWith("…")).toBe(true);
  });

  it("chaque composant intégré se résout", () => {
    const page = rendre([
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
    expect(p[7]).toEqual({ valeurs: resultats.projet.pieges, autres: 0 });
    expect(page.blocs[8]).toEqual({ composant: "groupe", props: { titre: "G", replie: true }, blocs: [{ composant: "titre", props: { texte: "dans" } }] });
    expect(page.blocs[9]).toEqual({ composant: "colonnes", props: {}, gauche: [{ composant: "titre", props: { texte: "g" } }], droite: [] });
    expect(page).toMatchObject({ secours: false, vide: false, coupes: 0 });
  });

  it("une référence qui ne s'évalue plus (plan enregistré, résultats autres) : encadré d'erreur, pas d'exception", () => {
    const page = rendre([{ composant: "liste", props: { elements: "disparu", titre: "t" } }, { composant: "titre", props: { texte: "ok" } }]);
    expect(page.blocs[0]).toMatchObject({ composant: "erreur" });
    expect((page.blocs[0] as { message: string }).message).not.toContain("disparu");
    expect(page.blocs[1]).toEqual({ composant: "titre", props: { texte: "ok" } });
  });

  it("secours et vide", () => {
    expect(rendre([{ composant: "titre", props: { texte: "x" } }], { secours: true }).secours).toBe(true);
    expect(rendre([{ composant: "titre", props: { texte: "x" } }], { r: [] }).vide).toBe(true);
    expect(rendre([{ composant: "titre", props: { texte: "x" } }], { r: { tickets: [] } }).vide).toBe(true);
    expect(rendre([{ composant: "titre", props: { texte: "x" } }], { r: { total: 0 } }).vide).toBe(false);
  });

  it("plan abîmé (pas de liste de blocs, imbrication trop profonde) : pas d'exception", () => {
    expect(resoudrePage({} as PlanPage, resultats, { compte: false, catalogue, secours: false }).blocs).toEqual([]);
    let b: BlocPlan = { composant: "titre", props: { texte: "fond" } };
    for (let i = 0; i < 20_000; i++) b = { composant: "groupe", props: { titre: "g" }, blocs: [b] };
    expect(() => rendre([b])).not.toThrow();
  });
});

describe("chainesDe", () => {
  it("toutes les chaînes des résultats, à toute profondeur, pas les clés", () => {
    const s = chainesDe({ a: "x", b: [1, "y", { c: "z", "clé-seule": 2 }], d: null });
    expect([...s].sort()).toEqual(["x", "y", "z"]);
  });
  it("résultats imbriqués sur 20 000 niveaux : pas d'exception", () => {
    let r: unknown = "fond";
    for (let i = 0; i < 20_000; i++) r = [r];
    expect(chainesDe(r).has("fond")).toBe(true);
  });
});
