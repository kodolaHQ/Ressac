import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lireWorkflow, type ResultatValidation } from "../../src/index.js";

const erreurDe = (r: ResultatValidation | undefined) => (r && !r.ok ? r.erreur : undefined);

let racine: string;
let dossier: string;
beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), "wf-lire-"));
  dossier = join(racine, "widget");
  await mkdir(dossier);
});
afterEach(() => rm(racine, { recursive: true, force: true }));

const valide = { version: 1, blocs: [{ id: "s", type: "sortie", parametres: { vers: "widget" } }], liens: [] };

test("workflow.json l'emporte sur recolte.mjs", async () => {
  await writeFile(join(dossier, "workflow.json"), JSON.stringify(valide));
  await writeFile(join(dossier, "recolte.mjs"), "export default () => 1");
  const lu = await lireWorkflow(dossier);
  expect(lu?.origine).toBe("fichier");
  expect(lu?.resultat.ok && lu.resultat.valide.ordre).toEqual(["s"]);
});

test("recolte.mjs seul donne le workflow implicite", async () => {
  await writeFile(join(dossier, "recolte.mjs"), "export default () => 1");
  const lu = await lireWorkflow(dossier);
  expect(lu?.origine).toBe("implicite");
  expect(lu?.resultat.ok && lu.resultat.valide.ordre).toEqual(["recolte", "sortie"]);
});

test("ni l'un ni l'autre : null", async () => {
  expect(await lireWorkflow(dossier)).toBeNull();
});

test("un workflow.json coupé en plein milieu donne une erreur claire", async () => {
  await writeFile(join(dossier, "workflow.json"), '{ "version": 1, "blocs": [ { "id": "a", ');
  const lu = await lireWorkflow(dossier);
  expect(lu?.resultat.ok).toBe(false);
  expect(erreurDe(lu?.resultat)).toMatch(/^Workflow invalide : workflow\.json illisible/);
});

test("un workflow.json de plus de 256 Ko est refusé", async () => {
  await writeFile(join(dossier, "workflow.json"), JSON.stringify({ ...valide, remplissage: "x".repeat(300 * 1024) }));
  const lu = await lireWorkflow(dossier);
  expect(erreurDe(lu?.resultat)).toBe("Workflow invalide : workflow.json dépasse 256 Ko");
});

test("un lien symbolique qui sort du dossier est refusé", async () => {
  const dehors = join(racine, "dehors.json");
  await writeFile(dehors, JSON.stringify(valide));
  await symlink(dehors, join(dossier, "workflow.json"));
  const lu = await lireWorkflow(dossier);
  expect(erreurDe(lu?.resultat)).toContain("sort du dossier du widget");
});
