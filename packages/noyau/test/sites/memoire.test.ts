import { expect, test } from "vitest";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import {
  CLE_INVALIDE, CLE_MAX, ECRITURE_MEMOIRE_MS, MEMOIRE_PLEINE, MemoireSite, POSITIONS_MAX, VALEUR_NON_JSON,
} from "../../src/sites/memoire.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const fichier = (d: string) => join(d, "s", "memoire.json");
let n = 0;
const horloge = () => new Date(Date.UTC(2026, 0, 1) + n++ * 1000).toISOString();
const ouvrir = (d: string) => MemoireSite.ouvrir(d, "s", { maintenant: horloge });
const existe = (p: string) => stat(p).then(() => true, () => false);

test("retenir puis lire, relu par une nouvelle instance après vider()", async () => {
  const d = await dossierTemporaire();
  const m = await ouvrir(d);
  const v = { serie: "The Bear", saison: 2, episode: 4 };
  expect(m.retenir("encours.the-bear", v, "/serie/the-bear")).toEqual({ ok: true });
  expect(m.lire("encours.the-bear")).toEqual(v);
  expect(m.lire("absente")).toBeNull();
  await m.vider();
  const m2 = await ouvrir(d);
  expect(m2.lire("encours.the-bear")).toEqual(v);
  expect(m2.contenu().valeurs["encours.the-bear"]?.adresse).toBe("/serie/the-bear");
  m2.oublier("encours.the-bear");
  expect(m2.lire("encours.the-bear")).toBeNull();
});

test("l'écriture est différée d'au plus ECRITURE_MEMOIRE_MS et groupée", async () => {
  const d = await dossierTemporaire();
  const m = await ouvrir(d);
  m.retenir("a", 1, null);
  m.retenir("b", 2, null);
  expect(await existe(fichier(d))).toBe(false);
  await attendre(ECRITURE_MEMOIRE_MS + 300);
  expect(JSON.parse(await readFile(fichier(d), "utf8")).valeurs).toMatchObject({ a: { valeur: 1 }, b: { valeur: 2 } });
});

test("valeur de 300 Ko : MEMOIRE_PLEINE, mémoire inchangée", async () => {
  const m = await ouvrir(await dossierTemporaire());
  m.retenir("petite", 1, null);
  m.noterPosition("/v", 100, 2400);
  const avant = JSON.stringify(m.contenu());
  expect(m.retenir("grosse", "x".repeat(300 * 1024), null)).toEqual({ ok: false, erreur: MEMOIRE_PLEINE });
  expect(JSON.stringify(m.contenu())).toBe(avant);
});

test("les positions les plus anciennes sont oubliées avant de refuser", async () => {
  const m = await ouvrir(await dossierTemporaire());
  for (let i = 0; i < 400; i++) m.noterPosition(`/video/${i}-${"x".repeat(300)}`, 100, 2400);
  expect(m.retenir("grosse", "x".repeat(200 * 1024), null)).toEqual({ ok: true });
  const restantes = Object.keys(m.contenu().positions);
  expect(restantes.length).toBeLessThan(400);
  expect(restantes.at(-1)).toContain("/video/399-");
  expect(m.position(`/video/0-${"x".repeat(300)}`)).toBeNull();
});

test("fonction, cycle, undefined : VALEUR_NON_JSON", async () => {
  const m = await ouvrir(await dossierTemporaire());
  const cycle: Record<string, unknown> = {};
  cycle.soi = cycle;
  for (const v of [() => 1, cycle, undefined, 10n]) {
    expect(m.retenir("k", v, null)).toEqual({ ok: false, erreur: VALEUR_NON_JSON });
  }
  expect(m.lire("k")).toBeNull();
});

test("clé vide ou de 201 caractères : CLE_INVALIDE", async () => {
  const m = await ouvrir(await dossierTemporaire());
  expect(m.retenir("", 1, null)).toEqual({ ok: false, erreur: CLE_INVALIDE });
  expect(m.retenir("a".repeat(CLE_MAX + 1), 1, null)).toEqual({ ok: false, erreur: CLE_INVALIDE });
  expect(m.retenir("a".repeat(CLE_MAX), 1, null)).toEqual({ ok: true });
});

test("__proto__ est une clé comme une autre", async () => {
  const d = await dossierTemporaire();
  const m = await ouvrir(d);
  expect(m.retenir("__proto__", { polluee: true }, null)).toEqual({ ok: true });
  expect(({} as Record<string, unknown>).polluee).toBeUndefined();
  expect(Object.getPrototypeOf(m.contenu().valeurs)).toBeNull();
  expect(m.lire("__proto__")).toEqual({ polluee: true });
  expect(m.lire("toString")).toBeNull();
  await m.vider();
  const m2 = await ouvrir(d);
  expect(m2.lire("__proto__")).toEqual({ polluee: true });
  expect(Object.getPrototypeOf(m2.contenu().valeurs)).toBeNull();
});

test("noterPosition : 1390/2400 gardée, 2300/2400 oubliée", async () => {
  const m = await ouvrir(await dossierTemporaire());
  m.noterPosition("/v", 1390, 2400);
  expect(m.position("/v")?.t).toBe(1390);
  m.noterPosition("/v", 2300, 2400);
  expect(m.position("/v")).toBeNull();
  m.noterPosition("/w", Number.NaN, 2400);
  m.noterPosition("/w", 5, 0);
  expect(m.position("/w")).toBeNull();
});

test("600 positions : 500 gardées, les 100 plus anciennes parties", async () => {
  const m = await ouvrir(await dossierTemporaire());
  for (let i = 0; i < 600; i++) m.noterPosition(`/v/${i}`, 100, 2400);
  expect(Object.keys(m.contenu().positions)).toHaveLength(POSITIONS_MAX);
  expect(m.position("/v/99")).toBeNull();
  expect(m.position("/v/100")).not.toBeNull();
  expect(m.position("/v/599")).not.toBeNull();
});

test("memoire.json abîmé : mémoire vide, puis réécrit proprement", async () => {
  const d = await dossierTemporaire();
  await mkdir(join(d, "s"), { recursive: true });
  await writeFile(fichier(d), "{pas du json");
  const m = await ouvrir(d);
  expect(m.contenu()).toEqual({ version: 1, valeurs: {}, positions: {} });
  m.retenir("a", 1, null);
  await m.vider();
  expect(JSON.parse(await readFile(fichier(d), "utf8")).valeurs.a.valeur).toBe(1);
  await writeFile(fichier(d), JSON.stringify({ version: 1, valeurs: { a: 3 }, positions: [] }));
  expect((await ouvrir(d)).contenu().valeurs).toEqual({});
});

test("deux retenir simultanés : les deux clés présentes", async () => {
  const d = await dossierTemporaire();
  const m = await ouvrir(d);
  await Promise.all([
    Promise.resolve().then(() => m.retenir("cadre1", 1, null)),
    Promise.resolve().then(() => m.retenir("cadre2", 2, null)),
  ]);
  await m.vider();
  const m2 = await ouvrir(d);
  expect([m2.lire("cadre1"), m2.lire("cadre2")]).toEqual([1, 2]);
});

test("effacer : fichier absent, contenu vide, écriture en attente annulée, surChange notifié", async () => {
  const d = await dossierTemporaire();
  const m = await ouvrir(d);
  m.retenir("a", 1, null);
  await m.vider();
  expect(await existe(fichier(d))).toBe(true);
  m.retenir("b", 2, null);
  let appels = 0;
  const arreter = m.surChange(() => appels++);
  await m.effacer();
  expect(appels).toBe(1);
  expect(m.contenu()).toEqual({ version: 1, valeurs: {}, positions: {} });
  expect(await existe(fichier(d))).toBe(false);
  await attendre(ECRITURE_MEMOIRE_MS + 300);
  expect(await existe(fichier(d))).toBe(false);
  arreter();
  m.retenir("c", 3, null);
  expect(appels).toBe(1);
});

test("surChange est notifié à retenir, oublier, noterPosition", async () => {
  const m = await ouvrir(await dossierTemporaire());
  let appels = 0;
  m.surChange(() => appels++);
  m.retenir("a", 1, null);
  m.noterPosition("/v", 10, 2400);
  m.oublier("a");
  expect(appels).toBe(3);
});
