import { expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appliquer } from "../../src/main/etat/actions";
import { etatInitial } from "../../src/main/etat/etat-initial";
import { chargerSession, EnregistreurSession } from "../../src/main/etat/persistance";
import type { EtatNavigateur } from "../../src/commun/modele";

const dossier = () => mkdtempSync(join(tmpdir(), "webaios-session-"));
const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

function etatRiche(): EtatNavigateur {
  let n = 0;
  const g = () => `g${++n}`;
  let e = etatInitial(g);
  const F = e.fenetres[0]!.id;
  e = appliquer(e, { type: "ouvrirOnglet", fenetreId: F, url: "https://a.test/" }, g);
  e = appliquer(e, { type: "ouvrirOnglet", fenetreId: F, url: "https://b.test/" }, g);
  const [a, b] = Object.keys(e.onglets);
  e = appliquer(e, { type: "majOnglet", id: a!, champs: { titre: "A", zoom: 1.2, chargement: true, peutReculer: true, plante: true } }, g);
  e = appliquer(e, { type: "epinglerOnglet", id: b! }, g);
  e = appliquer(e, { type: "creerEspace", nom: "Boulot", icone: "💼" }, g);
  return e;
}

test("aller-retour : identique, hors champs volatils remis par défaut", async () => {
  const d = dossier();
  const etat = etatRiche();
  const enr = new EnregistreurSession(d);
  enr.planifier(etat);
  await enr.vider();
  const relu = await chargerSession(d);
  const a = Object.values(relu.onglets).find((o) => o.url === "https://a.test/")!;
  expect(a).toMatchObject({ titre: "A", zoom: 1.2, chargement: false, peutReculer: false, peutAvancer: false, plante: false });
  const attendu = structuredClone(etat);
  for (const o of Object.values(attendu.onglets)) Object.assign(o, { chargement: false, peutReculer: false, peutAvancer: false, plante: false });
  expect(relu).toEqual(attendu);
});

test("fichier absent → état initial", async () => {
  const e = await chargerSession(dossier());
  expect(e.espaces).toHaveLength(1);
  expect(e.fenetres).toHaveLength(1);
});

test("JSON invalide → état initial et ancien fichier gardé en session.json.corrompu", async () => {
  const d = dossier();
  writeFileSync(join(d, "session.json"), "{ pas du json");
  const e = await chargerSession(d);
  expect(e.onglets).toEqual({});
  expect(readFileSync(join(d, "session.json.corrompu"), "utf8")).toBe("{ pas du json");
});

test("version inconnue → état initial et session.json.corrompu", async () => {
  const d = dossier();
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...etatRiche(), version: 2 }));
  const e = await chargerSession(d);
  expect(e.onglets).toEqual({});
  expect(existsSync(join(d, "session.json.corrompu"))).toBe(true);
});

test("état incohérent (aucun espace) → état initial", async () => {
  const d = dossier();
  writeFileSync(join(d, "session.json"), JSON.stringify({ ...etatRiche(), espaces: [] }));
  expect((await chargerSession(d)).espaces).toHaveLength(1);
});

test("planifier regroupe les écritures (3 appels rapprochés → 1 écriture)", async () => {
  const d = dossier();
  const espion = vi.spyOn(fsp, "rename");
  const enr = new EnregistreurSession(d, 50);
  const e = etatRiche();
  enr.planifier(e);
  enr.planifier(e);
  enr.planifier(e);
  await attendre(150);
  expect(espion).toHaveBeenCalledTimes(1);
  espion.mockRestore();
});

test("écriture atomique : passe par un fichier temporaire puis rename", async () => {
  const d = dossier();
  const espion = vi.spyOn(fsp, "rename");
  const enr = new EnregistreurSession(d);
  enr.planifier(etatRiche());
  await enr.vider();
  expect(espion.mock.calls[0]![0]).toMatch(/session\.json\..*tmp$/);
  expect(espion.mock.calls[0]![1]).toBe(join(d, "session.json"));
  espion.mockRestore();
});

test("vider() écrit immédiatement l'état en attente ; sans attente, ne fait rien", async () => {
  const d = dossier();
  const enr = new EnregistreurSession(d, 10_000);
  await enr.vider();
  expect(existsSync(join(d, "session.json"))).toBe(false);
  enr.planifier(etatRiche());
  await enr.vider();
  expect(existsSync(join(d, "session.json"))).toBe(true);
});
