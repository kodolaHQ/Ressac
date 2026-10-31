import { describe, expect, it } from "vitest";
import { COMPOSANTS_INTEGRES } from "../../src/pages/catalogue.js";
import { miseEnPageSecours } from "../../src/pages/secours.js";
import { validerPlan } from "../../src/pages/valider.js";

const tickets = [
  { titre: "Panne", priorite: "haute", url: "https://gitlab.com/t/1", auteur: { nom: "Ana" } },
  { titre: "Doc", priorite: "basse", url: "https://gitlab.com/t/2", auteur: { nom: "Bob" } },
];
const annonces = [
  { titre: "Vélo", prix: 120, photo: "https://img.example/1.jpg", lien: "https://lbc.fr/1" },
  { titre: "Table", prix: 40, photo: "https://img.example/2.jpg", lien: "https://lbc.fr/2" },
];
const valide = (r: unknown) => validerPlan(miseEnPageSecours(r), { catalogue: COMPOSANTS_INTEGRES, resultats: r });
const composants = (r: unknown) => miseEnPageSecours(r).blocs.map((b) => b.composant);

describe("miseEnPageSecours", () => {
  it("liste d'annonces avec photo https…jpg : cartes", () => {
    const plan = miseEnPageSecours(annonces);
    expect(plan.blocs).toHaveLength(1);
    expect(plan.blocs[0]).toMatchObject({ composant: "cartes", props: { elements: "$", titre: "titre", image: "photo", lien: "lien" } });
  });

  it("une image reconnue à son adresse, sans champ nommé image", () => {
    const r = [{ nom: "A", visuel: "https://x.fr/a.png", a: 1 }];
    expect(miseEnPageSecours(r).blocs[0]).toMatchObject({ composant: "cartes", props: { image: "visuel" } });
  });

  it("liste de tickets : tableau, lien = url", () => {
    const plan = miseEnPageSecours(tickets);
    expect(plan.blocs[0]).toMatchObject({ composant: "tableau", props: { elements: "$", lien: "url" } });
    expect((plan.blocs[0]!.props.colonnes as unknown[]).length).toBe(3);
  });

  it("le tableau garde les 6 premiers champs simples", () => {
    const r = [{ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: { x: 1 } }];
    expect((miseEnPageSecours(r).blocs[0]!.props.colonnes as unknown[]).length).toBe(6);
  });

  it("liste de textes : étiquettes", () => {
    expect(composants(["a", "b"])).toEqual(["etiquettes"]);
  });

  it("objet { total: 3, tickets: [...] } : titre, chiffre, tableau", () => {
    const c = composants({ total: 3, tickets });
    expect(c[0]).toBe("titre");
    expect(c).toContain("chiffre");
    expect(c).toContain("tableau");
  });

  it("objet de champs simples : champs ; texte : paragraphe", () => {
    expect(composants({ projet: { nom: "W", url: "https://x.fr" } })).toContain("champs");
    expect(composants({ resume: "bonjour" })).toContain("paragraphe");
  });

  it("texte seul : paragraphe ; nombre seul : chiffre", () => {
    expect(miseEnPageSecours("bonjour").blocs[0]).toMatchObject({ composant: "paragraphe", props: { valeur: "$" } });
    expect(miseEnPageSecours(42).blocs[0]).toMatchObject({ composant: "chiffre", props: { valeur: "$" } });
  });

  it("chaque secours passe validerPlan", () => {
    const cas: unknown[] = [
      annonces, tickets, ["a", "b"], "texte", 7, { total: 3, tickets }, { projet: { nom: "W" }, annonces, tags: ["x"], texte: "t", n: 0, ok: true },
      { "clé-bizarre": 1, tickets }, [1, 2, 3], JSON.parse('{"__proto__": {"a": 1}, "n": 2}'),
    ];
    for (const r of cas) {
      const v = valide(r);
      expect(v.ok, JSON.stringify(r).slice(0, 60)).toBe(true);
      if (v.ok) expect(v.ecartes).toEqual([]);
    }
  });
});
