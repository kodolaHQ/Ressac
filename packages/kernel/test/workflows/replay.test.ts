import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LIGNE_MAX_OCTETS, startTooBig, ligneDebut, octetsLigneDebut, replayPlan, validateWorkflow, type Execution, type TraceBloc, type ValidWorkflow } from "../../src/index.js";

const brut = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "modeles", "widgets", "actus-tech", "workflow.json"), "utf8"));
const r = validateWorkflow(brut);
if (!r.ok) throw new Error(r.erreur);
const valid: ValidWorkflow = r.valide;

const trace = (id: string, extra: Partial<TraceBloc> = {}): TraceBloc => ({
  id, type: "code", statut: "reussi", debut: null, fin: null, elements: 3, journal: [], sortie: { de: id }, ...extra,
});
const origin = (changes: Record<string, Partial<TraceBloc>> = {}, sans: string[] = []): Execution => ({
  version: 1, id: "2026-10-29T08-00-00-000Z", proprietaire: { type: "widget", id: "w" }, declencheur: "manuelle",
  debut: "2026-10-29T08:00:00.000Z", fin: null, statut: "reussie",
  blocs: valid.ordre.filter((id) => !sans.includes(id)).map((id) => trace(id, changes[id])),
});
const error = (p: ReturnType<typeof replayPlan>) => (p.ok ? "accepté à tort" : p.erreur);

test("rejouer from resumes relaunches resumes, articles, sortie and reuses pages and top", () => {
  const p = replayPlan(valid, origin({ pages: { elements: 8 }, top: { elements: 15 } }), "resumes");
  if (!p.ok) throw new Error(p.erreur);
  expect(p.relances).toEqual(["resumes", "articles", "sortie"]);
  expect(Object.keys(p.sorties).sort()).toEqual(["pages", "top"]);
  expect(p.sorties.top).toEqual({ de: "top" });
  expect(p.repris).toEqual({ pages: 8, top: 15 });
});

test("rejouer from a block without a predecessor relaunches all its downstream, reusing nothing", () => {
  const p = replayPlan(valid, origin(), "flux");
  if (!p.ok) throw new Error(p.erreur);
  expect(p.relances).toEqual(valid.ordre);
  expect(p.sorties).toEqual({});
  expect(p.repris).toEqual({});
});

test("refus : origine introuvable", () => {
  expect(error(replayPlan(valid, null, "resumes"))).toBe("Rejeu impossible : exécution introuvable");
});

test("refusal: block absent from the workflow", () => {
  expect(error(replayPlan(valid, origin(), "fantome"))).toBe("Rejeu impossible : le bloc « fantome » n'est pas dans le workflow");
});

test("refusal: upstream output absent (block not launched)", () => {
  const p = replayPlan(valid, origin({ pages: { statut: "pas-lance", sortie: undefined } }), "resumes");
  expect(error(p)).toBe("Rejeu impossible : la sortie de « pages » manque dans cette exécution");
});

test("refusal: upstream output failed", () => {
  expect(error(replayPlan(valid, origin({ top: { statut: "echoue" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « top » manque dans cette exécution",
  );
});

test("refusal: upstream output reused (the origin is itself a trial)", () => {
  expect(error(replayPlan(valid, origin({ pages: { statut: "repris" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("refusal: upstream output reused and the trial's origin pruned", () => {
  const attempt = { ...origin({ pages: { statut: "repris", sortie: undefined } }), id: "e1-essai", essai: { depart: "resumes", origine: "reel" } };
  expect(error(replayPlan(valid, attempt, "resumes", []))).toBe("Rejeu impossible : la sortie de « pages » manque dans cette exécution");
});

const attemptOf = (id: string, from: string, changes: Record<string, Partial<TraceBloc>>): Execution => ({
  ...origin(changes), id, declencheur: "rejeu", essai: { depart: "resumes", origine: from },
});
const resumedWithout = { statut: "repris", sortie: undefined } as const;

test("rejouer from the same block starting from a trial reuses the outputs of its origin, which it names", () => {
  const reel = { ...origin({ pages: { elements: 8, sortie: "p-reel" }, top: { elements: 15, sortie: "t-reel" } }), id: "reel" };
  const attempt = attemptOf("e1-essai", "reel", { pages: { ...resumedWithout, elements: 8 }, top: { ...resumedWithout, elements: 15 } });
  const p = replayPlan(valid, attempt, "resumes", [reel]);
  if (!p.ok) throw new Error(p.erreur);
  expect(p.relances).toEqual(["resumes", "articles", "sortie"]);
  expect(p.sorties).toEqual({ pages: "p-reel", top: "t-reel" });
  expect(p.repris).toEqual({ pages: 8, top: 15 });
  expect(p.origine).toBe("reel");
});

test("a trial of a trial goes back up the chain to the real run", () => {
  const reel = { ...origin({ top: { sortie: "t-reel" }, pages: { sortie: "p-reel" } }), id: "reel" };
  const e1 = attemptOf("e1-essai", "reel", { top: resumedWithout, pages: resumedWithout });
  const e2 = attemptOf("e2-essai", "e1-essai", { top: resumedWithout, pages: resumedWithout });
  const p = replayPlan(valid, e2, "resumes", [e1, reel]);
  if (!p.ok) throw new Error(p.erreur);
  expect(p.sorties).toEqual({ pages: "p-reel", top: "t-reel" });
  expect(p.origine).toBe("reel");
});

test("mixed outputs (relaunched by the trial, reused from its origin): the named origin is the trial", () => {
  const reel = { ...origin({ top: { sortie: "t-reel" } }), id: "reel" };
  // The trial started from « a-resumer »: top is reused, pages ran in the trial.
  const e1 = attemptOf("e1-essai", "reel", { flux: resumedWithout, uniques: resumedWithout, tri: resumedWithout, top: resumedWithout, pages: { sortie: "p-essai" } });
  const p = replayPlan(valid, e1, "resumes", [reel]);
  if (!p.ok) throw new Error(p.erreur);
  expect(p.sorties).toEqual({ pages: "p-essai", top: "t-reel" });
  expect(p.origine).toBe("e1-essai");
});

test("refusal: output reused from the trial's origin truncated", () => {
  const reel = { ...origin({ top: { sortieTronquee: true, sortie: "[{…" } }), id: "reel" };
  const attempt = attemptOf("e1-essai", "reel", { top: resumedWithout, pages: resumedWithout });
  expect(error(replayPlan(valid, attempt, "resumes", [reel]))).toBe("Rejeu impossible : la sortie de « top » a été tronquée dans cette exécution");
});

test("refusal: upstream output succeeded but without a kept output", () => {
  expect(error(replayPlan(valid, origin({ pages: { sortie: undefined } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("refusal: upstream output truncated", () => {
  expect(error(replayPlan(valid, origin({ top: { sortieTronquee: true, sortie: "[{…" } }), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « top » a été tronquée dans cette exécution",
  );
});

test("refusal: block added upstream since the run", () => {
  expect(error(replayPlan(valid, origin({}, ["pages"]), "resumes"))).toBe(
    "Rejeu impossible : la sortie de « pages » manque dans cette exécution",
  );
});

test("a partial upstream output is reused", () => {
  const p = replayPlan(valid, origin({ pages: { statut: "partiel" } }), "resumes");
  expect(p.ok).toBe(true);
});

test("debutTropGros measures the start line with the outputs to reuse", () => {
  const o = { precedent: null, maintenant: "2026-10-29T08:00:00.000Z", config: null, workflow: { blocs: [], liens: [], ordre: [] } };
  const replay = (sorties: Record<string, unknown>) => ({ ...o, rejeu: { relances: ["b"], sorties } });
  expect(startTooBig(o)).toBe(false);
  expect(startTooBig(replay({ a: "x".repeat(1024) }))).toBe(false);
  expect(startTooBig(replay({ a: "x".repeat(LIGNE_MAX_OCTETS) }))).toBe(true);
  expect(octetsLigneDebut(replay({}))).toBeGreaterThan(octetsLigneDebut(o));
  // The measure is that of the line actually sent, to the byte (é counts two bytes).
  const ligne = replay({ a: "é".repeat(1000) });
  expect(octetsLigneDebut(ligne)).toBe(Buffer.byteLength(ligneDebut(ligne)));
  expect(JSON.parse(ligneDebut(ligne)).rejeu).toEqual({ relances: ["b"], sorties: { a: "é".repeat(1000) } });
  // Without replay, the line is the earlier one: no `rejeu` key.
  expect("rejeu" in JSON.parse(ligneDebut(o))).toBe(false);
});
