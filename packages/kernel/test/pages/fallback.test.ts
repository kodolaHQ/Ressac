import { describe, expect, it } from "vitest";
import { resolvePage } from "../../src/pages/resolve.js";
import { BUILTIN_COMPONENTS } from "../../src/pages/catalog.js";
import { fallbackLayout, humanize } from "../../src/pages/fallback.js";
import { validatePlan } from "../../src/pages/validate.js";

const tickets = [
  { title: "Panne", priority: "haute", url: "https://gitlab.com/t/1", author: { name: "Ana" } },
  { title: "Doc", priority: "basse", url: "https://gitlab.com/t/2", author: { name: "Bob" } },
];
const announcements = [
  { titre: "Vélo", prix: 120, photo: "https://img.example/1.jpg", lien: "https://lbc.fr/1" },
  { titre: "Table", prix: 40, photo: "https://img.example/2.jpg", lien: "https://lbc.fr/2" },
];
const valid = (r: unknown) => validatePlan(fallbackLayout(r), { catalog: BUILTIN_COMPONENTS, results: r });
const components = (r: unknown) => fallbackLayout(r).blocks.map((b) => b.component);

describe("fallbackLayout", () => {
  it("list of listings with https…jpg photo: cards", () => {
    const plan = fallbackLayout(announcements);
    expect(plan.blocks).toHaveLength(1);
    expect(plan.blocks[0]).toMatchObject({ component: "cards", props: { items: "$", title: "titre", image: "photo", link: "lien" } });
  });

  it("an image recognized by its address, without a field named image", () => {
    const r = [{ nom: "A", visuel: "https://x.fr/a.png", a: 1 }];
    expect(fallbackLayout(r).blocks[0]).toMatchObject({ component: "cards", props: { image: "visuel" } });
  });

  it("liste de tickets : tableau, lien = url", () => {
    const plan = fallbackLayout(tickets);
    expect(plan.blocks[0]).toMatchObject({ component: "table", props: { items: "$", link: "url" } });
    expect((plan.blocks[0]!.props.columns as unknown[]).length).toBe(3);
  });

  it("the table keeps the first 6 simple fields", () => {
    const r = [{ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: { x: 1 } }];
    expect((fallbackLayout(r).blocks[0]!.props.columns as unknown[]).length).toBe(6);
  });

  it("list of texts: labels", () => {
    expect(components(["a", "b"])).toEqual(["tags"]);
  });

  it("objet { total: 3, tickets: [...] } : titre, champs, section, tableau", () => {
    expect(components({ total: 3, tickets })).toEqual(["title", "fields", "title", "table"]);
  });

  it("objet de champs simples : champs ; texte : paragraphe", () => {
    expect(components({ project: { name: "W", url: "https://x.fr" } })).toContain("fields");
    expect(fallbackLayout({ resume: "bonjour" }).blocks[1]).toMatchObject({ component: "fields", props: { object: "$", fields: [{ field: "resume", label: "Resume" }] } });
    expect(components({ resume: "b".repeat(200) })).toEqual(["title", "title", "paragraph"]);
  });

  it("texte seul : paragraphe ; nombre seul : chiffre", () => {
    expect(fallbackLayout("bonjour").blocks[0]).toMatchObject({ component: "paragraph", props: { value: "$" } });
    expect(fallbackLayout(42).blocks[0]).toMatchObject({ component: "figure", props: { value: "$" } });
  });

  it("humanize: camelCase and snake_case split, first letter capitalized, acronyms kept", () => {
    expect(["viewCount", "nb_vues", "verdict", "URL", "pageURL", "top10Items", "_"].map(humanize)).toEqual(["View count", "Nb vues", "Verdict", "URL", "Page URL", "Top10 items", "_"]);
  });

  it("an action result (video summary): link, one labelled fields block, sections with humanized titles, bullets", () => {
    const r = {
      title: "I discovered a sound",
      url: "https://www.youtube.com/watch?v=abc",
      channel: "colsto",
      duration: "29 min 12",
      views: 4410673,
      score: "9/10",
      recommendation: "À regarder",
      summary: "Une longue phrase ".repeat(12),
      verdict: [{ text: "Excellent" }, { text: "Un peu long" }],
      points: [{ text: "Un" }, { text: "Deux" }],
    };
    expect(fallbackLayout(r).blocks).toEqual([
      { component: "title", props: { text: "Résultats" } },
      { component: "link", props: { object: "$", url: "url", textField: "title" } },
      {
        component: "fields",
        props: {
          object: "$",
          fields: [
            { field: "channel", label: "Channel" },
            { field: "duration", label: "Duration" },
            { field: "views", label: "Views" },
            { field: "score", label: "Score" },
            { field: "recommendation", label: "Recommendation" },
          ],
        },
      },
      { component: "title", props: { text: "Summary" } },
      { component: "paragraph", props: { value: "summary" } },
      { component: "title", props: { text: "Verdict" } },
      { component: "list", props: { items: "verdict", title: "text" } },
      { component: "title", props: { text: "Points" } },
      { component: "list", props: { items: "points", title: "text" } },
    ]);
    const v = valid(r);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.discarded).toEqual([]);
    const page = resolvePage(fallbackLayout(r), r, { account: false, catalog: BUILTIN_COMPONENTS, fallback: true });
    expect(page.blocks[1]).toMatchObject({ props: { link: { text: "I discovered a sound", url: r.url } } });
    const fields = (page.blocks[2] as unknown as { props: { fields: { label: string; value: string }[] } }).props.fields;
    expect(fields.slice(0, 3)).toEqual([{ label: "Channel", value: "colsto" }, { label: "Duration", value: "29 min 12" }, { label: "Views", value: new Intl.NumberFormat("fr-FR").format(4410673) }]);
  });

  it("a url without a title: a link showing the address; more than 12 short fields: several fields blocks", () => {
    expect(fallbackLayout({ source: "http://x.fr/a" }).blocks[1]).toEqual({ component: "link", props: { object: "$", url: "source" } });
    const many = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`f${i}`, i]));
    expect(components(many)).toEqual(["title", "fields", "fields"]);
    expect(valid(many).ok).toBe(true);
  });

  it("a nested object gets a humanized section title", () => {
    expect(fallbackLayout({ project_info: { name: "W" } }).blocks.slice(1)).toEqual([
      { component: "title", props: { text: "Project info" } },
      { component: "fields", props: { object: "project_info" } },
    ]);
  });

  it("each fallback passes validatePlan", () => {
    const cas: unknown[] = [
      announcements, tickets, ["a", "b"], "texte", 7, { total: 3, tickets }, { project: { name: "W" }, announcements: announcements, tags: ["x"], text: "t", n: 0, ok: true },
      { "clé-bizarre": 1, tickets }, [1, 2, 3], JSON.parse('{"__proto__": {"a": 1}, "n": 2}'),
      { points: [{ text: "a" }], lien: "https://x.fr", nom: "X", long: "y".repeat(300), multi: "a\nb", nan: Number.NaN, vide: "" },
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i % 2 ? "https://x.fr/" + i : [{ t: i }]])),
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
      expect(plan.blocks.some((b) => b.component !== "title")).toBe(true);
      expect(validatePlan(plan, { catalog: BUILTIN_COMPONENTS, results: r }).ok).toBe(true);
      const page = resolvePage(plan, r, { account: false, catalog: BUILTIN_COMPONENTS, fallback: true });
      const visible = page.blocks.some((b) => {
        const p = (b as { props?: Record<string, unknown> }).props ?? {};
        if (b.component === "paragraph") return typeof p.text === "string" && p.text.length > 0;
        if (b.component === "fields") return Array.isArray(p.fields) && p.fields.length > 0;
        return b.component !== "title" && b.component !== "error";
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
