import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LIGNE_MAX_OCTETS, debutTropGros, ligneDebut, octetsLigneDebut, planRejeu, validerWorkflow, type Execution, type TraceBloc, type WorkflowValide } from "../../src/index.js";

const brut = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "modeles", "widgets", "actus-tech", "workflow.json"), "utf8"));
const r = validerWorkflow(brut);
if (!r.ok) throw new Error(r.erreur);
const valide: WorkflowValide = r.valide;

const trace = (id: string, extra: Partial<TraceBloc> = {}): TraceBloc => ({
  id, type: "code", statut: "reussi", debut: null, fin: null, elements: 3, journal: [], sortie: { de: id }, ...extra,
});
const origine = (modifs: Record<string, Partial<TraceBloc>> = {}, sans: string[] = []): Execution => ({
  version: 1, id: "2026-10-29T08-00-00-000Z", proprietaire: { type: "widget", id: "w" }, declencheur: "manuelle",
  debut: "2026-10-29T08:00:00.000Z", fin: null, statut: "reussie",
  blocs: valide.ordre.filter((id) => !sans.includes(id)).map((id) => trace(id, modifs[id])),
});
const erreur = (p: ReturnType<typeof planRejeu>) => (p.ok ? "accepté à tort" : p.erreur);

test("rejouer depuis resumes relance resumes, articles, sortie et reprend pages et top", () => {
  const p = planRejeu(valide, origine({ pages: { elements: 8 }, top: { elements: 15 } }), "resumes");
  if (!p.ok) throw new Error(p.erreur);
  expect(p.relances).toEqual(["resumes", "articles", "sortie"]);
  expect(Object.keys(p.sorties).sort()).toEqual(["pages", "top"]);
  expect(p.sorties.top).toEqual({ de: "top" });
  expect(p.repris).toEqual({ pages: 8, top: 15 });
});

test("rejouer depuis un bloc sans prédécesseur relance tout son aval, sans rien reprendre", () => {
  const p = planRejeu(valide, origine(), "flux");
  if (!p.ok) throw new Error(p.erreur);
  expect(p.relances).toEqual(valide.ordre);
  expect(p.sorties).toEqual({});
  expect(p.repris).toEqual({});
});

test("refus : origine introuvable", () => {
  expect(erreur(planRejeu(valide, null, "resumes"))).toBe("Rejeu impossible : exécution introuvable");
});

test("refus : bloc absent du workflow", () => {
  expect(erreur(planRejeu(valide, origine(), "fantome"))).toBe("Rejeu impossible : le bloc « fantome » n'est pas dans le workflow");
});

test("refus : sortie amont absente (bloc pas lancé)", () => {
  const p = planRejeu(valide, origine({ pages: { statut: "pas-lance", sortie: undefined } }), "resumes");
  expect(erreur(p)).toBe("Rejeu impossible : la sortie de « pages » manque dans cette exécution");
});

test("refus : sortie amont en échec", () => {
  expect(erreur(planRejeu(valide, origine({ top: { statut: "echoue" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « top » manque dans cette exécution",
  );
});

test("refus : sortie amont reprise (l'origine est elle-même un essai)", () => {
  expect(erreur(planRejeu(valide, origine({ pages: { statut: "repris" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("refus : sortie amont reprise et origine de l'essai élaguée", () => {
  const essai = { ...origine({ pages: { statut: "repris", sortie: undefined } }), id: "e1-essai", essai: { depart: "resumes", origine: "reel" } };
  expect(erreur(planRejeu(valide, essai, "resumes", []))).toBe("Rejeu impossible : la sortie de « pages » manque dans cette exécution");
});

const essaiDe = (id: string, depuis: string, modifs: Record<string, Partial<TraceBloc>>): Execution => ({
  ...origine(modifs), id, declencheur: "rejeu", essai: { depart: "resumes", origine: depuis },
});
const reprisSans = { statut: "repris", sortie: undefined } as const;

test("rejouer depuis le même bloc en partant d'un essai reprend les sorties de son origine, qu'il nomme", () => {
  const reel = { ...origine({ pages: { elements: 8, sortie: "p-reel" }, top: { elements: 15, sortie: "t-reel" } }), id: "reel" };
  const essai = essaiDe("e1-essai", "reel", { pages: { ...reprisSans, elements: 8 }, top: { ...reprisSans, elements: 15 } });
  const p = planRejeu(valide, essai, "resumes", [reel]);
  if (!p.ok) throw new Error(p.erreur);
  expect(p.relances).toEqual(["resumes", "articles", "sortie"]);
  expect(p.sorties).toEqual({ pages: "p-reel", top: "t-reel" });
  expect(p.repris).toEqual({ pages: 8, top: 15 });
  expect(p.origine).toBe("reel");
});

test("un essai d'essai remonte la chaîne jusqu'à la vraie exécution", () => {
  const reel = { ...origine({ top: { sortie: "t-reel" }, pages: { sortie: "p-reel" } }), id: "reel" };
  const e1 = essaiDe("e1-essai", "reel", { top: reprisSans, pages: reprisSans });
  const e2 = essaiDe("e2-essai", "e1-essai", { top: reprisSans, pages: reprisSans });
  const p = planRejeu(valide, e2, "resumes", [e1, reel]);
  if (!p.ok) throw new Error(p.erreur);
  expect(p.sorties).toEqual({ pages: "p-reel", top: "t-reel" });
  expect(p.origine).toBe("reel");
});

test("sorties mêlées (relancées par l'essai, reprises de son origine) : l'origine nommée est l'essai", () => {
  const reel = { ...origine({ top: { sortie: "t-reel" } }), id: "reel" };
  // L'essai est parti de « a-resumer » : top est repris, pages a tourné dans l'essai.
  const e1 = essaiDe("e1-essai", "reel", { flux: reprisSans, uniques: reprisSans, tri: reprisSans, top: reprisSans, pages: { sortie: "p-essai" } });
  const p = planRejeu(valide, e1, "resumes", [reel]);
  if (!p.ok) throw new Error(p.erreur);
  expect(p.sorties).toEqual({ pages: "p-essai", top: "t-reel" });
  expect(p.origine).toBe("e1-essai");
});

test("refus : sortie reprise de l'origine de l'essai tronquée", () => {
  const reel = { ...origine({ top: { sortieTronquee: true, sortie: "[{…" } }), id: "reel" };
  const essai = essaiDe("e1-essai", "reel", { top: reprisSans, pages: reprisSans });
  expect(erreur(planRejeu(valide, essai, "resumes", [reel]))).toBe("Rejeu impossible : la sortie de « top » a été tronquée dans cette exécution");
});

test("refus : sortie amont réussie mais sans sortie gardée", () => {
  expect(erreur(planRejeu(valide, origine({ pages: { sortie: undefined } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("refus : sortie amont tronquée", () => {
  expect(erreur(planRejeu(valide, origine({ top: { sortieTronquee: true, sortie: "[{…" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « top » a été tronquée dans cette exécution",
  );
});

test("refus : bloc ajouté en amont depuis l'exécution", () => {
  expect(erreur(planRejeu(valide, origine({}, ["pages"]), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("une sortie amont partielle est reprise", () => {
  const p = planRejeu(valide, origine({ pages: { statut: "partiel" } }), "resumes");
  expect(p.ok).toBe(true);
});

test("debutTropGros mesure la ligne de début avec les sorties à reprendre", () => {
  const o = { precedent: null, maintenant: "2026-10-29T08:00:00.000Z", config: null, workflow: { blocs: [], liens: [], ordre: [] } };
  const rejeu = (sorties: Record<string, unknown>) => ({ ...o, rejeu: { relances: ["b"], sorties } });
  expect(debutTropGros(o)).toBe(false);
  expect(debutTropGros(rejeu({ a: "x".repeat(1024) }))).toBe(false);
  expect(debutTropGros(rejeu({ a: "x".repeat(LIGNE_MAX_OCTETS) }))).toBe(true);
  expect(octetsLigneDebut(rejeu({}))).toBeGreaterThan(octetsLigneDebut(o));
  // La mesure est celle de la ligne réellement envoyée, au octet près (é compte deux octets).
  const ligne = rejeu({ a: "é".repeat(1000) });
  expect(octetsLigneDebut(ligne)).toBe(Buffer.byteLength(ligneDebut(ligne)));
  expect(JSON.parse(ligneDebut(ligne)).rejeu).toEqual({ relances: ["b"], sorties: { a: "é".repeat(1000) } });
  // Sans rejeu, la ligne est celle d'avant : aucune clé `rejeu`.
  expect("rejeu" in JSON.parse(ligneDebut(o))).toBe(false);
});
