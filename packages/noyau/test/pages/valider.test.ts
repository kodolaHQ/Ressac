import { describe, expect, it } from "vitest";
import { COMPOSANTS_INTEGRES, type DefinitionComposant } from "../../src/pages/catalogue.js";
import { validerPlan } from "../../src/pages/valider.js";

const tickets = [
  { id: 1, titre: "Panne", priorite: "haute", url: "https://gitlab.com/t/1", auteur: { nom: "Ana" } },
  { id: 2, titre: "Doc", priorite: "basse", url: "https://gitlab.com/t/2", auteur: { nom: "Bob" } },
  { id: 3, titre: "Lent", priorite: "haute", url: "https://gitlab.com/t/3", auteur: { nom: "Cy" } },
];
const resultats = { tickets, projet: { nom: "WebAiOs", url: "https://gitlab.com/p" } };
const graphique: DefinitionComposant = {
  nom: "graphique-barres", description: "Barres", origine: "agent",
  proprietes: {
    donnees: { genre: "reference", description: "Les données", requis: true },
    etiquette: { genre: "champ", description: "Le champ", requis: false },
    titre: { genre: "texte", description: "Le titre", requis: false },
  },
};
const catalogue = [...COMPOSANTS_INTEGRES, graphique];
const valider = (brut: unknown, r: unknown = resultats) => validerPlan(brut, { catalogue, resultats: r });
const chiffre = { composant: "chiffre", props: { valeur: "compter(tickets)", libelle: "Tickets" } };

describe("validerPlan", () => {
  it("the GitLab plan (figure compter(tickets), table trier(tickets, priorite), callout garder(filtrer(…), 3)) is valid", () => {
    const plan = {
      blocs: [
        { composant: "titre", props: { texte: "Mes tickets" } },
        chiffre,
        {
          composant: "tableau",
          props: { elements: "trier(tickets, priorite)", colonnes: [{ champ: "titre", libelle: "Titre" }, { champ: "auteur.nom", libelle: "Auteur" }], lien: "url" },
        },
        { composant: "encadre", props: { niveau: "attention", titre: "Urgent", elements: 'garder(filtrer(tickets, priorite = "haute"), 3)', champ: "titre" } },
      ],
    };
    const r = valider(plan);
    expect(r).toEqual({ ok: true, plan, ecartes: [] });
  });

  it("table with a « inexistant » column: dropped with its reason", () => {
    const r = valider({
      blocs: [chiffre, { composant: "tableau", props: { elements: "tickets", colonnes: [{ champ: "titre", libelle: "Titre" }, { champ: "inexistant", libelle: "?" }] } }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.blocs).toEqual([chiffre]);
    expect(r.ecartes).toEqual(["2. tableau : colonnes : champ « inexistant » absent de tous les éléments"]);
  });

  it("plan of titles only: ok false « le plan ne référence rien »", () => {
    const r = valider({ blocs: [{ composant: "titre", props: { texte: "A" } }, { composant: "paragraphe", props: { texte: "B" } }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erreurs).toContain("le plan ne référence rien");
  });

  it("JSON that is not an object: ok false", () => {
    for (const brut of [null, 3, "plan", [], { blocs: "x" }, { blocs: [] }, undefined]) {
      const r = valider(brut);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.erreurs.length).toBeGreaterThan(0);
    }
  });

  it("unknown component « graphique-barres »: kept", () => {
    const inconnu = { composant: "graphique-barres", props: { donnees: "tickets" } };
    const r = validerPlan({ blocs: [chiffre, inconnu] }, { catalogue: COMPOSANTS_INTEGRES, resultats });
    expect(r).toEqual({ ok: true, plan: { blocs: [chiffre, inconnu] }, ecartes: [] });
  });

  it("agent component: reference, field and text validated", () => {
    const bloc = { composant: "graphique-barres", props: { donnees: "tickets", etiquette: "titre", titre: "Par ticket" } };
    expect(valider({ blocs: [bloc] })).toEqual({ ok: true, plan: { blocs: [bloc] }, ecartes: [] });
    const r = valider({ blocs: [chiffre, { composant: "graphique-barres", props: { donnees: "absents" } }] });
    expect(r.ok && r.ecartes).toEqual(["2. graphique-barres : donnees : chemin absent : absents"]);
  });

  it("a reason never writes a value from the results (trapped value « SECRET-123 » absent from the errors)", () => {
    const piege = { tickets: [{ titre: "SECRET-123", n: "SECRET-123" }], code: "SECRET-123", objet: { a: "SECRET-123" } };
    const plans = [
      { blocs: [{ composant: "chiffre", props: { valeur: "compter(code)", libelle: "x" } }] },
      { blocs: [{ composant: "chiffre", props: { valeur: "objet", libelle: "x" } }] },
      { blocs: [{ composant: "liste", props: { elements: "code", titre: "titre" } }] },
      { blocs: [{ composant: "liste", props: { elements: "tickets", titre: "absent" } }] },
      { blocs: [{ composant: "lien", props: { objet: "tickets", url: "titre" } }] },
      { blocs: [{ composant: "champs", props: { objet: "code" } }] },
      { blocs: [{ composant: "paragraphe", props: { valeur: "objet" } }] },
      { blocs: [{ composant: "chiffre", props: { valeur: "tickets.0.titre.x", libelle: "x" } }] },
      { blocs: [{ composant: "etiquettes", props: { valeurs: "code" } }] },
    ];
    for (const plan of plans) {
      const r = valider(plan, piege);
      const textes = r.ok ? r.ecartes : r.erreurs;
      expect(textes.length).toBeGreaterThan(0);
      expect(textes.join("\n")).not.toContain("SECRET");
    }
  });

  it("unknown property removed, required property missing: dropped", () => {
    const r = valider({
      blocs: [
        { composant: "chiffre", props: { valeur: "compter(tickets)", libelle: "T", couleur: "rouge", onclick: "x" } },
        { composant: "chiffre", props: { valeur: "compter(tickets)" } },
      ],
    });
    expect(r).toEqual({ ok: true, plan: { blocs: [{ composant: "chiffre", props: { valeur: "compter(tickets)", libelle: "T" } }] }, ecartes: ["2. chiffre : libelle : requise"] });
  });

  it("text too long, unknown choice, wrong kind: dropped", () => {
    const r = valider({
      blocs: [
        chiffre,
        { composant: "titre", props: { texte: "x".repeat(81) } },
        { composant: "encadre", props: { niveau: "rouge", texte: "x" } },
        { composant: "groupe", props: { titre: "G", replie: "oui" }, blocs: [] },
        { composant: "chiffre", props: { valeur: 3, libelle: "x" } },
      ],
    });
    expect(r.ok && r.ecartes).toEqual([
      "2. titre : texte : trop long (plus de 80 caractères)",
      "3. encadre : niveau : info, avis ou attention attendu",
      "4. groupe : replie : vrai ou faux attendu",
      "5. chiffre : valeur : référence attendue (un texte)",
    ]);
  });

  it("one or the other: paragraph text OR value, labels values OR elements + field, champTexte wins", () => {
    const r = valider({
      blocs: [
        { composant: "paragraphe", props: {} },
        { composant: "etiquettes", props: { elements: "tickets" } },
        { composant: "etiquettes", props: { elements: "tickets", champ: "priorite" } },
        { composant: "lien", props: { objet: "projet", url: "url", texte: "Projet", champTexte: "nom" } },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ecartes).toEqual(["1. paragraphe : texte ou valeur attendu", "2. etiquettes : valeurs, ou elements avec champ, attendu"]);
    expect(r.plan.blocs).toEqual([
      { composant: "etiquettes", props: { elements: "tickets", champ: "priorite" } },
      { composant: "lien", props: { objet: "projet", url: "url", champTexte: "nom" } },
    ]);
  });

  it("figures: list of { valeur, libelle }, 6 at most", () => {
    const un = { valeur: "compter(tickets)", libelle: "Tous" };
    const ok = valider({ blocs: [{ composant: "chiffres", props: { chiffres: [un, { valeur: 'compter(filtrer(tickets, priorite = "haute"))', libelle: "Hautes" }] } }] });
    expect(ok.ok).toBe(true);
    const r = valider({ blocs: [chiffre, { composant: "chiffres", props: { chiffres: Array(7).fill(un) } }, { composant: "chiffres", props: { chiffres: [{ valeur: "absent", libelle: "x" }] } }] });
    expect(r.ok && r.ecartes).toEqual(["2. chiffres : chiffres : 6 au plus", "3. chiffres : chiffres : chemin absent : absent"]);
  });

  it("children: group keeps its blocks, left and right columns, blocks are numbered in order", () => {
    const plan = {
      blocs: [
        { composant: "groupe", props: { titre: "G" }, blocs: [chiffre, { composant: "titre", props: {} }] },
        { composant: "colonnes", props: {}, gauche: [chiffre], droite: [{ composant: "titre", props: { texte: "D" } }] },
        { composant: "titre", props: { texte: "T" }, blocs: [chiffre] },
      ],
    };
    const r = valider(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ecartes).toEqual(["3. titre : texte : requise"]);
    expect(r.plan.blocs).toEqual([
      { composant: "groupe", props: { titre: "G" }, blocs: [chiffre] },
      plan.blocs[1],
      { composant: "titre", props: { texte: "T" } },
    ]);
  });

  describe("plan hostile", () => {
    it("composed link or literal address instead of a field: dropped", () => {
      const r = valider({
        blocs: [
          chiffre,
          { composant: "lien", props: { objet: "projet", url: '"https://tiers.example/?d=" + nom' } },
          { composant: "lien", props: { objet: "projet", url: "https://tiers.example/" } },
          { composant: "liste", props: { elements: "tickets", titre: "titre", lien: "javascript:alert(1)" } },
          { composant: "cartes", props: { elements: "tickets", titre: "titre", image: "http://127.0.0.1/x.png" } },
        ],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.plan.blocs).toEqual([chiffre]);
      expect(r.ecartes).toHaveLength(4);
      expect(r.ecartes[0]).toMatch(/^2\. lien : url : /);
      expect(r.ecartes[3]).toMatch(/^5\. cartes : image : /);
    });

    it("field that is a reference (an operation): dropped", () => {
      const r = valider({ blocs: [chiffre, { composant: "liste", props: { elements: "tickets", titre: "compter(tickets)" } }] });
      expect(r.ok && r.ecartes).toEqual(["2. liste : titre : un nom de champ est attendu, pas une référence"]);
    });

    it("500 blocks, or nested too deep: ok false", () => {
      expect(valider({ blocs: Array(500).fill(chiffre) }).ok).toBe(false);
      const g = (b: unknown) => ({ composant: "groupe", props: { titre: "g" }, blocs: [b] });
      expect(valider({ blocs: [g(g(g(chiffre)))] }).ok).toBe(false);
    });

    it("reference of 50 operations: dropped", () => {
      let ref = "tickets";
      for (let i = 0; i < 50; i++) ref = `garder(${ref}, 3)`;
      const r = valider({ blocs: [chiffre, { composant: "liste", props: { elements: ref, titre: "titre" } }] });
      expect(r.ok && r.ecartes).toEqual(["2. liste : elements : référence trop longue (plus de 300 caractères)"]);
      let court = "tickets";
      for (let i = 0; i < 5; i++) court = `garder(${court},3)`;
      const r2 = valider({ blocs: [chiffre, { composant: "liste", props: { elements: court, titre: "titre" } }] });
      expect(r2.ok && r2.ecartes).toEqual(["2. liste : elements : plus de 4 opérations imbriquées"]);
    });

    it("JSON nested 20,000 levels deep or huge: ok false without exception", () => {
      let profond: unknown = {};
      for (let i = 0; i < 20_000; i++) profond = { blocs: [{ composant: "groupe", props: {}, blocs: [profond] }] };
      expect(valider(profond).ok).toBe(false);
      let props: unknown = 1;
      for (let i = 0; i < 20_000; i++) props = { a: props };
      expect(valider({ blocs: [{ composant: "chiffre", props: { valeur: "tickets", libelle: "x", x: props } }] }).ok).toBe(false);
      expect(valider({ blocs: [chiffre], bruit: Array.from({ length: 200_000 }, (_, i) => i) }).ok).toBe(false);
    });

    it("a value that throws on read: ok false without exception", () => {
      const piege = { get blocs() { throw new Error("boum"); } };
      expect(valider(piege).ok).toBe(false);
    });

    it("__proto__ in the props: lends no property", () => {
      const brut = JSON.parse('{"blocs":[{"composant":"chiffre","props":{"__proto__":{"libelle":"volé"},"valeur":"compter(tickets)"}}]}');
      const r = valider(brut);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.erreurs).toContain("1. chiffre : libelle : requise");
    });
  });
});
