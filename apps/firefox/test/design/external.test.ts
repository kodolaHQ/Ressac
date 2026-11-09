import { afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore, reviewStore, externalProject, ExternalRegistry, Remarks } from "@webaios/kernel";
import { startExternals } from "../../core/design/external";

const folders: string[] = [];
const services: { arreter(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.arreter();
  for (const d of folders.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function prepare(port: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "webaios-externes-")));
  folders.push(root);
  const designFolders = { remarquesEspace: join(root, "espace", ".webaios", "remarques"), prive: join(root, "prive") };
  mkdirSync(designFolders.prive, { recursive: true });
  const registry = await ExternalRegistry.ouvrir(designFolders.prive);
  const service = await startExternals({
    registre: registry, remarques: new Remarks({ dossiers: designFolders }), dossiers: designFolders, port, plages: [],
    racineEspace: join(root, "espace"), maison: root, notifier: () => undefined,
  });
  services.push(service);
  return { racine: root, dossiersDesign: designFolders, service };
}

test("a start that fails other than by a taken port (invalid port): off, with the reason", async () => {
  const { service } = await prepare(Number("abc"));
  const state = service.etat().serveur;
  expect(state.etat).toBe("eteint");
  if (state.etat === "eteint") expect(state.raison).toMatch(/^Le MCP externe n'a pas pu démarrer : /);
  await expect(service.brancher("x")).rejects.toThrow(/n'a pas pu démarrer/);
});

test("forgetting during the first photo: the private review repository does not come back", async () => {
  const { racine: root, dossiersDesign: designFolders, service } = await prepare(0);
  const project = join(root, "site");
  mkdirSync(project);
  for (let i = 0; i < 50; i++) writeFileSync(join(project, `f${i}.txt`), `${i}\n`);
  const id = "0123456789abcdef";
  const depot = reviewStore(designFolders, externalProject(id));
  const photo = new ReviewStore({ depot, dossier: project }).assurerReference().catch(() => undefined);
  await service.oublier(id);
  await photo;
  expect(existsSync(depot)).toBe(false);
});
