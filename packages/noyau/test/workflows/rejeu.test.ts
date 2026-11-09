import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LIGNE_MAX_OCTETS, startTooBig, ligneDebut, octetsLigneDebut, replayPlan, validateWorkflow, type Execution, type TraceBloc, type ValidWorkflow } from "../../src/index.js";

const brut = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "modeles", "widgets", "actus-tech", "workflow.json"), "utf8"));
const r = validateWorkflow(brut);
if (!r.ok) throw new Error(r.erreur);
const valide: ValidWorkflow = r.valide;

const trace = (id: string, extra: Partial<TraceBloc> = {}): TraceBloc => ({
  id, type: "code", statut: "reussi", debut: null, fin: null, elements: 3, journal: [], sortie: { de: id }, ...extra,
});
const origine = (modifs: Record<string, Partial<TraceBloc>> = {}, sans: string[] = []): Execution => ({
  version: 1, id: "2026-10-29T08-00-00-000Z", proprietaire: { type: "widget", id: "w" }, declencheur: "manuelle",
  debut: "2026-10-29T08:00:00.000Z", fin: null, statut: "reussie",
  blocs: valide.ordre.filter((id) => !sans.includes(id)).map((id) => trace(id, modifs[id])),
});
const erreur = (p: ReturnType<typeof replayPlan>) => (p.ok ? "accepté à tort" : p.erreur);

test("rejouer from resumes relaunches resumes, articles, sortie and reuses pages and top", () => {
  const p = replayPlan(valide, origine({ pages: { elements: 8 }, top: { elements: 15 } }), "resumes");
  if (!p.ok) throw new Error(p.erreur);
  expect(p.relances).toEqual(["resumes", "articles", "sortie"]);
  expect(Object.keys(p.sorties).sort()).toEqual(["pages", "top"]);
  expect(p.sorties.top).toEqual({ de: "top" });
  expect(p.repris).toEqual({ pages: 8, top: 15 });
});

test("rejouer from a block without a predecessor relaunches all its downstream, reusing nothing", () => {
  const p = replayPlan(valide, origine(), "flux");
  if (!p.ok) throw new Error(p.erreur);
  expect(p.relances).toEqual(valide.ordre);
  expect(p.sorties).toEqual({});
  expect(p.repris).toEqual({});
});

test("refus : origine introuvable", () => {
  expect(erreur(replayPlan(valide, null, "resumes"))).toBe("Rejeu impossible : exécution introuvable");
});

test("refusal: block absent from the workflow", () => {
  expect(erreur(replayPlan(valide, origine(), "fantome"))).toBe("Rejeu impossible : le bloc « fantome » n'est pas dans le workflow");
});

test("refusal: upstream output absent (block not launched)", () => {
  const p = replayPlan(valide, origine({ pages: { statut: "pas-lance", sortie: undefined } }), "resumes");
  expect(erreur(p)).toBe("Rejeu impossible : la sortie de « pages » manque dans cette exécution");
});

test("refusal: upstream output failed", () => {
  expect(erreur(replayPlan(valide, origine({ top: { statut: "echoue" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « top » manque dans cette exécution",
  );
});

test("refusal: upstream output reused (the origin is itself a trial)", () => {
  expect(erreur(replayPlan(valide, origine({ pages: { statut: "repris" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("refusal: upstream output reused and the trial's origin pruned", () => {
  const essai = { ...origine({ pages: { statut: "repris", sortie: undefined } }), id: "e1-essai", essai: { depart: "resumes", origine: "reel" } };
  expect(erreur(replayPlan(valide, essai, "resumes", []))).toBe("Rejeu impossible : la sortie de « pages » manque dans cette exécution");
});

const essaiDe = (id: string, depuis: string, modifs: Record<string, Partial<TraceBloc>>): Execution => ({
  ...origine(modifs), id, declencheur: "rejeu", essai: { depart: "resumes", origine: depuis },
});
const reprisSans = { statut: "repris", sortie: undefined } as const;

test("rejouer from the same block starting from a trial reuses the outputs of its origin, which it names", () => {
  const reel = { ...origine({ pages: { elements: 8, sortie: "p-reel" }, top: { elements: 15, sortie: "t-reel" } }), id: "reel" };
  const essai = essaiDe("e1-essai", "reel", { pages: { ...reprisSans, elements: 8 }, top: { ...reprisSans, elements: 15 } });
  const p = replayPlan(valide, essai, "resumes", [reel]);
  if (!p.ok) throw new Error(p.erreur);
  expect(p.relances).toEqual(["resumes", "articles", "sortie"]);
  expect(p.sorties).toEqual({ pages: "p-reel", top: "t-reel" });
  expect(p.repris).toEqual({ pages: 8, top: 15 });
  expect(p.origine).toBe("reel");
});

test("a trial of a trial goes back up the chain to the real run", () => {
  const reel = { ...origine({ top: { sortie: "t-reel" }, pages: { sortie: "p-reel" } }), id: "reel" };
  const e1 = essaiDe("e1-essai", "reel", { top: reprisSans, pages: reprisSans });
  const e2 = essaiDe("e2-essai", "e1-essai", { top: reprisSans, pages: reprisSans });
  const p = replayPlan(valide, e2, "resumes", [e1, reel]);
  if (!p.ok) throw new Error(p.erreur);
  expect(p.sorties).toEqual({ pages: "p-reel", top: "t-reel" });
  expect(p.origine).toBe("reel");
});

test("mixed outputs (relaunched by the trial, reused from its origin): the named origin is the trial", () => {
  const reel = { ...origine({ top: { sortie: "t-reel" } }), id: "reel" };
  // The trial started from « a-resumer »: top is reused, pages ran in the trial.
  const e1 = essaiDe("e1-essai", "reel", { flux: reprisSans, uniques: reprisSans, tri: reprisSans, top: reprisSans, pages: { sortie: "p-essai" } });
  const p = replayPlan(valide, e1, "resumes", [reel]);
  if (!p.ok) throw new Error(p.erreur);
  expect(p.sorties).toEqual({ pages: "p-essai", top: "t-reel" });
  expect(p.origine).toBe("e1-essai");
});

test("refusal: output reused from the trial's origin truncated", () => {
  const reel = { ...origine({ top: { sortieTronquee: true, sortie: "[{…" } }), id: "reel" };
  const essai = essaiDe("e1-essai", "reel", { top: reprisSans, pages: reprisSans });
  expect(erreur(replayPlan(valide, essai, "resumes", [reel]))).toBe("Rejeu impossible : la sortie de « top » a été tronquée dans cette exécution");
});

test("refusal: upstream output succeeded but without a kept output", () => {
  expect(erreur(replayPlan(valide, origine({ pages: { sortie: undefined } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("refusal: upstream output truncated", () => {
  expect(erreur(replayPlan(valide, origine({ top: { sortieTronquee: true, sortie: "[{…" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « top » a été tronquée dans cette exécution",
  );
});

test("refusal: block added upstream since the run", () => {
  expect(erreur(replayPlan(valide, origine({}, ["pages"]), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("a partial upstream output is reused", () => {
  const p = replayPlan(valide, origine({ pages: { statut: "partiel" } }), "resumes");
  expect(p.ok).toBe(true);
});

test("debutTropGros measures the start line with the outputs to reuse", () => {
  const o = { precedent: null, maintenant: "2026-10-29T08:00:00.000Z", config: null, workflow: { blocs: [], liens: [], ordre: [] } };
  const rejeu = (sorties: Record<string, unknown>) => ({ ...o, rejeu: { relances: ["b"], sorties } });
  expect(startTooBig(o)).toBe(false);
  expect(startTooBig(rejeu({ a: "x".repeat(1024) }))).toBe(false);
  expect(startTooBig(rejeu({ a: "x".repeat(LIGNE_MAX_OCTETS) }))).toBe(true);
  expect(octetsLigneDebut(rejeu({}))).toBeGreaterThan(octetsLigneDebut(o));
  // The measure is that of the line actually sent, to the byte (é counts two bytes).
  const ligne = rejeu({ a: "é".repeat(1000) });
  expect(octetsLigneDebut(ligne)).toBe(Buffer.byteLength(ligneDebut(ligne)));
  expect(JSON.parse(ligneDebut(ligne)).rejeu).toEqual({ relances: ["b"], sorties: { a: "é".repeat(1000) } });
  // Without replay, the line is the earlier one: no `rejeu` key.
  expect("rejeu" in JSON.parse(ligneDebut(o))).toBe(false);
});
