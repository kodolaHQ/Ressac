import { expect, test, vi } from "vitest";
import { readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import {
  CLE_INVALIDE, CLE_MAX, TAILLE_MEMOIRE_SITE, PROFONDEUR_MEMOIRE_MAX, ECRITURE_MEMOIRE_MS, MEMOIRE_PLEINE, MemoireSite, POSITIONS_MAX, VALEUR_NON_JSON,
} from "../../src/sites/memoire.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const fichier = (d: string) => join(d, "s", "memoire.json");
let n = 0;
const horloge = () => new Date(Date.UTC(2026, 0, 1) + n++ * 1000).toISOString();
const ouvrir = (d: string) => MemoireSite.ouvrir(d, "s", { maintenant: horloge });
const existe = (p: string) => stat(p).then(() => true, () => false);

test("retenir then read, re-read by a new instance after vider()", async () => {
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

test("the write is deferred by at most ECRITURE_MEMOIRE_MS and grouped", async () => {
  const d = await dossierTemporaire();
  const m = await ouvrir(d);
  m.retenir("a", 1, null);
  m.retenir("b", 2, null);
  expect(await existe(fichier(d))).toBe(false);
  await attendre(ECRITURE_MEMOIRE_MS + 300);
  expect(JSON.parse(await readFile(fichier(d), "utf8")).valeurs).toMatchObject({ a: { valeur: 1 }, b: { valeur: 2 } });
});

test("300 KB value: MEMOIRE_PLEINE, memory unchanged", async () => {
  const m = await ouvrir(await dossierTemporaire());
  m.retenir("petite", 1, null);
  m.noterPosition("/v", 100, 2400);
  const avant = JSON.stringify(m.contenu());
  expect(m.retenir("grosse", "x".repeat(300 * 1024), null)).toEqual({ ok: false, erreur: MEMOIRE_PLEINE });
  expect(JSON.stringify(m.contenu())).toBe(avant);
});

test("the oldest positions are forgotten before refusing", async () => {
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

test("empty or 201-character key: CLE_INVALIDE", async () => {
  const m = await ouvrir(await dossierTemporaire());
  expect(m.retenir("", 1, null)).toEqual({ ok: false, erreur: CLE_INVALIDE });
  expect(m.retenir("a".repeat(CLE_MAX + 1), 1, null)).toEqual({ ok: false, erreur: CLE_INVALIDE });
  expect(m.retenir("a".repeat(CLE_MAX), 1, null)).toEqual({ ok: true });
});

test("__proto__ is a key like any other", async () => {
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

test("noterPosition: 1390/2400 kept, 2300/2400 forgotten", async () => {
  const m = await ouvrir(await dossierTemporaire());
  m.noterPosition("/v", 1390, 2400);
  expect(m.position("/v")?.t).toBe(1390);
  m.noterPosition("/v", 2300, 2400);
  expect(m.position("/v")).toBeNull();
  m.noterPosition("/w", Number.NaN, 2400);
  m.noterPosition("/w", 5, 0);
  expect(m.position("/w")).toBeNull();
});

test("600 positions: 500 kept, the 100 oldest gone", async () => {
  const m = await ouvrir(await dossierTemporaire());
  for (let i = 0; i < 600; i++) m.noterPosition(`/v/${i}`, 100, 2400);
  expect(Object.keys(m.contenu().positions)).toHaveLength(POSITIONS_MAX);
  expect(m.position("/v/99")).toBeNull();
  expect(m.position("/v/100")).not.toBeNull();
  expect(m.position("/v/599")).not.toBeNull();
});

test("damaged memoire.json: empty memory, then cleanly rewritten", async () => {
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

test("two simultaneous retenir: both keys present", async () => {
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

test("effacer: file absent, content empty, pending write cancelled, surChange notified", async () => {
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

test("surChange is notified on retenir, oublier, noterPosition", async () => {
  const m = await ouvrir(await dossierTemporaire());
  let appels = 0;
  m.surChange(() => appels++);
  m.retenir("a", 1, null);
  m.noterPosition("/v", 10, 2400);
  m.oublier("a");
  expect(appels).toBe(3);
});

const imbrique = (n: number) => {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
const taille = (m: MemoireSite) => Buffer.byteLength(JSON.stringify(m.contenu()));

test("deeply nested, cyclic or reference-bomb value: refusal without an exception", async () => {
  const m = await ouvrir(await dossierTemporaire());
  expect(PROFONDEUR_MEMOIRE_MAX).toBe(32);
  expect(m.retenir("ok", imbrique(32), null)).toEqual({ ok: true });
  expect(m.retenir("trop", imbrique(33), null)).toMatchObject({ ok: false });
  expect(m.retenir("abime", imbrique(7000), null)).toMatchObject({ ok: false });
  const cycle: unknown[] = [];
  cycle.push(cycle);
  expect(m.retenir("cycle", cycle, null)).toMatchObject({ ok: false });
  let bombe: unknown = [1];
  for (let i = 0; i < 40; i++) bombe = [bombe, bombe];
  const t0 = Date.now();
  expect(m.retenir("bombe", bombe, null)).toMatchObject({ ok: false });
  expect(Date.now() - t0).toBeLessThan(500);
  const piege = { get x(): number { throw new Error("piège"); } };
  expect(m.retenir("piege", piege, null)).toMatchObject({ ok: false });
  expect(() => m.noterPosition("/" + "x".repeat(5000), 1, 100)).not.toThrow();
  expect(m.lire("trop")).toBeNull();
});

test("noterPosition refuses a position that does not fit and keeps the total under 256 KB", async () => {
  const m = await ouvrir(await dossierTemporaire());
  expect(m.retenir("gros", "x".repeat(TAILLE_MEMOIRE_SITE - 250), null)).toEqual({ ok: true });
  m.noterPosition("/" + "y".repeat(2000), 10, 100);
  expect(m.position("/" + "y".repeat(2000))).toBeNull();
  expect(taille(m)).toBeLessThanOrEqual(TAILLE_MEMOIRE_SITE);
});

test("eviction follows quand, never the key order, and keeps the written position", async () => {
  const m = await ouvrir(await dossierTemporaire());
  m.noterPosition("b", 10, 100);
  m.noterPosition("5", 10, 100);
  expect(m.retenir("gros", "x".repeat(TAILLE_MEMOIRE_SITE - 180), null)).toEqual({ ok: true });
  expect(m.position("b")).toBeNull();
  expect(m.position("5")).not.toBeNull();
  m.noterPosition("c", 10, 100);
  expect(m.position("c")).not.toBeNull();
  expect(m.position("5")).toBeNull();
  expect(taille(m)).toBeLessThanOrEqual(TAILLE_MEMOIRE_SITE);
});

test("a retenir at the limit with 500 positions stays fast", async () => {
  const m = await ouvrir(await dossierTemporaire());
  for (let i = 0; i < 500; i++) m.noterPosition(`/v/${i}-${"x".repeat(100)}`, 10, 100);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) m.retenir("gros", "x".repeat(TAILLE_MEMOIRE_SITE - 40000 + i), null);
  expect((performance.now() - t0) / 20).toBeLessThan(15);
});

test("a re-read file is brought back to the bounds", async () => {
  const d = await dossierTemporaire();
  await mkdir(join(d, "s"), { recursive: true });
  const valeurs: Record<string, unknown> = {};
  for (let i = 0; i < 4; i++) valeurs[`k${i}`] = { valeur: "x".repeat(100_000), adresse: null, quand: "2026-01-01T00:00:00Z" };
  valeurs.profond = { valeur: imbrique(40), adresse: null, quand: "q" };
  const positions: Record<string, unknown> = {};
  for (let i = 0; i < 700; i++) positions[`/p${i}`] = { t: 1, duree: 100, quand: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() };
  await writeFile(fichier(d), JSON.stringify({ version: 1, valeurs, positions }));
  const m = await ouvrir(d);
  expect(taille(m)).toBeLessThanOrEqual(TAILLE_MEMOIRE_SITE);
  expect(m.lire("profond")).toBeNull();
  expect(m.lire("k0")).not.toBeNull();
  expect(m.lire("k3")).toBeNull();
  expect(Object.keys(m.contenu().positions).length).toBeLessThanOrEqual(POSITIONS_MAX);
});

test("contenu() and lire() return copies", async () => {
  const m = await ouvrir(await dossierTemporaire());
  m.retenir("a", { x: [1] }, null);
  m.noterPosition("/v", 5, 100);
  const c = m.contenu();
  (c.valeurs.a!.valeur as { x: number[] }).x.push(2);
  delete c.positions["/v"];
  c.valeurs.zzz = { valeur: 1, adresse: null, quand: "q" };
  (m.lire("a") as { x: number[] }).x.push(3);
  expect(m.lire("a")).toEqual({ x: [1] });
  expect(m.position("/v")).not.toBeNull();
  expect(m.lire("zzz")).toBeNull();
});

test("huge value: refusal before any JSON.parse", async () => {
  const m = await ouvrir(await dossierTemporaire());
  const parse = vi.spyOn(JSON, "parse");
  try {
    expect(m.retenir("a", "x".repeat(5_000_000), null)).toEqual({ ok: false, erreur: MEMOIRE_PLEINE });
    expect(m.retenir("b", Array.from({ length: 300_000 }, () => 1), null)).toEqual({ ok: false, erreur: MEMOIRE_PLEINE });
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

test("write failure: the data stays and vider() retries", async () => {
  const d = await dossierTemporaire();
  await writeFile(join(d, "s"), "je suis un fichier");
  const m = await ouvrir(d);
  m.retenir("a", 1, null);
  await m.vider();
  m.retenir("b", 2, null);
  await rm(join(d, "s"));
  await m.vider();
  const brut = JSON.parse(await readFile(fichier(d), "utf8"));
  expect([brut.valeurs.a.valeur, brut.valeurs.b.valeur]).toEqual([1, 2]);
});

test("unknown version: read as empty, saved as .bak, not overwritten", async () => {
  const d = await dossierTemporaire();
  await mkdir(join(d, "s"), { recursive: true });
  const futur = JSON.stringify({ version: 2, autre: "forme" });
  await writeFile(fichier(d), futur);
  const m = await ouvrir(d);
  expect(m.contenu().valeurs).toEqual({});
  expect(await readFile(join(d, "s", "memoire.json.v2.bak"), "utf8")).toBe(futur);
  m.retenir("a", 1, null);
  await m.vider();
  expect(JSON.parse(await readFile(fichier(d), "utf8")).version).toBe(1);
  expect(await readFile(join(d, "s", "memoire.json.v2.bak"), "utf8")).toBe(futur);
});

test("unknown version twice: the first .bak backup is not overwritten", async () => {
  const d = await dossierTemporaire();
  await mkdir(join(d, "s"), { recursive: true });
  const un = JSON.stringify({ version: 2, n: 1 });
  const deux = JSON.stringify({ version: 2, n: 2 });
  await writeFile(fichier(d), un);
  await ouvrir(d);
  await writeFile(fichier(d), deux);
  await ouvrir(d);
  expect(await readFile(join(d, "s", "memoire.json.v2.bak"), "utf8")).toBe(un);
  expect(await readFile(join(d, "s", "memoire.json.v2.1.bak"), "utf8")).toBe(deux);
});
