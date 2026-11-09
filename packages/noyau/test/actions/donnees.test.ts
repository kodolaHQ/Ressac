import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TAILLE_MAX_DONNEES, accorder, cheminsEspace, dernierResultat, ecrireExecution, ecrireMemoire, ecrireResultat, idEssai, idExecution,
  lireAccords, lireExecution, lireResultat, oublierActionsDisparues, supprimerDonneesAction, type Execution, type ResultatAction,
} from "../../src/index.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const horodatage = (i: number) => new Date(Date.UTC(2026, 9, 31, 8, 0, i)).toISOString();
const execution = (debut: string, essai = false): Execution => ({
  version: 1, id: essai ? idEssai(debut) : idExecution(debut), proprietaire: { type: "action", id: "a" },
  declencheur: "manuelle", debut, fin: debut, statut: "reussie", blocs: [],
});
const resultat = (id: string, resultats: unknown = { n: 1 }): ResultatAction => ({
  version: 1, execution: id, saisie: null, resultats, plan: null, secours: false, vide: false,
});
const ajouter = async (d: string, debut: string, essai = false, resultats?: unknown) => {
  const e = execution(debut, essai);
  await ecrireExecution(join(d, "a"), e);
  await ecrireResultat(d, "a", resultat(e.id, resultats));
  return e.id;
};

test("result written then re-read; dernierResultat ignores trials", async () => {
  const d = await dossierTemporaire();
  const vrai = await ajouter(d, horodatage(0), false, { v: "vrai" });
  const essai = await ajouter(d, horodatage(5), true, { v: "essai" });
  expect(await lireResultat(d, "a", vrai)).toEqual(resultat(vrai, { v: "vrai" }));
  expect((await lireResultat(d, "a", essai))?.resultats).toEqual({ v: "essai" });
  expect((await dernierResultat(d, "a"))?.execution).toBe(vrai);
  expect(await lireResultat(d, "a", "2020-01-01T00-00-00-000Z")).toBeNull();
  expect(await lireResultat(d, "a", "../../x")).toBeNull();
});

test("dernierResultat: the most recent real run that has a result", async () => {
  const d = await dossierTemporaire();
  const a = await ajouter(d, horodatage(0));
  const b = await ajouter(d, horodatage(2), false, { v: "recent" });
  expect((await dernierResultat(d, "a"))?.execution).toBe(b);
  await ecrireExecution(join(d, "a"), execution(horodatage(1))); // run without a result (failure)
  expect((await dernierResultat(d, "a"))?.execution).toBe(b);
  expect(a).not.toBe(b);
  expect(await dernierResultat(await dossierTemporaire(), "a")).toBeNull();
});

test("21 runs: the oldest's result goes with it", async () => {
  const d = await dossierTemporaire();
  const ids: string[] = [];
  for (let i = 0; i < 21; i++) ids.push(await ajouter(d, horodatage(i)));
  expect(await lireExecution(join(d, "a"), ids[0]!)).toBeNull();
  expect(await lireResultat(d, "a", ids[0]!)).toBeNull();
  expect(await lireResultat(d, "a", ids[1]!)).not.toBeNull();
  expect(await lireResultat(d, "a", ids[20]!)).not.toBeNull();
});

test("11 trials: the oldest's result goes with it", async () => {
  const d = await dossierTemporaire();
  const ids: string[] = [];
  for (let i = 0; i < 11; i++) ids.push(await ajouter(d, horodatage(i), true));
  expect(await lireResultat(d, "a", ids[0]!)).toBeNull();
  expect(await lireResultat(d, "a", ids[10]!)).not.toBeNull();
});

test("a huge result is refused, a damaged file is ignored", async () => {
  const d = await dossierTemporaire();
  const e = execution(horodatage(0));
  await ecrireExecution(join(d, "a"), e);
  await expect(ecrireResultat(d, "a", resultat(e.id, "x".repeat(TAILLE_MAX_DONNEES + 300 * 1024)))).rejects.toThrow();
  expect(await lireResultat(d, "a", e.id)).toBeNull();
  await mkdir(join(d, "a", "resultats"), { recursive: true });
  await writeFile(join(d, "a", "resultats", `${e.id}.json`), "{x");
  expect(await lireResultat(d, "a", e.id)).toBeNull();
});

test("supprimerDonneesAction erases runs, results and memory", async () => {
  const d = await dossierTemporaire();
  const id = await ajouter(d, horodatage(0));
  await ecrireMemoire(join(d, "a"), { b: { type: "t", valeur: 1 } });
  for (const f of ["executions", "resultats", "memoire.json"]) expect(existsSync(join(d, "a", f)), f).toBe(true);
  await supprimerDonneesAction(d, "a");
  for (const f of ["executions", "resultats", "memoire.json"]) expect(existsSync(join(d, "a", f)), f).toBe(false);
  expect(await lireResultat(d, "a", id)).toBeNull();
});

test("oublierActionsDisparues erases the data and grant of an action whose folder disappeared, not the others", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const dossierActions = await dossierTemporaire();
  await mkdir(join(c.actions, "vivante"), { recursive: true });
  for (const id of ["vivante", "disparue"]) {
    const d = join(dossierActions, id);
    const e = execution(horodatage(0));
    await ecrireExecution(d, e);
    await ecrireResultat(dossierActions, id, resultat(e.id));
    await accorder(dossierActions, id, { domaines: ["gitlab.com"], publiques: [], profil: "p" });
  }
  await oublierActionsDisparues(c, dossierActions);
  expect(existsSync(join(dossierActions, "disparue"))).toBe(false);
  expect(existsSync(join(dossierActions, "vivante", "resultats"))).toBe(true);
  expect(Object.keys(await lireAccords(dossierActions))).toEqual(["vivante"]);
});

test("oublierActionsDisparues: without an actions folder (space moved), data and grants stay", async () => {
  const c = cheminsEspace(await dossierTemporaire()); // c.actions does not exist
  const dossierActions = await dossierTemporaire();
  const e = execution(horodatage(0));
  await ecrireExecution(join(dossierActions, "x"), e);
  await ecrireResultat(dossierActions, "x", resultat(e.id));
  await accorder(dossierActions, "x", { domaines: ["gitlab.com"], publiques: [], profil: "p" });
  await oublierActionsDisparues(c, dossierActions);
  expect(existsSync(join(dossierActions, "x", "resultats"))).toBe(true);
  expect(Object.keys(await lireAccords(dossierActions))).toEqual(["x"]);
});

test("oublierActionsDisparues: a symbolic link named like the action is not the action", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  const dossierActions = await dossierTemporaire();
  await mkdir(c.actions, { recursive: true });
  await symlink(await dossierTemporaire(), join(c.actions, "x"));
  await ecrireExecution(join(dossierActions, "x"), execution(horodatage(0)));
  await oublierActionsDisparues(c, dossierActions);
  expect(existsSync(join(dossierActions, "x"))).toBe(false);
});

test("a well-formed plan is re-read; a malformed plan makes the result be rejected", async () => {
  const d = await dossierTemporaire();
  const id = idExecution(horodatage(0));
  const plan = { blocs: [{ composant: "titre", props: { texte: "x" } }] };
  await ecrireExecution(join(d, "a"), execution(horodatage(0)));
  await ecrireResultat(d, "a", { ...resultat(id), plan });
  expect((await lireResultat(d, "a", id))?.plan).toEqual(plan);
  await ecrireResultat(d, "a", { ...resultat(id), plan: { blocs: [{ composant: "Pas Bon", props: {} }] } as never });
  expect(await lireResultat(d, "a", id)).toBeNull();
});
