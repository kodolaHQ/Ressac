import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lireWorkflow, type ValidationResult } from "../../src/index.js";

const erreurDe = (r: ValidationResult | undefined) => (r && !r.ok ? r.erreur : undefined);

let racine: string;
let dossier: string;
beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), "wf-lire-"));
  dossier = join(racine, "widget");
  await mkdir(dossier);
});
afterEach(() => rm(racine, { recursive: true, force: true }));

const valide = {
  version: 1,
  blocs: [{ id: "a", type: "code", parametres: { source: "a.mjs" } }, { id: "s", type: "sortie", parametres: { vers: "widget" } }],
  liens: [{ de: "a", vers: "s" }],
};

test("workflow.json wins over recolte.mjs", async () => {
  await writeFile(join(dossier, "workflow.json"), JSON.stringify(valide));
  await writeFile(join(dossier, "recolte.mjs"), "export default () => 1");
  const lu = await lireWorkflow(dossier);
  expect(lu?.origine).toBe("fichier");
  expect(lu?.resultat.ok && lu.resultat.valide.ordre).toEqual(["a", "s"]);
});

test("recolte.mjs alone gives the implicit workflow", async () => {
  await writeFile(join(dossier, "recolte.mjs"), "export default () => 1");
  const lu = await lireWorkflow(dossier);
  expect(lu?.origine).toBe("implicite");
  expect(lu?.resultat.ok && lu.resultat.valide.ordre).toEqual(["recolte", "sortie"]);
});

test("neither: null", async () => {
  expect(await lireWorkflow(dossier)).toBeNull();
});

test("a workflow.json cut in the middle gives a clear error", async () => {
  await writeFile(join(dossier, "workflow.json"), '{ "version": 1, "blocs": [ { "id": "a", ');
  const lu = await lireWorkflow(dossier);
  expect(lu?.resultat.ok).toBe(false);
  expect(erreurDe(lu?.resultat)).toBe("Workflow invalide : workflow.json illisible (pas du JSON valide)");
});

test("a workflow.json over 256 KB is refused", async () => {
  await writeFile(join(dossier, "workflow.json"), JSON.stringify({ ...valide, remplissage: "x".repeat(300 * 1024) }));
  const lu = await lireWorkflow(dossier);
  expect(erreurDe(lu?.resultat)).toBe("Workflow invalide : workflow.json dépasse 256 Ko");
});

test("a symbolic link that leaves the folder is refused", async () => {
  const dehors = join(racine, "dehors.json");
  await writeFile(dehors, JSON.stringify(valide));
  await symlink(dehors, join(dossier, "workflow.json"));
  const lu = await lireWorkflow(dossier);
  expect(erreurDe(lu?.resultat)).toContain("sort du dossier du widget");
});

test("a workflow.json as a broken symbolic link is invalid, without falling back to recolte.mjs nor a path in the message", async () => {
  await writeFile(join(dossier, "recolte.mjs"), "export default () => 1");
  await symlink(join(dossier, "absent.json"), join(dossier, "workflow.json"));
  const lu = await lireWorkflow(dossier);
  expect(lu?.origine).toBe("fichier");
  expect(erreurDe(lu?.resultat)).toBe("Workflow invalide : workflow.json illisible");
});
