import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DATA_MAX_SIZE, accorder, spacePaths, lastResult, writeRun, writeMemory, writeResult, attemptId, idExecution,
  lireAccords, lireExecution, readResult, forgetGoneActions, deleteDataAction, type Execution, type ActionResult,
} from "../../src/index.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const horodatage = (i: number) => new Date(Date.UTC(2026, 9, 31, 8, 0, i)).toISOString();
const execution = (debut: string, essai = false): Execution => ({
  version: 1, id: essai ? attemptId(debut) : idExecution(debut), proprietaire: { type: "action", id: "a" },
  declencheur: "manuelle", debut, fin: debut, statut: "reussie", blocs: [],
});
const resultat = (id: string, resultats: unknown = { n: 1 }): ActionResult => ({
  version: 1, execution: id, saisie: null, resultats, plan: null, secours: false, vide: false,
});
const ajouter = async (d: string, debut: string, essai = false, resultats?: unknown) => {
  const e = execution(debut, essai);
  await writeRun(join(d, "a"), e);
  await writeResult(d, "a", resultat(e.id, resultats));
  return e.id;
};

test("result written then re-read; dernierResultat ignores trials", async () => {
  const d = await dossierTemporaire();
  const vrai = await ajouter(d, horodatage(0), false, { v: "vrai" });
  const essai = await ajouter(d, horodatage(5), true, { v: "essai" });
  expect(await readResult(d, "a", vrai)).toEqual(resultat(vrai, { v: "vrai" }));
  expect((await readResult(d, "a", essai))?.resultats).toEqual({ v: "essai" });
  expect((await lastResult(d, "a"))?.execution).toBe(vrai);
  expect(await readResult(d, "a", "2020-01-01T00-00-00-000Z")).toBeNull();
  expect(await readResult(d, "a", "../../x")).toBeNull();
});

test("dernierResultat: the most recent real run that has a result", async () => {
  const d = await dossierTemporaire();
  const a = await ajouter(d, horodatage(0));
  const b = await ajouter(d, horodatage(2), false, { v: "recent" });
  expect((await lastResult(d, "a"))?.execution).toBe(b);
  await writeRun(join(d, "a"), execution(horodatage(1))); // run without a result (failure)
  expect((await lastResult(d, "a"))?.execution).toBe(b);
  expect(a).not.toBe(b);
  expect(await lastResult(await dossierTemporaire(), "a")).toBeNull();
});

test("21 runs: the oldest's result goes with it", async () => {
  const d = await dossierTemporaire();
  const ids: string[] = [];
  for (let i = 0; i < 21; i++) ids.push(await ajouter(d, horodatage(i)));
  expect(await lireExecution(join(d, "a"), ids[0]!)).toBeNull();
  expect(await readResult(d, "a", ids[0]!)).toBeNull();
  expect(await readResult(d, "a", ids[1]!)).not.toBeNull();
  expect(await readResult(d, "a", ids[20]!)).not.toBeNull();
});

test("11 trials: the oldest's result goes with it", async () => {
  const d = await dossierTemporaire();
  const ids: string[] = [];
  for (let i = 0; i < 11; i++) ids.push(await ajouter(d, horodatage(i), true));
  expect(await readResult(d, "a", ids[0]!)).toBeNull();
  expect(await readResult(d, "a", ids[10]!)).not.toBeNull();
});

test("a huge result is refused, a damaged file is ignored", async () => {
  const d = await dossierTemporaire();
  const e = execution(horodatage(0));
  await writeRun(join(d, "a"), e);
  await expect(writeResult(d, "a", resultat(e.id, "x".repeat(DATA_MAX_SIZE + 300 * 1024)))).rejects.toThrow();
  expect(await readResult(d, "a", e.id)).toBeNull();
  await mkdir(join(d, "a", "resultats"), { recursive: true });
  await writeFile(join(d, "a", "resultats", `${e.id}.json`), "{x");
  expect(await readResult(d, "a", e.id)).toBeNull();
});

test("supprimerDonneesAction erases runs, results and memory", async () => {
  const d = await dossierTemporaire();
  const id = await ajouter(d, horodatage(0));
  await writeMemory(join(d, "a"), { b: { type: "t", valeur: 1 } });
  for (const f of ["executions", "resultats", "memoire.json"]) expect(existsSync(join(d, "a", f)), f).toBe(true);
  await deleteDataAction(d, "a");
  for (const f of ["executions", "resultats", "memoire.json"]) expect(existsSync(join(d, "a", f)), f).toBe(false);
  expect(await readResult(d, "a", id)).toBeNull();
});

test("oublierActionsDisparues erases the data and grant of an action whose folder disappeared, not the others", async () => {
  const c = spacePaths(await dossierTemporaire());
  const dossierActions = await dossierTemporaire();
  await mkdir(join(c.actions, "vivante"), { recursive: true });
  for (const id of ["vivante", "disparue"]) {
    const d = join(dossierActions, id);
    const e = execution(horodatage(0));
    await writeRun(d, e);
    await writeResult(dossierActions, id, resultat(e.id));
    await accorder(dossierActions, id, { domaines: ["gitlab.com"], publiques: [], profil: "p" });
  }
  await forgetGoneActions(c, dossierActions);
  expect(existsSync(join(dossierActions, "disparue"))).toBe(false);
  expect(existsSync(join(dossierActions, "vivante", "resultats"))).toBe(true);
  expect(Object.keys(await lireAccords(dossierActions))).toEqual(["vivante"]);
});

test("oublierActionsDisparues: without an actions folder (space moved), data and grants stay", async () => {
  const c = spacePaths(await dossierTemporaire()); // c.actions does not exist
  const dossierActions = await dossierTemporaire();
  const e = execution(horodatage(0));
  await writeRun(join(dossierActions, "x"), e);
  await writeResult(dossierActions, "x", resultat(e.id));
  await accorder(dossierActions, "x", { domaines: ["gitlab.com"], publiques: [], profil: "p" });
  await forgetGoneActions(c, dossierActions);
  expect(existsSync(join(dossierActions, "x", "resultats"))).toBe(true);
  expect(Object.keys(await lireAccords(dossierActions))).toEqual(["x"]);
});

test("oublierActionsDisparues: a symbolic link named like the action is not the action", async () => {
  const c = spacePaths(await dossierTemporaire());
  const dossierActions = await dossierTemporaire();
  await mkdir(c.actions, { recursive: true });
  await symlink(await dossierTemporaire(), join(c.actions, "x"));
  await writeRun(join(dossierActions, "x"), execution(horodatage(0)));
  await forgetGoneActions(c, dossierActions);
  expect(existsSync(join(dossierActions, "x"))).toBe(false);
});

test("a well-formed plan is re-read; a malformed plan makes the result be rejected", async () => {
  const d = await dossierTemporaire();
  const id = idExecution(horodatage(0));
  const plan = { blocs: [{ composant: "titre", props: { texte: "x" } }] };
  await writeRun(join(d, "a"), execution(horodatage(0)));
  await writeResult(d, "a", { ...resultat(id), plan });
  expect((await readResult(d, "a", id))?.plan).toEqual(plan);
  await writeResult(d, "a", { ...resultat(id), plan: { blocs: [{ composant: "Pas Bon", props: {} }] } as never });
  expect(await readResult(d, "a", id)).toBeNull();
});
