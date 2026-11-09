import { expect, test } from "vitest";
import { readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACTION_STOPPED, EXECUTION_MAX_OCTETS, KEPT_ATTEMPTS, ID_EXECUTION, SORTIE_MAX_OCTETS, writeRun, clearRunsAndMemory, attemptId, idExecution, listerExecutions, lireExecution,
  type Execution, type TraceBloc,
} from "../../src/index.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const bloc = (id: string, sortie?: unknown): TraceBloc => ({
  id, type: "code", statut: "reussi", debut: null, fin: null, elements: null, journal: [],
  ...(sortie === undefined ? {} : { sortie }),
});
const execution = (debut: string, blocs: TraceBloc[] = []): Execution => ({
  version: 1, id: idExecution(debut), proprietaire: { type: "widget", id: "w" },
  declencheur: "manuelle", debut, fin: debut, statut: "reussie", blocs,
});
const horodatage = (i: number) => new Date(Date.UTC(2026, 9, 29, 8, 0, i)).toISOString();

test("idExecution replaces : and . with -", () => {
  expect(idExecution("2026-10-29T08:00:01.234Z")).toBe("2026-10-29T08-00-01-234Z");
});

test("an output over 256 KB is kept truncated, as text, and marked sortieTronquee", async () => {
  const d = await dossierTemporaire();
  const grosse = { liste: Array.from({ length: 40000 }, (_, i) => ({ i, t: "abcdefghij" })) };
  const e = execution(horodatage(0), [bloc("a", grosse), bloc("b", { petit: 1 })]);
  await writeRun(d, e);
  const lue = await lireExecution(d, e.id);
  const a = lue!.blocs[0]!;
  expect(a.sortieTronquee).toBe(true);
  expect(typeof a.sortie).toBe("string");
  expect(Buffer.byteLength(a.sortie as string)).toBeLessThanOrEqual(SORTIE_MAX_OCTETS);
  expect(a.sortie).toBe(JSON.stringify(grosse).slice(0, (a.sortie as string).length));
  expect(lue!.blocs[1]).toEqual(bloc("b", { petit: 1 }));
});

test("a run file never exceeds 4 MB: the biggest outputs go first", async () => {
  const d = await dossierTemporaire();
  const blocs = Array.from({ length: 20 }, (_, i) => bloc(`b${i}`, "x".repeat(250 * 1024 - 2 - i)));
  const e = execution(horodatage(0), blocs);
  await writeRun(d, e);
  const fichier = join(d, "executions", `${e.id}.json`);
  expect((await stat(fichier)).size).toBeLessThanOrEqual(EXECUTION_MAX_OCTETS);
  const lue = (await lireExecution(d, e.id))!;
  const sans = lue.blocs.filter((b) => b.sortie === undefined);
  expect(sans.length).toBeGreaterThan(0);
  expect(sans.every((b) => b.sortieTronquee === true)).toBe(true);
  expect(sans.map((b) => b.id)).toContain("b0"); // the biggest goes first
  expect(lue.blocs.filter((b) => b.sortie !== undefined).every((b) => b.sortieTronquee === undefined)).toBe(true);
});

test("only the last 20 runs are kept", async () => {
  const d = await dossierTemporaire();
  for (let i = 0; i < 25; i++) await writeRun(d, execution(horodatage(i)));
  const noms = (await readdir(join(d, "executions"))).sort();
  expect(noms).toHaveLength(20);
  expect(noms[0]).toBe(`${idExecution(horodatage(5))}.json`);
  expect(noms).not.toContain(`${idExecution(horodatage(4))}.json`);
});

test("listerExecutions returns the most recent first and ignores a damaged file", async () => {
  const d = await dossierTemporaire();
  await writeRun(d, execution(horodatage(1), [bloc("a", 1)]));
  await writeRun(d, execution(horodatage(3)));
  await writeRun(d, execution(horodatage(2)));
  await writeFile(join(d, "executions", `${idExecution(horodatage(9))}.json`), "{ abîmé");
  const liste = await listerExecutions(d);
  expect(liste.map((r) => r.id)).toEqual([horodatage(3), horodatage(2), horodatage(1)].map(idExecution));
  expect(liste[2]).toEqual({
    id: idExecution(horodatage(1)), declencheur: "manuelle", debut: horodatage(1), fin: horodatage(1), statut: "reussie",
    blocs: [{ id: "a", statut: "reussi", elements: null }],
  });
  expect(await listerExecutions(await dossierTemporaire())).toEqual([]);
});

test("lireExecution refuses an id that leaves the folder", async () => {
  const d = await dossierTemporaire();
  await writeFile(join(d, "etat.json"), "{}");
  expect(await lireExecution(d, "../etat")).toBeNull();
  expect(await lireExecution(d, "a/b")).toBeNull();
  expect(await lireExecution(d, idExecution(horodatage(0)))).toBeNull();
  expect(await readFile(join(d, "etat.json"), "utf8")).toBe("{}");
});

test("huge logs and errors are bounded: the file stays under 4 MB", async () => {
  const d = await dossierTemporaire();
  const blocs = Array.from({ length: 100 }, (_, i) => ({
    ...bloc(`b${i}`), erreur: "e".repeat(100 * 1024),
    journal: Array.from({ length: 300 }, (_, j) => `${j} ` + "l".repeat(5000)),
  }));
  const e = { ...execution(horodatage(0), blocs), erreur: "E".repeat(1024 * 1024) };
  await writeRun(d, e);
  expect((await stat(join(d, "executions", `${e.id}.json`))).size).toBeLessThanOrEqual(EXECUTION_MAX_OCTETS);
  const lue = (await lireExecution(d, e.id))!;
  expect(Buffer.byteLength(lue.erreur!)).toBeLessThanOrEqual(2048);
  expect(Buffer.byteLength(lue.blocs[0]!.erreur!)).toBeLessThanOrEqual(2048);
  expect(lue.blocs.every((b) => b.journal.length >= 1 && b.journal.length <= 201)).toBe(true);
  expect(lue.blocs[0]!.journal.some((l) => l.includes("lignes coupées"))).toBe(true);
});

test("listerExecutions does not re-read an unchanged file (same date, same size), re-reads a rewritten file", async () => {
  const d = await dossierTemporaire();
  const e = execution(horodatage(1), [bloc("a")]);
  await writeRun(d, e);
  const chemin = join(d, "executions", `${e.id}.json`);
  // A round date, which utimes can restore identically.
  const date = new Date("2026-10-29T08:00:00.000Z");
  await utimes(chemin, date, date);
  expect((await listerExecutions(d)).map((x) => x.statut)).toEqual(["reussie"]);
  // Same size, same date: the file is not re-read (the kept summary stays).
  await writeFile(chemin, (await readFile(chemin, "utf8")).replace('"reussie"', '"echouee"'));
  await utimes(chemin, date, date);
  expect((await listerExecutions(d)).map((x) => x.statut)).toEqual(["reussie"]);
  // Date changed: re-read.
  await utimes(chemin, date, new Date(date.getTime() + 5000));
  expect((await listerExecutions(d)).map((x) => x.statut)).toEqual(["echouee"]);
  // Erased: no longer listed.
  await rm(chemin);
  expect(await listerExecutions(d)).toEqual([]);
});

const essai = (debut: string): Execution => ({
  ...execution(debut), id: attemptId(debut), declencheur: "rejeu", essai: { depart: "b", origine: idExecution(horodatage(0)) },
});

test("idEssai adds -essai to the run's identifier", () => {
  expect(attemptId("2026-10-29T08:00:01.234Z")).toBe("2026-10-29T08-00-01-234Z-essai");
});

test("25 trials and 25 real runs: 10 trials and 20 real ones kept", async () => {
  const d = await dossierTemporaire();
  for (let i = 0; i < 25; i++) {
    await writeRun(d, essai(horodatage(i)));
    await writeRun(d, execution(horodatage(i)));
  }
  const noms = (await readdir(join(d, "executions"))).sort();
  expect(noms.filter((n) => n.endsWith("-essai.json"))).toHaveLength(KEPT_ATTEMPTS);
  expect(noms.filter((n) => !n.endsWith("-essai.json"))).toHaveLength(20);
  expect(noms).toContain(`${attemptId(horodatage(24))}.json`);
  expect(noms).not.toContain(`${attemptId(horodatage(14))}.json`);
  expect(noms).toContain(`${idExecution(horodatage(5))}.json`);
});

test("a series of trials drives out no real run", async () => {
  const d = await dossierTemporaire();
  for (let i = 0; i < 20; i++) await writeRun(d, execution(horodatage(i)));
  for (let i = 20; i < 60; i++) await writeRun(d, essai(horodatage(i)));
  const noms = await readdir(join(d, "executions"));
  expect(noms.filter((n) => !n.endsWith("-essai.json"))).toHaveLength(20);
  expect(noms).toContain(`${idExecution(horodatage(0))}.json`);
});

test("listerExecutions marks the trials", async () => {
  const d = await dossierTemporaire();
  await writeRun(d, execution(horodatage(1)));
  await writeRun(d, essai(horodatage(2)));
  const liste = await listerExecutions(d);
  expect(liste.find((r) => r.id === attemptId(horodatage(2)))!.essai).toEqual({ depart: "b", origine: idExecution(horodatage(0)) });
  expect(liste.find((r) => r.id === idExecution(horodatage(1)))!.essai).toBeUndefined();
});

test("lireExecution accepts <timestamp>-essai and refuses ../x-essai", async () => {
  const d = await dossierTemporaire();
  await writeRun(d, essai(horodatage(3)));
  expect((await lireExecution(d, attemptId(horodatage(3))))!.declencheur).toBe("rejeu");
  // Regression guard (R21): already true before the widening of ID_EXECUTION.
  await writeFile(join(d, "x-essai.json"), "{}");
  expect(await lireExecution(d, "../x-essai")).toBeNull();
  expect(await lireExecution(d, "x-essai")).toBeNull();
  expect(ID_EXECUTION.test("2026-10-29T08-00-00-000Z-essai")).toBe(true);
  expect(ID_EXECUTION.test("2026-10-29T08-00-00-000Z-essai/../x")).toBe(false);
  expect(ID_EXECUTION.test("2026-10-29T08-00-00-000Z-essai-essai")).toBe(false);
});

test("effacerExecutionsEtMemoire also erases the trials", async () => {
  const d = await dossierTemporaire();
  await writeRun(d, essai(horodatage(3)));
  await clearRunsAndMemory(d);
  expect(await lireExecution(d, attemptId(horodatage(3)))).toBeNull();
  expect(await listerExecutions(d)).toEqual([]);
});

test("an action run (owner action, saisie « clio lyon ») is written and re-read", async () => {
  const d = await dossierTemporaire();
  const e: Execution = { ...execution(horodatage(0), [bloc("a", { x: 1 })]), proprietaire: { type: "action", id: "recherche" }, saisie: "clio lyon" };
  await writeRun(d, e);
  expect(await lireExecution(d, e.id)).toEqual(e);
  expect(ACTION_STOPPED).toBe("Arrêtée à ta demande");
});

test("a widget run written before this plan re-reads unchanged", async () => {
  const d = await dossierTemporaire();
  const e = execution(horodatage(1), [bloc("a")]);
  await writeRun(d, e);
  const lue = (await lireExecution(d, e.id))!;
  expect(lue).toEqual(e);
  expect(lue).not.toHaveProperty("saisie");
});
