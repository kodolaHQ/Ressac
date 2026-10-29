import { expect, test } from "vitest";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EXECUTION_MAX_OCTETS, SORTIE_MAX_OCTETS, ecrireExecution, idExecution, listerExecutions, lireExecution,
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

test("idExecution remplace : et . par -", () => {
  expect(idExecution("2026-10-29T08:00:01.234Z")).toBe("2026-10-29T08-00-01-234Z");
});

test("une sortie de plus de 256 Ko est gardée tronquée, en texte, et marquée sortieTronquee", async () => {
  const d = await dossierTemporaire();
  const grosse = { liste: Array.from({ length: 40000 }, (_, i) => ({ i, t: "abcdefghij" })) };
  const e = execution(horodatage(0), [bloc("a", grosse), bloc("b", { petit: 1 })]);
  await ecrireExecution(d, e);
  const lue = await lireExecution(d, e.id);
  const a = lue!.blocs[0]!;
  expect(a.sortieTronquee).toBe(true);
  expect(typeof a.sortie).toBe("string");
  expect(Buffer.byteLength(a.sortie as string)).toBeLessThanOrEqual(SORTIE_MAX_OCTETS);
  expect(a.sortie).toBe(JSON.stringify(grosse).slice(0, (a.sortie as string).length));
  expect(lue!.blocs[1]).toEqual(bloc("b", { petit: 1 }));
});

test("un fichier d'exécution ne dépasse jamais 4 Mo : les plus grosses sorties partent d'abord", async () => {
  const d = await dossierTemporaire();
  const blocs = Array.from({ length: 20 }, (_, i) => bloc(`b${i}`, "x".repeat(250 * 1024 - 2 - i)));
  const e = execution(horodatage(0), blocs);
  await ecrireExecution(d, e);
  const fichier = join(d, "executions", `${e.id}.json`);
  expect((await stat(fichier)).size).toBeLessThanOrEqual(EXECUTION_MAX_OCTETS);
  const lue = (await lireExecution(d, e.id))!;
  const sans = lue.blocs.filter((b) => b.sortie === undefined);
  expect(sans.length).toBeGreaterThan(0);
  expect(sans.every((b) => b.sortieTronquee === true)).toBe(true);
  expect(sans.map((b) => b.id)).toContain("b0"); // la plus grosse part en premier
  expect(lue.blocs.filter((b) => b.sortie !== undefined).every((b) => b.sortieTronquee === undefined)).toBe(true);
});

test("seules les 20 dernières exécutions sont gardées", async () => {
  const d = await dossierTemporaire();
  for (let i = 0; i < 25; i++) await ecrireExecution(d, execution(horodatage(i)));
  const noms = (await readdir(join(d, "executions"))).sort();
  expect(noms).toHaveLength(20);
  expect(noms[0]).toBe(`${idExecution(horodatage(5))}.json`);
  expect(noms).not.toContain(`${idExecution(horodatage(4))}.json`);
});

test("listerExecutions rend la plus récente d'abord et ignore un fichier abîmé", async () => {
  const d = await dossierTemporaire();
  await ecrireExecution(d, execution(horodatage(1), [bloc("a", 1)]));
  await ecrireExecution(d, execution(horodatage(3)));
  await ecrireExecution(d, execution(horodatage(2)));
  await writeFile(join(d, "executions", `${idExecution(horodatage(9))}.json`), "{ abîmé");
  const liste = await listerExecutions(d);
  expect(liste.map((r) => r.id)).toEqual([horodatage(3), horodatage(2), horodatage(1)].map(idExecution));
  expect(liste[2]).toEqual({
    id: idExecution(horodatage(1)), declencheur: "manuelle", debut: horodatage(1), fin: horodatage(1), statut: "reussie",
    blocs: [{ id: "a", statut: "reussi", elements: null }],
  });
  expect(await listerExecutions(await dossierTemporaire())).toEqual([]);
});

test("lireExecution refuse un id qui sort du dossier", async () => {
  const d = await dossierTemporaire();
  await writeFile(join(d, "etat.json"), "{}");
  expect(await lireExecution(d, "../etat")).toBeNull();
  expect(await lireExecution(d, "a/b")).toBeNull();
  expect(await lireExecution(d, idExecution(horodatage(0)))).toBeNull();
  expect(await readFile(join(d, "etat.json"), "utf8")).toBe("{}");
});

test("journaux et erreurs énormes sont bornés : le fichier reste sous 4 Mo", async () => {
  const d = await dossierTemporaire();
  const blocs = Array.from({ length: 100 }, (_, i) => ({
    ...bloc(`b${i}`), erreur: "e".repeat(100 * 1024),
    journal: Array.from({ length: 300 }, (_, j) => `${j} ` + "l".repeat(5000)),
  }));
  const e = { ...execution(horodatage(0), blocs), erreur: "E".repeat(1024 * 1024) };
  await ecrireExecution(d, e);
  expect((await stat(join(d, "executions", `${e.id}.json`))).size).toBeLessThanOrEqual(EXECUTION_MAX_OCTETS);
  const lue = (await lireExecution(d, e.id))!;
  expect(Buffer.byteLength(lue.erreur!)).toBeLessThanOrEqual(2048);
  expect(Buffer.byteLength(lue.blocs[0]!.erreur!)).toBeLessThanOrEqual(2048);
  expect(lue.blocs.every((b) => b.journal.length >= 1 && b.journal.length <= 201)).toBe(true);
  expect(lue.blocs[0]!.journal.some((l) => l.includes("lignes coupées"))).toBe(true);
});
