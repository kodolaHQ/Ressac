import { describe, expect, it } from "vitest";
import { resolvePage } from "../../src/pages/resolve.js";
import { BUILTIN_COMPONENTS } from "../../src/pages/catalogue.js";
import { fallbackLayout } from "../../src/pages/fallback.js";
import { validatePlan } from "../../src/pages/validate.js";

const tickets = [
  { titre: "Panne", priorite: "haute", url: "https://gitlab.com/t/1", auteur: { nom: "Ana" } },
  { titre: "Doc", priorite: "basse", url: "https://gitlab.com/t/2", auteur: { nom: "Bob" } },
];
const announcements = [
  { titre: "Vélo", prix: 120, photo: "https://img.example/1.jpg", lien: "https://lbc.fr/1" },
  { titre: "Table", prix: 40, photo: "https://img.example/2.jpg", lien: "https://lbc.fr/2" },
];
const valid = (r: unknown) => validatePlan(fallbackLayout(r), { catalogue: BUILTIN_COMPONENTS, resultats: r });
const components = (r: unknown) => fallbackLayout(r).blocs.map((b) => b.composant);

describe("miseEnPageSecours", () => {
  it("list of listings with https…jpg photo: cards", () => {
    const plan = fallbackLayout(announcements);
    expect(plan.blocs).toHaveLength(1);
    expect(plan.blocs[0]).toMatchObject({ composant: "cartes", props: { elements: "$", titre: "titre", image: "photo", lien: "lien" } });
  });

  it("an image recognized by its address, without a field named image", () => {
    const r = [{ nom: "A", visuel: "https://x.fr/a.png", a: 1 }];
    expect(fallbackLayout(r).blocs[0]).toMatchObject({ composant: "cartes", props: { image: "visuel" } });
  });

  it("liste de tickets : tableau, lien = url", () => {
    const plan = fallbackLayout(tickets);
    expect(plan.blocs[0]).toMatchObject({ composant: "tableau", props: { elements: "$", lien: "url" } });
    expect((plan.blocs[0]!.props.colonnes as unknown[]).length).toBe(3);
  });

  it("the table keeps the first 6 simple fields", () => {
    const r = [{ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: { x: 1 } }];
    expect((fallbackLayout(r).blocs[0]!.props.colonnes as unknown[]).length).toBe(6);
  });

  it("list of texts: labels", () => {
    expect(components(["a", "b"])).toEqual(["etiquettes"]);
  });

  it("objet { total: 3, tickets: [...] } : titre, chiffre, tableau", () => {
    const c = components({ total: 3, tickets });
    expect(c[0]).toBe("titre");
    expect(c).toContain("chiffre");
    expect(c).toContain("tableau");
  });

  it("objet de champs simples : champs ; texte : paragraphe", () => {
    expect(components({ projet: { nom: "W", url: "https://x.fr" } })).toContain("champs");
    expect(components({ resume: "bonjour" })).toContain("paragraphe");
  });

  it("texte seul : paragraphe ; nombre seul : chiffre", () => {
    expect(fallbackLayout("bonjour").blocs[0]).toMatchObject({ composant: "paragraphe", props: { valeur: "$" } });
    expect(fallbackLayout(42).blocs[0]).toMatchObject({ composant: "chiffre", props: { valeur: "$" } });
  });

  it("each fallback passes validerPlan", () => {
    const cas: unknown[] = [
      announcements, tickets, ["a", "b"], "texte", 7, { total: 3, tickets }, { projet: { nom: "W" }, annonces: announcements, tags: ["x"], texte: "t", n: 0, ok: true },
      { "clé-bizarre": 1, tickets }, [1, 2, 3], JSON.parse('{"__proto__": {"a": 1}, "n": 2}'),
    ];
    for (const r of cas) {
      const v = valid(r);
      expect(v.ok, JSON.stringify(r).slice(0, 60)).toBe(true);
      if (v.ok) expect(v.ecartes).toEqual([]);
    }
  });
});

describe("fallback: never an empty page when there are results", () => {
  const cas: [string, unknown][] = [
    ["clé non écrivable", { "clé-x": 1 }],
    ["liste sous une clé non écrivable", { "a-b": [{ "x-y": 1 }] }],
    ["objets de liste sans champ simple écrivable", [{ "x-y": 1 }, { "z-w": "t" }]],
    ["imbrication profonde", { a: { b: { c: 1 } } }],
    ["liste de listes", [[1, 2], [3]]],
  ];
  for (const [name, r] of cas) {
    it(`${name}: valid and visible`, () => {
      const plan = fallbackLayout(r);
      expect(plan.blocs.some((b) => b.composant !== "titre")).toBe(true);
      expect(validatePlan(plan, { catalogue: BUILTIN_COMPONENTS, resultats: r }).ok).toBe(true);
      const page = resolvePage(plan, r, { compte: false, catalogue: BUILTIN_COMPONENTS, secours: true });
      const visible = page.blocs.some((b) => {
        const p = (b as { props?: Record<string, unknown> }).props ?? {};
        if (b.composant === "paragraphe") return typeof p.texte === "string" && p.texte.length > 0;
        if (b.composant === "champs") return Array.isArray(p.champs) && p.champs.length > 0;
        return b.composant !== "titre" && b.composant !== "erreur";
      });
      expect(visible).toBe(true);
    });
  }

  it("a last-resort paragraph bounds the text", () => {
    const r = { a: { b: "x".repeat(10_000) } };
    const page = resolvePage(fallbackLayout(r), r, { compte: false, catalogue: BUILTIN_COMPONENTS, secours: true });
    const t = (page.blocs[0] as unknown as { props: { texte: string } }).props.texte;
    expect(t.length).toBeLessThanOrEqual(2000);
  });
});
