import { expect, test } from "vitest";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cheminsEspace, contexteValidationAction, lireAction, lireActions, workflowDeLAction, SORTIE_PAGE_REQUISE } from "../../src/index.js";
import { dossierTemporaire } from "../aide/temporaire.js";

async function espace() {
  const c = cheminsEspace(await dossierTemporaire());
  await mkdir(c.actions, { recursive: true });
  return c;
}
async function poser(c: ReturnType<typeof cheminsEspace>, id: string, declaration: unknown, fichiers: Record<string, string> = {}) {
  const d = join(c.actions, id);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "action.json"), typeof declaration === "string" ? declaration : JSON.stringify(declaration));
  for (const [nom, contenu] of Object.entries(fichiers)) await writeFile(join(d, nom), contenu);
  return d;
}
const workflow = (vers: string) => JSON.stringify({
    version: 1,
    blocs: [{ id: "lire", type: "code", parametres: { source: "lire.mjs" } }, { id: "sortie", type: "sortie", parametres: { vers } }],
    liens: [{ de: "lire", vers: "sortie" }],
  });

test("deux actions lues, triées ; un action.json abîmé donne une ActionLue en erreur sans gêner l'autre", async () => {
  const c = await espace();
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

test("un dossier lien symbolique, caché ou au nom invalide est ignoré", async () => {
  const c = await espace();
  await poser(c, "bonne", { nom: "B", sources: {} });
  await poser(c, ".cachee", { nom: "C", sources: {} });
  await poser(c, "Majuscule", { nom: "M", sources: {} });
  const ailleurs = await dossierTemporaire();
  await writeFile(join(ailleurs, "action.json"), JSON.stringify({ nom: "L", sources: {} }));
  await symlink(ailleurs, join(c.actions, "lien"));
  await writeFile(join(c.actions, "fichier"), "x");
  expect((await lireActions(c)).map((a) => a.id)).toEqual(["bonne"]);
  expect(await lireAction(c, "lien")).toBeNull();
});

test("action.json de plus de 64 Ko ou lien symbolique : erreur", async () => {
  const c = await espace();
  await poser(c, "grosse", JSON.stringify({ nom: "G", sources: {}, description: "x".repeat(70 * 1024) }));
  const [a] = await lireActions(c);
  expect(a && "erreur" in a).toBe(true);
});

test("dossier d'actions absent : liste vide", async () => {
  const c = cheminsEspace(await dossierTemporaire());
  expect(await lireActions(c)).toEqual([]);
});

test("workflowDeLAction : recolte.mjs seul → absent ; workflow vers widget → invalide SORTIE_PAGE_REQUISE", async () => {
  const c = await espace();
  await poser(c, "seul", { nom: "S", sources: {} }, { "recolte.mjs": "export default 1" });
  await poser(c, "mauvaise", { nom: "M", sources: {} }, { "workflow.json": workflow("widget") });
  await poser(c, "bonne", { nom: "B", sources: {}, saisie: { libelle: "Q" }, dureeMaxMinutes: 5 }, { "workflow.json": workflow("page") });
  await poser(c, "cassee", "{x");
  const seul = (await lireAction(c, "seul"))!;
  expect(await workflowDeLAction(seul)).toEqual({ t: "absent" });
  const mauvaise = await workflowDeLAction((await lireAction(c, "mauvaise"))!);
  expect(mauvaise.t).toBe("invalide");
  expect((mauvaise as { erreur: string }).erreur).toContain(SORTIE_PAGE_REQUISE);
  const bonne = await workflowDeLAction((await lireAction(c, "bonne"))!);
  expect(bonne.t).toBe("ok");
  const cassee = await workflowDeLAction((await lireAction(c, "cassee"))!);
  expect(cassee.t).toBe("illisible");
  const b = (await lireAction(c, "bonne"))!;
  if ("erreur" in b) throw new Error("lue en erreur");
  expect(contexteValidationAction(b.declaration)).toEqual({ web: false, dureeMaxMinutes: 5, proprietaire: "action", saisie: true });
});
