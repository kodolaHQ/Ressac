import { afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewStore, reviewStore, externalProject, ExternalRegistry, Remarques } from "@webaios/noyau";
import { startExternals } from "../../core/design/externes";

const dossiers: string[] = [];
const services: { arreter(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.arreter();
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function preparer(port: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "webaios-externes-")));
  dossiers.push(root);
  const dossiersDesign = { remarquesEspace: join(root, "espace", ".webaios", "remarques"), prive: join(root, "prive") };
  mkdirSync(dossiersDesign.prive, { recursive: true });
  const registry = await ExternalRegistry.ouvrir(dossiersDesign.prive);
  const service = await startExternals({
    registre: registry, remarques: new Remarques({ dossiers: dossiersDesign }), dossiers: dossiersDesign, port, plages: [],
    racineEspace: join(root, "espace"), maison: root, notifier: () => undefined,
  });
  services.push(service);
  return { racine: root, dossiersDesign, service };
}

test("a start that fails other than by a taken port (invalid port): off, with the reason", async () => {
  const { service } = await preparer(Number("abc"));
  const state = service.etat().serveur;
  expect(state.etat).toBe("eteint");
  if (state.etat === "eteint") expect(state.raison).toMatch(/^Le MCP externe n'a pas pu démarrer : /);
  await expect(service.brancher("x")).rejects.toThrow(/n'a pas pu démarrer/);
});

test("forgetting during the first photo: the private review repository does not come back", async () => {
  const { racine: root, dossiersDesign, service } = await preparer(0);
  const project = join(root, "site");
  mkdirSync(project);
  for (let i = 0; i < 50; i++) writeFileSync(join(project, `f${i}.txt`), `${i}\n`);
  const id = "0123456789abcdef";
  const depot = reviewStore(dossiersDesign, externalProject(id));
  const photo = new ReviewStore({ depot, dossier: project }).assurerReference().catch(() => undefined);
  await service.oublier(id);
  await photo;
  expect(existsSync(depot)).toBe(false);
});
