import { describe, expect, it } from "vitest";
import { BUILTIN_COMPONENTS, type ComponentDefinition } from "../../src/pages/catalog.js";
import { validatePlan } from "../../src/pages/validate.js";

const tickets = [
  { id: 1, title: "Panne", priority: "haute", url: "https://gitlab.com/t/1", author: { name: "Ana" } },
  { id: 2, title: "Doc", priority: "basse", url: "https://gitlab.com/t/2", author: { name: "Bob" } },
  { id: 3, title: "Lent", priority: "haute", url: "https://gitlab.com/t/3", author: { name: "Cy" } },
];
const results = { tickets, project: { name: "Ressac", url: "https://gitlab.com/p" } };
const graph: ComponentDefinition = {
  name: "graphique-barres", description: "Barres", origin: "agent",
  properties: {
    data: { kind: "reference", description: "Les données", required: true },
    label: { kind: "field", description: "Le champ", required: false },
    title: { kind: "text", description: "Le titre", required: false },
  },
};
const catalog = [...BUILTIN_COMPONENTS, graph];
const validate = (raw: unknown, r: unknown = results) => validatePlan(raw, { catalog: catalog, results: r });
const figure = { component: "figure", props: { value: "count(tickets)", label: "Tickets" } };

describe("validatePlan", () => {
  it("the GitLab plan (figure count(tickets), table sort(tickets, priority), callout keep(filter(…), 3)) is valid", () => {
    const plan = {
      blocks: [
        { component: "title", props: { text: "Mes tickets" } },
        figure,
        {
          component: "table",
          props: { items: "sort(tickets, priority)", columns: [{ field: "title", label: "Titre" }, { field: "author.name", label: "Auteur" }], link: "url" },
        },
        { component: "callout", props: { level: "warning", title: "Urgent", items: 'keep(filter(tickets, priority = "haute"), 3)', field: "title" } },
      ],
    };
    const r = validate(plan);
    expect(r).toEqual({ ok: true, plan, discarded: [] });
  });

  it("table with a « inexistant » column: dropped with its reason", () => {
    const r = validate({
      blocks: [figure, { component: "table", props: { items: "tickets", columns: [{ field: "title", label: "Titre" }, { field: "inexistant", label: "?" }] } }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.blocks).toEqual([figure]);
    expect(r.discarded).toEqual(["2. table : columns : champ « inexistant » absent de tous les éléments"]);
  });

  it("plan of titles only: ok false « le plan ne référence rien »", () => {
    const r = validate({ blocks: [{ component: "title", props: { text: "A" } }, { component: "paragraph", props: { text: "B" } }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContain("le plan ne référence rien");
  });

  it("JSON that is not an object: ok false", () => {
    for (const raw of [null, 3, "plan", [], { blocks: "x" }, { blocks: [] }, undefined]) {
      const r = validate(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it("unknown component « graphique-barres »: kept", () => {
    const unknown = { component: "graphique-barres", props: { data: "tickets" } };
    const r = validatePlan({ blocks: [figure, unknown] }, { catalog: BUILTIN_COMPONENTS, results: results });
    expect(r).toEqual({ ok: true, plan: { blocks: [figure, unknown] }, discarded: [] });
  });

  it("agent component: reference, field and text validated", () => {
    const block = { component: "graphique-barres", props: { data: "tickets", label: "title", title: "Par ticket" } };
    expect(validate({ blocks: [block] })).toEqual({ ok: true, plan: { blocks: [block] }, discarded: [] });
    const r = validate({ blocks: [figure, { component: "graphique-barres", props: { data: "absents" } }] });
    expect(r.ok && r.discarded).toEqual(["2. graphique-barres : data : chemin absent : absents"]);
  });

  it("a reason never writes a value from the results (trapped value « SECRET-123 » absent from the errors)", () => {
    const trap = { tickets: [{ title: "SECRET-123", n: "SECRET-123" }], code: "SECRET-123", object: { a: "SECRET-123" } };
    const plans = [
      { blocks: [{ component: "figure", props: { value: "count(code)", label: "x" } }] },
      { blocks: [{ component: "figure", props: { value: "object", label: "x" } }] },
      { blocks: [{ component: "list", props: { items: "code", title: "title" } }] },
      { blocks: [{ component: "list", props: { items: "tickets", title: "absent" } }] },
      { blocks: [{ component: "link", props: { object: "tickets", url: "title" } }] },
      { blocks: [{ component: "fields", props: { object: "code" } }] },
      { blocks: [{ component: "paragraph", props: { value: "object" } }] },
      { blocks: [{ component: "figure", props: { value: "tickets.0.title.x", label: "x" } }] },
      { blocks: [{ component: "tags", props: { values: "code" } }] },
    ];
    for (const plan of plans) {
      const r = validate(plan, trap);
      const texts = r.ok ? r.discarded : r.errors;
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.join("\n")).not.toContain("SECRET");
    }
  });

  it("unknown property removed, required property missing: dropped", () => {
    const r = validate({
      blocks: [
        { component: "figure", props: { value: "count(tickets)", label: "T", color: "rouge", onclick: "x" } },
        { component: "figure", props: { value: "count(tickets)" } },
      ],
    });
    expect(r).toEqual({ ok: true, plan: { blocks: [{ component: "figure", props: { value: "count(tickets)", label: "T" } }] }, discarded: ["2. figure : label : requise"] });
  });

  it("text too long, unknown choice, wrong kind: dropped", () => {
    const r = validate({
      blocks: [
        figure,
        { component: "title", props: { text: "x".repeat(81) } },
        { component: "callout", props: { level: "rouge", text: "x" } },
        { component: "group", props: { title: "G", collapsed: "oui" }, blocks: [] },
        { component: "figure", props: { value: 3, label: "x" } },
      ],
    });
    expect(r.ok && r.discarded).toEqual([
      "2. title : text : trop long (plus de 80 caractères)",
      "3. callout : level : info, notice ou warning attendu",
      "4. group : collapsed : vrai ou faux attendu",
      "5. figure : value : référence attendue (un texte)",
    ]);
  });

  it("one or the other: paragraph text OR value, labels values OR elements + field, champTexte wins", () => {
    const r = validate({
      blocks: [
        { component: "paragraph", props: {} },
        { component: "tags", props: { items: "tickets" } },
        { component: "tags", props: { items: "tickets", field: "priority" } },
        { component: "link", props: { object: "project", url: "url", text: "Projet", textField: "name" } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.discarded).toEqual(["1. paragraph : text ou value attendu", "2. tags : values, ou items avec field, attendu"]);
    expect(r.plan.blocks).toEqual([
      { component: "tags", props: { items: "tickets", field: "priority" } },
      { component: "link", props: { object: "project", url: "url", textField: "name" } },
    ]);
  });

  it("figures: list of { value, label }, 6 at most", () => {
    const one = { value: "count(tickets)", label: "Tous" };
    const ok = validate({ blocks: [{ component: "figures", props: { figures: [one, { value: 'count(filter(tickets, priority = "haute"))', label: "Hautes" }] } }] });
    expect(ok.ok).toBe(true);
    const r = validate({ blocks: [figure, { component: "figures", props: { figures: Array(7).fill(one) } }, { component: "figures", props: { figures: [{ value: "absent", label: "x" }] } }] });
    expect(r.ok && r.discarded).toEqual(["2. figures : figures : 6 au plus", "3. figures : figures : chemin absent : absent"]);
  });

  it("children: group keeps its blocks, left and right columns, blocks are numbered in order", () => {
    const plan = {
      blocks: [
        { component: "group", props: { title: "G" }, blocks: [figure, { component: "title", props: {} }] },
        { component: "columns", props: {}, left: [figure], right: [{ component: "title", props: { text: "D" } }] },
        { component: "title", props: { text: "T" }, blocks: [figure] },
      ],
    };
    const r = validate(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.discarded).toEqual(["3. title : text : requise"]);
    expect(r.plan.blocks).toEqual([
      { component: "group", props: { title: "G" }, blocks: [figure] },
      plan.blocks[1],
      { component: "title", props: { text: "T" } },
    ]);
  });

  describe("plan hostile", () => {
    it("composed link or literal address instead of a field: dropped", () => {
      const r = validate({
        blocks: [
          figure,
          { component: "link", props: { object: "project", url: '"https://tiers.example/?d=" + name' } },
          { component: "link", props: { object: "project", url: "https://tiers.example/" } },
          { component: "list", props: { items: "tickets", title: "title", link: "javascript:alert(1)" } },
          { component: "cards", props: { items: "tickets", title: "title", image: "http://127.0.0.1/x.png" } },
        ],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.plan.blocks).toEqual([figure]);
      expect(r.discarded).toHaveLength(4);
      expect(r.discarded[0]).toMatch(/^2\. link : url : /);
      expect(r.discarded[3]).toMatch(/^5\. cards : image : /);
    });

    it("field that is a reference (an operation): dropped", () => {
      const r = validate({ blocks: [figure, { component: "list", props: { items: "tickets", title: "count(tickets)" } }] });
      expect(r.ok && r.discarded).toEqual(["2. list : title : un nom de champ est attendu, pas une référence"]);
    });

    it("500 blocks, or nested too deep: ok false", () => {
      expect(validate({ blocks: Array(500).fill(figure) }).ok).toBe(false);
      const g = (b: unknown) => ({ component: "group", props: { title: "g" }, blocks: [b] });
      expect(validate({ blocks: [g(g(g(figure)))] }).ok).toBe(false);
    });

    it("reference of 50 operations: dropped", () => {
      let ref = "tickets";
      for (let i = 0; i < 50; i++) ref = `keep(${ref}, 3)`;
      const r = validate({ blocks: [figure, { component: "list", props: { items: ref, title: "title" } }] });
      expect(r.ok && r.discarded).toEqual(["2. list : items : référence trop longue (plus de 300 caractères)"]);
      let short = "tickets";
      for (let i = 0; i < 5; i++) short = `keep(${short},3)`;
      const r2 = validate({ blocks: [figure, { component: "list", props: { items: short, title: "title" } }] });
      expect(r2.ok && r2.discarded).toEqual(["2. list : items : plus de 4 opérations imbriquées"]);
    });

    it("JSON nested 20,000 levels deep or huge: ok false without exception", () => {
      let deep: unknown = {};
      for (let i = 0; i < 20_000; i++) deep = { blocks: [{ component: "group", props: {}, blocks: [deep] }] };
      expect(validate(deep).ok).toBe(false);
      let props: unknown = 1;
      for (let i = 0; i < 20_000; i++) props = { a: props };
      expect(validate({ blocks: [{ component: "figure", props: { value: "tickets", label: "x", x: props } }] }).ok).toBe(false);
      expect(validate({ blocks: [figure], noise: Array.from({ length: 200_000 }, (_, i) => i) }).ok).toBe(false);
    });

    it("a value that throws on read: ok false without exception", () => {
      const trap = { get blocks() { throw new Error("boum"); } };
      expect(validate(trap).ok).toBe(false);
    });

    it("__proto__ in the props: lends no property", () => {
      const raw = JSON.parse('{"blocks":[{"component":"figure","props":{"__proto__":{"label":"volé"},"value":"count(tickets)"}}]}');
      const r = validate(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("1. figure : label : requise");
    });
  });

  describe("highlight", () => {
    const found = { best: { name: "Yuba", price: "1 850 €" }, items: [{ name: "Babboe" }] };
    const hl = { component: "highlight", props: { object: "best", label: "Le meilleur", title: "name", value: "price" } };
    it("a second highlight is discarded", () => {
      const r = validate({ blocks: [hl, hl] }, found);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.plan.blocks).toHaveLength(1);
        expect(r.discarded).toHaveLength(1);
      }
    });
    it("highlight needs an object", () => {
      const r = validate({ blocks: [figure, { component: "highlight", props: { ...hl.props, object: "items" } }] }, { ...found, tickets });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.plan.blocks.map((b) => b.component)).toEqual(["figure"]);
    });
  });
});
