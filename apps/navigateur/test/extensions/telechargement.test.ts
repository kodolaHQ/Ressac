import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { construireCrx } from "../../e2e/extensions/crx";

// La bibliothèque importe `electron` à son chargement ; hors d'Electron, ses objets sont des leurres (elle est mise
// dans le graphe de vite par `server.deps.inline`, voir vitest.config.ts, pour que le leurre s'applique).
vi.mock("electron", () => ({ app: {}, net: {}, session: {}, BrowserWindow: vi.fn(), ipcMain: {}, nativeImage: {}, powerMonitor: {} }));

const { CRX_INVALIDE, ERREUR_STORE, telechargerStore, urlCrx } = await import("../../src/main/extensions/telechargement");

/** Fichiers servis par le faux Store, par chemin (`/<nom>.crx`). */
const servis = new Map<string, Buffer>();
let serveur: Server;
let base: string;
/** Requêtes reçues par le faux Store. */
let requetes = 0;

beforeAll(async () => {
  serveur = createServer((req, res) => {
    requetes++;
    const corps = servis.get(req.url ?? "");
    if (!corps) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/x-chrome-extension" }).end(corps);
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
});
/** Dossiers temporaires créés par les tests, retirés à la fin. */
const temporaires: string[] = [];
const temporaire = (prefixe: string) => {
  const dossier = mkdtempSync(join(tmpdir(), prefixe));
  temporaires.push(dossier);
  return dossier;
};
afterAll(async () => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
  await new Promise<void>((ok) => serveur.close(() => ok()));
});

/** L'erreur levée, pour en vérifier le message et la cause. */
async function refus(p: Promise<unknown>): Promise<Error & { cause?: Error }> {
  const e = await p.then(() => null, (e: unknown) => e);
  if (!(e instanceof Error)) throw new Error("refus attendu");
  return e as Error & { cause?: Error };
}

function extension(version: unknown = "1.2.3"): string {
  const dossier = temporaire("webaios-ext-src-");
  writeFileSync(join(dossier, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Essai", version }));
  mkdirSync(join(dossier, "js"));
  writeFileSync(join(dossier, "js", "fond.js"), "console.log('fond');\n");
  return dossier;
}

const destination = () => temporaire("webaios-store-");

test("un CRX3 bien signé est décompressé dans <dossier>/<id>/<version>_0 avec la clé dans le manifeste", async () => {
  const { crx, id } = construireCrx(extension());
  servis.set("/bon.crx", crx);
  const dossier = destination();
  const chemin = await telechargerStore(id, dossier, `${base}/bon.crx`);
  expect(chemin).toBe(join(dossier, id, "1.2.3_0"));
  const manifeste = JSON.parse(readFileSync(join(chemin, "manifest.json"), "utf8"));
  expect(manifeste.version).toBe("1.2.3");
  expect(typeof manifeste.key).toBe("string");
  expect(readFileSync(join(chemin, "js", "fond.js"), "utf8")).toBe("console.log('fond');\n");
  expect(readdirSync(join(dossier, id))).toEqual(["1.2.3_0"]);
});

test("un CRX dont la signature ne correspond pas est refusé avec CRX_INVALIDE, rien n'est laissé", async () => {
  const { crx, id } = construireCrx(extension(), { signatureFausse: true });
  servis.set("/faux.crx", crx);
  const dossier = destination();
  const e = await refus(telechargerStore(id, dossier, `${base}/faux.crx`));
  expect(e.message).toBe(CRX_INVALIDE);
  expect(e.cause?.message).toBe("Invalid CRX signature");
  expect(existsSync(join(dossier, id))).toBe(false);
});

test("un CRX dont l'archive a été changée après signature est refusé", async () => {
  const { crx, id } = construireCrx(extension());
  // Le contenu de js/fond.js change, et ses CRC32 (en-tête local et répertoire central) sont recalculés : le zip
  // reste valide, seule la signature peut le refuser.
  const abime = Buffer.from(crx);
  const avant = Buffer.from("console.log('fond');\n");
  const apres = Buffer.from("console.log('FOND');\n");
  const position = abime.indexOf(avant);
  expect(position).toBeGreaterThan(0);
  apres.copy(abime, position);
  const crcAvant = Buffer.alloc(4);
  crcAvant.writeUInt32LE(crc32(avant), 0);
  const crcApres = Buffer.alloc(4);
  crcApres.writeUInt32LE(crc32(apres), 0);
  let n = 0;
  for (let i = abime.indexOf(crcAvant); i >= 0; i = abime.indexOf(crcAvant, i + 4), n++) crcApres.copy(abime, i);
  expect(n).toBe(2);
  servis.set("/abime.crx", abime);
  const dossier = destination();
  const e = await refus(telechargerStore(id, dossier, `${base}/abime.crx`));
  expect(e.message).toBe(CRX_INVALIDE);
  expect(e.cause?.message).toBe("Invalid CRX signature");
  expect(existsSync(join(dossier, id))).toBe(false);
});

test("un CRX2 est refusé avec CRX_INVALIDE", async () => {
  const { crx, id } = construireCrx(extension());
  const v2 = Buffer.from(crx);
  v2.writeUInt32LE(2, 4);
  servis.set("/v2.crx", v2);
  const e = await refus(telechargerStore(id, destination(), `${base}/v2.crx`));
  expect(e.message).toBe(CRX_INVALIDE);
  expect(e.cause?.message).toBe("Invalid CRX format");
});

test("un identifiant mal formé est refusé avec CRX_INVALIDE avant toute requête ni écriture", async () => {
  const dossier = destination();
  servis.set("/x.crx", construireCrx(extension()).crx);
  const debut = requetes;
  for (const id of ["../../etc", "", "abcdefghijklmnopabcdefghijklmnoq", "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP", "abcdefghijklmnopabcdefghijklmno"]) {
    const e = await refus(telechargerStore(id, dossier, `${base}/x.crx`));
    expect(e.message).toBe(CRX_INVALIDE);
    expect(e.cause?.message).toMatch(/^Identifiant d'extension invalide/);
  }
  expect(requetes).toBe(debut);
  expect(readdirSync(dossier)).toEqual([]);
});

test("une version de manifeste qui n'a pas le format de Chrome est refusée, rien n'est écrit hors de <dossier>/<id>/", async () => {
  const dossier = destination();
  for (const version of ["../../evade", "1.2.3.4.5", "1.a", ".1", "1."]) {
    const { crx, id } = construireCrx(extension(version));
    servis.set("/version.crx", crx);
    const e = await refus(telechargerStore(id, dossier, `${base}/version.crx`));
    expect(e.message).toBe(CRX_INVALIDE);
    expect(e.cause?.message).toBe("Invalid extension version");
    expect(readdirSync(dossier)).toEqual([]);
  }
  expect(existsSync(join(dossier, "..", "evade_0"))).toBe(false);
});

test("un CRX d'une autre extension (id différent) est refusé avec CRX_INVALIDE", async () => {
  const { crx } = construireCrx(extension());
  const autre = construireCrx(extension()).id;
  servis.set("/autre.crx", crx);
  const dossier = destination();
  await expect(telechargerStore(autre, dossier, `${base}/autre.crx`)).rejects.toThrow(CRX_INVALIDE);
  expect(readdirSync(dossier)).toEqual([]);
});

test("un CRX sans version dans son manifeste ne laisse aucun dossier à moitié décompressé", async () => {
  const source = extension();
  writeFileSync(join(source, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Sans version" }));
  const { crx, id } = construireCrx(source);
  servis.set("/sans-version.crx", crx);
  const dossier = destination();
  await expect(telechargerStore(id, dossier, `${base}/sans-version.crx`)).rejects.toThrow(CRX_INVALIDE);
  expect(existsSync(join(dossier, id))).toBe(false);
});

test("un échec garde la version déjà installée", async () => {
  const cle = construireCrx(extension()).cle;
  const { crx, id } = construireCrx(extension("1.0.0"), { cle });
  servis.set("/v1.crx", crx);
  const dossier = destination();
  await telechargerStore(id, dossier, `${base}/v1.crx`);
  servis.set("/v2-faux.crx", construireCrx(extension("2.0.0"), { cle, signatureFausse: true }).crx);
  await expect(telechargerStore(id, dossier, `${base}/v2-faux.crx`)).rejects.toThrow(CRX_INVALIDE);
  expect(readdirSync(join(dossier, id))).toEqual(["1.0.0_0"]);
});

test("un serveur en 404 ou fermé donne ERREUR_STORE", async () => {
  const id = construireCrx(extension()).id;
  const dossier = destination();
  const e404 = await telechargerStore(id, dossier, `${base}/absent.crx`).catch((e: Error) => e);
  expect(e404).toBeInstanceOf(Error);
  expect((e404 as Error).message).toBe(ERREUR_STORE);
  expect((e404 as Error).cause).toBeDefined();

  const ferme = createServer();
  await new Promise<void>((ok) => ferme.listen(0, "127.0.0.1", ok));
  const port = (ferme.address() as AddressInfo).port;
  await new Promise<void>((ok) => ferme.close(() => ok()));
  await expect(telechargerStore(id, dossier, `http://127.0.0.1:${port}/x.crx`)).rejects.toThrow(ERREUR_STORE);
  expect(readdirSync(dossier)).toEqual([]);
});

test("urlCrx suit WEBAIOS_TEST_STORE_URL", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  vi.stubEnv("WEBAIOS_TEST_STORE_URL", "");
  const reelle = new URL(urlCrx(id));
  expect(reelle.origin + reelle.pathname).toBe("https://clients2.google.com/service/update2/crx");
  expect(reelle.searchParams.get("response")).toBe("redirect");
  expect(reelle.searchParams.get("acceptformat")).toBe("crx3");
  expect(reelle.searchParams.get("x")).toBe(`id=${id}&uc`);
  expect(urlCrx(id)).toContain(`x=id%3D${id}%26uc`);
  vi.stubEnv("WEBAIOS_TEST_STORE_URL", "http://127.0.0.1:9999/store");
  expect(urlCrx(id)).toBe(`http://127.0.0.1:9999/store/${id}.crx`);
  vi.unstubAllEnvs();
});
