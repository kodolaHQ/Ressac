import { describe, expect, it } from "vitest";
import { resolvePage } from "../../src/pages/resolve.js";
import { BUILTIN_COMPONENTS } from "../../src/pages/catalog.js";
import { fallbackLayout } from "../../src/pages/fallback.js";
import { validatePlan } from "../../src/pages/validate.js";

const tickets = [
  { title: "Panne", priority: "haute", url: "https://gitlab.com/t/1", author: { name: "Ana" } },
  { title: "Doc", priority: "basse", url: "https://gitlab.com/t/2", author: { name: "Bob" } },
];
const announcements = [
  { title: "Vélo", price: 120, snapshot: "https://img.example/1.jpg", link: "https://lbc.fr/1" },
  { title: "Table", price: 40, snapshot: "https://img.example/2.jpg", link: "https://lbc.fr/2" },
];
const valid = (r: unknown) => validatePlan(fallbackLayout(r), { catalog: BUILTIN_COMPONENTS, results: r });
const components = (r: unknown) => fallbackLayout(r).blocks.map((b) => b.component);

describe("fallbackLayout", () => {
  it("list of listings with https…jpg photo: cards", () => {
    const plan = fallbackLayout(announcements);
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]).toMatchObject({ component: "cartes", props: { items: "$", title: "titre", image: "photo", link: "lien" } });
  });

  it("an image recognized by its address, without a field named image", () => {
    const r = [{ name: "A", visual: "https://x.fr/a.png", a: 1 }];
    expect(fallbackLayout(r).blocks[0]).toMatchObject({ component: "cartes", props: { image: "visuel" } });
  });

  it("liste de tickets : tableau, lien = url", () => {
    const plan = fallbackLayout(tickets);
    expect(plan.blocks[0]).toMatchObject({ component: "tableau", props: { items: "$", link: "url" } });
    expect((plan.blocks[0]!.props.colonnes as unknown[]).length).toBe(3);
  });

  it("the table keeps the first 6 simple fields", () => {
    const r = [{ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: { x: 1 } }];
    expect((fallbackLayout(r).blocks[0]!.props.colonnes as unknown[]).length).toBe(6);
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
    expect(components({ project: { name: "W", url: "https://x.fr" } })).toContain("champs");
    expect(components({ resume: "bonjour" })).toContain("paragraphe");
  });

  it("texte seul : paragraphe ; nombre seul : chiffre", () => {
    expect(fallbackLayout("bonjour").blocks[0]).toMatchObject({ component: "paragraphe", props: { value: "$" } });
    expect(fallbackLayout(42).blocks[0]).toMatchObject({ component: "chiffre", props: { value: "$" } });
  });

  it("each fallback passes validatePlan", () => {
    const cas: unknown[] = [
      announcements, tickets, ["a", "b"], "texte", 7, { total: 3, tickets }, { project: { name: "W" }, announcements: announcements, tags: ["x"], text: "t", n: 0, ok: true },
      { "clé-bizarre": 1, tickets }, [1, 2, 3], JSON.parse('{"__proto__": {"a": 1}, "n": 2}'),
    ];
    for (const r of cas) {
      const v = valid(r);
      expect(v.ok, JSON.stringify(r).slice(0, 60)).toBe(true);
      if (v.ok) expect(v.discarded).toEqual([]);
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
      expect(plan.blocks.some((b) => b.component !== "titre")).toBe(true);
      expect(validatePlan(plan, { catalog: BUILTIN_COMPONENTS, results: r }).ok).toBe(true);
      const page = resolvePage(plan, r, { account: false, catalog: BUILTIN_COMPONENTS, fallback: true });
      const visible = page.blocks.some((b) => {
        const p = (b as { props?: Record<string, unknown> }).props ?? {};
        if (b.component === "paragraphe") return typeof p.texte === "string" && p.texte.length > 0;
        if (b.component === "champs") return Array.isArray(p.champs) && p.champs.length > 0;
        return b.component !== "titre" && b.component !== "erreur";
      });
      expect(visible).toBe(true);
    });
  }

  it("a last-resort paragraph bounds the text", () => {
    const r = { a: { b: "x".repeat(10_000) } };
    const page = resolvePage(fallbackLayout(r), r, { account: false, catalog: BUILTIN_COMPONENTS, fallback: true });
    const t = (page.blocks[0] as unknown as { props: { text: string } }).props.text;
    expect(t.length).toBeLessThanOrEqual(2000);
  });
});
