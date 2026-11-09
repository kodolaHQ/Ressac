import { expect, test } from "vitest";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths, actionValidationContext, lireAction, lireActions, workflowDeLAction, OUTPUT_PAGE_REQUIRED } from "../../src/index.js";
import { tempFolder } from "../helpers/temp.js";

async function space() {
  const c = spacePaths(await tempFolder());
  await mkdir(c.actions, { recursive: true });
  return c;
}
async function poser(c: ReturnType<typeof spacePaths>, id: string, declaration: unknown, files: Record<string, string> = {}) {
  const d = join(c.actions, id);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "action.json"), typeof declaration === "string" ? declaration : JSON.stringify(declaration));
  for (const [name, content] of Object.entries(files)) await writeFile(join(d, name), content);
  return d;
}
const workflow = (to: string) => JSON.stringify({
    version: 1,
    blocs: [{ id: "lire", type: "code", parametres: { source: "lire.mjs" } }, { id: "sortie", type: "sortie", parametres: { vers: to } }],
    liens: [{ de: "lire", vers: "sortie" }],
  });

test("two actions read, sorted; a damaged action.json gives an ActionLue in error without bothering the other", async () => {
  const c = await space();
  await poser(c, "zebre", { nom: "Z", sources: {} });
  await poser(c, "alpha", "{pas du json");
  await poser(c, "milieu", { nom: "M", sources: { compte: ["gitlab.com"] } }, { "workflow.json": workflow("page") });
  const lues = await lireActions(c);
  expect(lues.map((a) => a.id)).toEqual(["alpha", "milieu", "zebre"]);
  expect("erreur" in lues[0]!).toBe(true);
  expect((lues[0] as { erreur: string }).erreur).not.toContain(c.racine);
  const m = lues[1]!;
  expect("declaration" in m && m.declaration.nom).toBe("M");
  expect("aWorkflow" in m && m.aWorkflow).toBe(true);
  expect("aWorkflow" in lues[2]! && (lues[2] as { aWorkflow: boolean }).aWorkflow).toBe(false);
  expect((await lireAction(c, "milieu"))?.id).toBe("milieu");
  expect(await lireAction(c, "absente")).toBeNull();
  expect(await lireAction(c, "../x")).toBeNull();
});

test("a symbolic-link, hidden or invalidly named folder is ignored", async () => {
  const c = await space();
  await poser(c, "bonne", { nom: "B", sources: {} });
  await poser(c, ".cachee", { nom: "C", sources: {} });
  await poser(c, "Majuscule", { nom: "M", sources: {} });
  const elsewhere = await tempFolder();
  await writeFile(join(elsewhere, "action.json"), JSON.stringify({ nom: "L", sources: {} }));
  await symlink(elsewhere, join(c.actions, "lien"));
  await writeFile(join(c.actions, "fichier"), "x");
  expect((await lireActions(c)).map((a) => a.id)).toEqual(["bonne"]);
  expect(await lireAction(c, "lien")).toBeNull();
});

test("action.json over 64 KB or symbolic link: error", async () => {
  const c = await space();
  await poser(c, "grosse", JSON.stringify({ nom: "G", sources: {}, description: "x".repeat(70 * 1024) }));
  const [a] = await lireActions(c);
  expect(a && "erreur" in a).toBe(true);
});

test("action.json lien symbolique : erreur", async () => {
  const c = await space();
  const d = await poser(c, "lien", { nom: "L", sources: {} });
  const elsewhere = join(await tempFolder(), "autre.json");
  await writeFile(elsewhere, JSON.stringify({ nom: "A", sources: {} }));
  await rm(join(d, "action.json"));
  await symlink(elsewhere, join(d, "action.json"));
  const [a] = await lireActions(c);
  expect(a && "erreur" in a).toBe(true);
});

test("dossier d'actions absent : liste vide", async () => {
  const c = spacePaths(await tempFolder());
  expect(await lireActions(c)).toEqual([]);
});

test("workflowDeLAction : recolte.mjs seul → absent ; workflow vers widget → invalide SORTIE_PAGE_REQUISE", async () => {
  const c = await space();
  await poser(c, "seul", { nom: "S", sources: {} }, { "recolte.mjs": "export default 1" });
  await poser(c, "mauvaise", { nom: "M", sources: {} }, { "workflow.json": workflow("widget") });
  await poser(c, "bonne", { nom: "B", sources: {}, saisie: { libelle: "Q" }, dureeMaxMinutes: 5 }, { "workflow.json": workflow("page") });
  await poser(c, "cassee", "{x");
  const only = (await lireAction(c, "seul"))!;
  expect(await workflowDeLAction(only)).toEqual({ t: "absent" });
  const wrong = await workflowDeLAction((await lireAction(c, "mauvaise"))!);
  expect(wrong.t).toBe("invalide");
  expect((wrong as { erreur: string }).erreur).toContain(OUTPUT_PAGE_REQUIRED);
  const good = await workflowDeLAction((await lireAction(c, "bonne"))!);
  expect(good.t).toBe("ok");
  const broken = await workflowDeLAction((await lireAction(c, "cassee"))!);
  expect(broken.t).toBe("illisible");
  const b = (await lireAction(c, "bonne"))!;
  if ("erreur" in b) throw new Error("lue en erreur");
  expect(actionValidationContext(b.declaration)).toEqual({ web: false, dureeMaxMinutes: 5, proprietaire: "action", saisie: true });
});
