import { expect, test } from "vitest";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spacePaths, actionValidationContext, readAction, readActions, actionWorkflow, OUTPUT_PAGE_REQUIRED } from "../../src/index.js";
import { tempFolder } from "../helpers/temp.js";

async function space() {
  const c = spacePaths(await tempFolder());
  await mkdir(c.actions, { recursive: true });
  return c;
}
async function ask(c: ReturnType<typeof spacePaths>, id: string, declaration: unknown, files: Record<string, string> = {}) {
  const d = join(c.actions, id);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, "action.json"), typeof declaration === "string" ? declaration : JSON.stringify(declaration));
  for (const [name, content] of Object.entries(files)) await writeFile(join(d, name), content);
  return d;
}
const workflow = (to: string) => JSON.stringify({
    version: 1,
    blocks: [{ id: "lire", type: "code", params: { source: "lire.mjs" } }, { id: "sortie", type: "output", params: { to: to } }],
    links: [{ from: "lire", to: "sortie" }],
  });

test("two actions read, sorted; a damaged action.json gives an ReadAction in error without bothering the other", async () => {
  const c = await space();
  await ask(c, "zebre", { name: "Z", sources: {} });
  await ask(c, "alpha", "{pas du json");
  await ask(c, "milieu", { name: "M", sources: { account: ["gitlab.com"] } }, { "workflow.json": workflow("page") });
  const alreadyRead = await readActions(c);
  expect(alreadyRead.map((a) => a.id)).toEqual(["alpha", "milieu", "zebre"]);
  expect("error" in alreadyRead[0]!).toBe(true);
  expect((alreadyRead[0] as { error: string }).error).not.toContain(c.root);
  const m = alreadyRead[1]!;
  expect("declaration" in m && m.declaration.name).toBe("M");
  expect("hasWorkflow" in m && m.hasWorkflow).toBe(true);
  expect("hasWorkflow" in alreadyRead[2]! && (alreadyRead[2] as { hasWorkflow: boolean }).hasWorkflow).toBe(false);
  expect((await readAction(c, "milieu"))?.id).toBe("milieu");
  expect(await readAction(c, "absente")).toBeNull();
  expect(await readAction(c, "../x")).toBeNull();
});

test("a symbolic-link, hidden or invalidly named folder is ignored", async () => {
  const c = await space();
  await ask(c, "bonne", { name: "B", sources: {} });
  await ask(c, ".cachee", { name: "C", sources: {} });
  await ask(c, "Majuscule", { name: "M", sources: {} });
  const elsewhere = await tempFolder();
  await writeFile(join(elsewhere, "action.json"), JSON.stringify({ name: "L", sources: {} }));
  await symlink(elsewhere, join(c.actions, "lien"));
  await writeFile(join(c.actions, "fichier"), "x");
  expect((await readActions(c)).map((a) => a.id)).toEqual(["bonne"]);
  expect(await readAction(c, "lien")).toBeNull();
});

test("action.json over 64 KB or symbolic link: error", async () => {
  const c = await space();
  await ask(c, "grosse", JSON.stringify({ name: "G", sources: {}, description: "x".repeat(70 * 1024) }));
  const [a] = await readActions(c);
  expect(a && "error" in a).toBe(true);
});

test("action.json lien symbolique : erreur", async () => {
  const c = await space();
  const d = await ask(c, "lien", { name: "L", sources: {} });
  const elsewhere = join(await tempFolder(), "autre.json");
  await writeFile(elsewhere, JSON.stringify({ name: "A", sources: {} }));
  await rm(join(d, "action.json"));
  await symlink(elsewhere, join(d, "action.json"));
  const [a] = await readActions(c);
  expect(a && "error" in a).toBe(true);
});

test("dossier d'actions absent : liste vide", async () => {
  const c = spacePaths(await tempFolder());
  expect(await readActions(c)).toEqual([]);
});

test("actionWorkflow : harvest.mjs seul → absent ; workflow vers widget → invalide OUTPUT_PAGE_REQUIRED", async () => {
  const c = await space();
  await ask(c, "seul", { name: "S", sources: {} }, { "harvest.mjs": "export default 1" });
  await ask(c, "mauvaise", { name: "M", sources: {} }, { "workflow.json": workflow("widget") });
  await ask(c, "bonne", { name: "B", sources: {}, input: { label: "Q" }, maxDurationMinutes: 5 }, { "workflow.json": workflow("page") });
  await ask(c, "cassee", "{x");
  const only = (await readAction(c, "seul"))!;
  expect(await actionWorkflow(only)).toEqual({ t: "absent" });
  const wrong = await actionWorkflow((await readAction(c, "mauvaise"))!);
  expect(wrong.t).toBe("invalide");
  expect((wrong as { error: string }).error).toContain(OUTPUT_PAGE_REQUIRED);
  const good = await actionWorkflow((await readAction(c, "bonne"))!);
  expect(good.t).toBe("ok");
  const broken = await actionWorkflow((await readAction(c, "cassee"))!);
  expect(broken.t).toBe("illisible");
  const b = (await readAction(c, "bonne"))!;
  if ("error" in b) throw new Error("lue en erreur");
  expect(actionValidationContext(b.declaration)).toEqual({ web: false, maxDurationMinutes: 5, owner: "action", input: true });
});
