import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkflow, type ValidationResult } from "../../src/index.js";

const errorOf = (r: ValidationResult | undefined) => (r && !r.ok ? r.erreur : undefined);

let root: string;
let folder: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wf-lire-"));
  folder = join(root, "widget");
  await mkdir(folder);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const valid = {
  version: 1,
  blocs: [{ id: "a", type: "code", parametres: { source: "a.mjs" } }, { id: "s", type: "sortie", parametres: { vers: "widget" } }],
  liens: [{ de: "a", vers: "s" }],
};

test("workflow.json wins over recolte.mjs", async () => {
  await writeFile(join(folder, "workflow.json"), JSON.stringify(valid));
  await writeFile(join(folder, "recolte.mjs"), "export default () => 1");
  const lu = await readWorkflow(folder);
  expect(lu?.origine).toBe("fichier");
  expect(lu?.resultat.ok && lu.resultat.valide.ordre).toEqual(["a", "s"]);
});

test("recolte.mjs alone gives the implicit workflow", async () => {
  await writeFile(join(folder, "recolte.mjs"), "export default () => 1");
  const lu = await readWorkflow(folder);
  expect(lu?.origine).toBe("implicite");
  expect(lu?.resultat.ok && lu.resultat.valide.ordre).toEqual(["recolte", "sortie"]);
});

test("neither: null", async () => {
  expect(await readWorkflow(folder)).toBeNull();
});

test("a workflow.json cut in the middle gives a clear error", async () => {
  await writeFile(join(folder, "workflow.json"), '{ "version": 1, "blocs": [ { "id": "a", ');
  const lu = await readWorkflow(folder);
  expect(lu?.resultat.ok).toBe(false);
  expect(errorOf(lu?.resultat)).toBe("Workflow invalide : workflow.json illisible (pas du JSON valide)");
});

test("a workflow.json over 256 KB is refused", async () => {
  await writeFile(join(folder, "workflow.json"), JSON.stringify({ ...valid, remplissage: "x".repeat(300 * 1024) }));
  const lu = await readWorkflow(folder);
  expect(errorOf(lu?.resultat)).toBe("Workflow invalide : workflow.json dépasse 256 Ko");
});

test("a symbolic link that leaves the folder is refused", async () => {
  const outside = join(root, "dehors.json");
  await writeFile(outside, JSON.stringify(valid));
  await symlink(outside, join(folder, "workflow.json"));
  const lu = await readWorkflow(folder);
  expect(errorOf(lu?.resultat)).toContain("sort du dossier du widget");
});

test("a workflow.json as a broken symbolic link is invalid, without falling back to recolte.mjs nor a path in the message", async () => {
  await writeFile(join(folder, "recolte.mjs"), "export default () => 1");
  await symlink(join(folder, "absent.json"), join(folder, "workflow.json"));
  const lu = await readWorkflow(folder);
  expect(lu?.origine).toBe("fichier");
  expect(errorOf(lu?.resultat)).toBe("Workflow invalide : workflow.json illisible");
});
