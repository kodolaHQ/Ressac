import { afterEach, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DepotRelecture, depotRelecture, projetExterne, RegistreExternes, Remarques } from "@webaios/noyau";
import { demarrerExternes } from "../../src/main/design/externes";

const dossiers: string[] = [];
const services: { arreter(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.arreter();
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function preparer(port: number) {
  const racine = realpathSync(mkdtempSync(join(tmpdir(), "webaios-externes-")));
  dossiers.push(racine);
  const dossiersDesign = { remarquesEspace: join(racine, "espace", ".webaios", "remarques"), prive: join(racine, "prive") };
  mkdirSync(dossiersDesign.prive, { recursive: true });
  const registre = await RegistreExternes.ouvrir(dossiersDesign.prive);
  const service = await demarrerExternes({
    registre, remarques: new Remarques({ dossiers: dossiersDesign }), dossiers: dossiersDesign, port, plages: [],
    racineEspace: join(racine, "espace"), maison: racine, notifier: () => undefined,
  });
  services.push(service);
  return { racine, dossiersDesign, service };
}

test("un démarrage qui échoue autrement que par un port pris (port invalide) : éteint, avec la raison", async () => {
  const { service } = await preparer(Number("abc"));
  const etat = service.etat().serveur;
  expect(etat.etat).toBe("eteint");
  if (etat.etat === "eteint") expect(etat.raison).toMatch(/^Le MCP externe n'a pas pu démarrer : /);
  await expect(service.brancher("x")).rejects.toThrow(/n'a pas pu démarrer/);
});

test("oublier pendant la première photo : le dépôt de relecture privé ne revient pas", async () => {
  const { racine, dossiersDesign, service } = await preparer(0);
  const projet = join(racine, "site");
  mkdirSync(projet);
  for (let i = 0; i < 50; i++) writeFileSync(join(projet, `f${i}.txt`), `${i}\n`);
  const id = "0123456789abcdef";
  const depot = depotRelecture(dossiersDesign, projetExterne(id));
  const photo = new DepotRelecture({ depot, dossier: projet }).assurerReference().catch(() => undefined);
  await service.oublier(id);
  await photo;
  expect(existsSync(depot)).toBe(false);
});
