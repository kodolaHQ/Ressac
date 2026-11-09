import { describe, expect, it } from "vitest";
import { BUILTIN_COMPONENTS, type ComponentDefinition } from "../../src/pages/catalog.js";
import { validatePlan } from "../../src/pages/validate.js";

const tickets = [
  { id: 1, title: "Panne", priority: "haute", url: "https://gitlab.com/t/1", author: { name: "Ana" } },
  { id: 2, title: "Doc", priority: "basse", url: "https://gitlab.com/t/2", author: { name: "Bob" } },
  { id: 3, title: "Lent", priority: "haute", url: "https://gitlab.com/t/3", author: { name: "Cy" } },
];
const results = { tickets, project: { name: "WebAiOs", url: "https://gitlab.com/p" } };
const graph: ComponentDefinition = {
  name: "graphique-barres", description: "Barres", origin: "agent",
  properties: {
    data: { kind: "reference", description: "Les données", required: true },
    label: { kind: "champ", description: "Le champ", required: false },
    title: { kind: "texte", description: "Le titre", required: false },
  },
};
const catalog = [...BUILTIN_COMPONENTS, graph];
const validate = (raw: unknown, r: unknown = results) => validatePlan(raw, { catalog: catalog, results: r });
const figure = { component: "chiffre", props: { value: "compter(tickets)", label: "Tickets" } };

describe("validatePlan", () => {
  it("the GitLab plan (figure compter(tickets), table trier(tickets, priorite), callout garder(filtrer(…), 3)) is valid", () => {
    const plan = {
      blocks: [
        { component: "titre", props: { text: "Mes tickets" } },
        figure,
        {
          component: "tableau",
          props: { items: "trier(tickets, priorite)", columns: [{ field: "titre", label: "Titre" }, { field: "auteur.nom", label: "Auteur" }], link: "url" },
        },
        { component: "encadre", props: { level: "attention", title: "Urgent", items: 'garder(filtrer(tickets, priorite = "haute"), 3)', field: "titre" } },
      ],
    };
    const r = validate(plan);
    expect(r).toEqual({ ok: true, plan, discarded: [] });
  });

  it("table with a « inexistant » column: dropped with its reason", () => {
    const r = validate({
      blocks: [figure, { component: "tableau", props: { items: "tickets", columns: [{ field: "titre", label: "Titre" }, { field: "inexistant", label: "?" }] } }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.blocks).toEqual([figure]);
    expect(r.discarded).toEqual(["2. tableau : colonnes : champ « inexistant » absent de tous les éléments"]);
  });

  it("plan of titles only: ok false « le plan ne référence rien »", () => {
    const r = validate({ blocks: [{ component: "titre", props: { text: "A" } }, { component: "paragraphe", props: { text: "B" } }] });
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
    const block = { component: "graphique-barres", props: { data: "tickets", label: "titre", title: "Par ticket" } };
    expect(validate({ blocks: [block] })).toEqual({ ok: true, plan: { blocks: [block] }, discarded: [] });
    const r = validate({ blocks: [figure, { component: "graphique-barres", props: { data: "absents" } }] });
    expect(r.ok && r.discarded).toEqual(["2. graphique-barres : donnees : chemin absent : absents"]);
  });

  it("a reason never writes a value from the results (trapped value « SECRET-123 » absent from the errors)", () => {
    const trap = { tickets: [{ title: "SECRET-123", n: "SECRET-123" }], code: "SECRET-123", object: { a: "SECRET-123" } };
    const plans = [
      { blocks: [{ component: "chiffre", props: { value: "compter(code)", label: "x" } }] },
      { blocks: [{ component: "chiffre", props: { value: "objet", label: "x" } }] },
      { blocks: [{ component: "liste", props: { items: "code", title: "titre" } }] },
      { blocks: [{ component: "liste", props: { items: "tickets", title: "absent" } }] },
      { blocks: [{ component: "lien", props: { object: "tickets", url: "titre" } }] },
      { blocks: [{ component: "champs", props: { object: "code" } }] },
      { blocks: [{ component: "paragraphe", props: { value: "objet" } }] },
      { blocks: [{ component: "chiffre", props: { value: "tickets.0.titre.x", label: "x" } }] },
      { blocks: [{ component: "etiquettes", props: { values: "code" } }] },
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
        { component: "chiffre", props: { value: "compter(tickets)", label: "T", color: "rouge", onclick: "x" } },
        { component: "chiffre", props: { value: "compter(tickets)" } },
      ],
    });
    expect(r).toEqual({ ok: true, plan: { blocks: [{ component: "chiffre", props: { value: "compter(tickets)", label: "T" } }] }, discarded: ["2. chiffre : libelle : requise"] });
  });

  it("text too long, unknown choice, wrong kind: dropped", () => {
    const r = validate({
      blocks: [
        figure,
        { component: "titre", props: { text: "x".repeat(81) } },
        { component: "encadre", props: { level: "rouge", text: "x" } },
        { component: "groupe", props: { title: "G", collapsed: "oui" }, blocks: [] },
        { component: "chiffre", props: { value: 3, label: "x" } },
      ],
    });
    expect(r.ok && r.discarded).toEqual([
      "2. titre : texte : trop long (plus de 80 caractères)",
      "3. encadre : niveau : info, avis ou attention attendu",
      "4. groupe : replie : vrai ou faux attendu",
      "5. chiffre : valeur : référence attendue (un texte)",
    ]);
  });

  it("one or the other: paragraph text OR value, labels values OR elements + field, champTexte wins", () => {
    const r = validate({
      blocks: [
        { component: "paragraphe", props: {} },
        { component: "etiquettes", props: { items: "tickets" } },
        { component: "etiquettes", props: { items: "tickets", field: "priorite" } },
        { component: "lien", props: { object: "projet", url: "url", text: "Projet", textField: "nom" } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.discarded).toEqual(["1. paragraphe : texte ou valeur attendu", "2. etiquettes : valeurs, ou elements avec champ, attendu"]);
    expect(r.plan.blocks).toEqual([
      { component: "etiquettes", props: { items: "tickets", field: "priorite" } },
      { component: "lien", props: { object: "projet", url: "url", textField: "nom" } },
    ]);
  });

  it("figures: list of { valeur, libelle }, 6 at most", () => {
    const one = { value: "compter(tickets)", label: "Tous" };
    const ok = validate({ blocks: [{ component: "chiffres", props: { figures: [one, { value: 'compter(filtrer(tickets, priorite = "haute"))', label: "Hautes" }] } }] });
    expect(ok.ok).toBe(true);
    const r = validate({ blocks: [figure, { component: "chiffres", props: { figures: Array(7).fill(one) } }, { component: "chiffres", props: { figures: [{ value: "absent", label: "x" }] } }] });
    expect(r.ok && r.discarded).toEqual(["2. chiffres : chiffres : 6 au plus", "3. chiffres : chiffres : chemin absent : absent"]);
  });

  it("children: group keeps its blocks, left and right columns, blocks are numbered in order", () => {
    const plan = {
      blocks: [
        { component: "groupe", props: { title: "G" }, blocks: [figure, { component: "titre", props: {} }] },
        { component: "colonnes", props: {}, left: [figure], right: [{ component: "titre", props: { text: "D" } }] },
        { component: "titre", props: { text: "T" }, blocks: [figure] },
      ],
    };
    const r = validate(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.discarded).toEqual(["3. titre : texte : requise"]);
    expect(r.plan.blocks).toEqual([
      { component: "groupe", props: { title: "G" }, blocks: [figure] },
      plan.blocks[1],
      { component: "titre", props: { text: "T" } },
    ]);
  });

  describe("plan hostile", () => {
    it("composed link or literal address instead of a field: dropped", () => {
      const r = validate({
        blocks: [
          figure,
          { component: "lien", props: { object: "projet", url: '"https://tiers.example/?d=" + nom' } },
          { component: "lien", props: { object: "projet", url: "https://tiers.example/" } },
          { component: "liste", props: { items: "tickets", title: "titre", link: "javascript:alert(1)" } },
          { component: "cartes", props: { items: "tickets", title: "titre", image: "http://127.0.0.1/x.png" } },
        ],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.plan.blocks).toEqual([figure]);
      expect(r.discarded).toHaveLength(4);
      expect(r.discarded[0]).toMatch(/^2\. lien : url : /);
      expect(r.discarded[3]).toMatch(/^5\. cartes : image : /);
    });

    it("field that is a reference (an operation): dropped", () => {
      const r = validate({ blocks: [figure, { component: "liste", props: { items: "tickets", title: "compter(tickets)" } }] });
      expect(r.ok && r.discarded).toEqual(["2. liste : titre : un nom de champ est attendu, pas une référence"]);
    });

    it("500 blocks, or nested too deep: ok false", () => {
      expect(validate({ blocks: Array(500).fill(figure) }).ok).toBe(false);
      const g = (b: unknown) => ({ component: "groupe", props: { title: "g" }, blocks: [b] });
      expect(validate({ blocks: [g(g(g(figure)))] }).ok).toBe(false);
    });

    it("reference of 50 operations: dropped", () => {
      let ref = "tickets";
      for (let i = 0; i < 50; i++) ref = `garder(${ref}, 3)`;
      const r = validate({ blocks: [figure, { component: "liste", props: { items: ref, title: "titre" } }] });
      expect(r.ok && r.discarded).toEqual(["2. liste : elements : référence trop longue (plus de 300 caractères)"]);
      let short = "tickets";
      for (let i = 0; i < 5; i++) short = `garder(${short},3)`;
      const r2 = validate({ blocks: [figure, { component: "liste", props: { items: short, title: "titre" } }] });
      expect(r2.ok && r2.discarded).toEqual(["2. liste : elements : plus de 4 opérations imbriquées"]);
    });

    it("JSON nested 20,000 levels deep or huge: ok false without exception", () => {
      let deep: unknown = {};
      for (let i = 0; i < 20_000; i++) deep = { blocks: [{ component: "groupe", props: {}, blocks: [deep] }] };
      expect(validate(deep).ok).toBe(false);
      let props: unknown = 1;
      for (let i = 0; i < 20_000; i++) props = { a: props };
      expect(validate({ blocks: [{ component: "chiffre", props: { value: "tickets", label: "x", x: props } }] }).ok).toBe(false);
      expect(validate({ blocks: [figure], noise: Array.from({ length: 200_000 }, (_, i) => i) }).ok).toBe(false);
    });

    it("a value that throws on read: ok false without exception", () => {
      const trap = { get blocks() { throw new Error("boum"); } };
      expect(validate(trap).ok).toBe(false);
    });

    it("__proto__ in the props: lends no property", () => {
      const raw = JSON.parse('{"blocs":[{"composant":"chiffre","props":{"__proto__":{"libelle":"volé"},"valeur":"compter(tickets)"}}]}');
      const r = validate(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("1. chiffre : libelle : requise");
    });
  });
});
