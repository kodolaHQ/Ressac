import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

beforeAll(async () => {
  serveur = createServer((req, res) => {
    const corps = servis.get(req.url ?? "");
    if (!corps) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/x-chrome-extension" }).end(corps);
  });
  await new Promise<void>((ok) => serveur.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => serveur.close(() => ok())));

function extension(version = "1.2.3"): string {
  const dossier = mkdtempSync(join(tmpdir(), "webaios-ext-src-"));
  writeFileSync(join(dossier, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Essai", version }));
  mkdirSync(join(dossier, "js"));
  writeFileSync(join(dossier, "js", "fond.js"), "console.log('fond');\n");
  return dossier;
}

const destination = () => mkdtempSync(join(tmpdir(), "webaios-store-"));

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
  await expect(telechargerStore(id, dossier, `${base}/faux.crx`)).rejects.toThrow(CRX_INVALIDE);
  expect(existsSync(join(dossier, id))).toBe(false);
});

test("un CRX dont l'archive a été changée après signature est refusé", async () => {
  const { crx, id } = construireCrx(extension());
  const abime = Buffer.from(crx);
  abime.writeUInt8(abime.readUInt8(abime.length - 30) ^ 0x01, abime.length - 30); // dans le répertoire central du zip, couvert par la signature
  servis.set("/abime.crx", abime);
  const dossier = destination();
  await expect(telechargerStore(id, dossier, `${base}/abime.crx`)).rejects.toThrow(CRX_INVALIDE);
  expect(existsSync(join(dossier, id))).toBe(false);
});

test("un CRX2 est refusé avec CRX_INVALIDE", async () => {
  const { crx, id } = construireCrx(extension());
  const v2 = Buffer.from(crx);
  v2.writeUInt32LE(2, 4);
  servis.set("/v2.crx", v2);
  await expect(telechargerStore(id, destination(), `${base}/v2.crx`)).rejects.toThrow(CRX_INVALIDE);
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
