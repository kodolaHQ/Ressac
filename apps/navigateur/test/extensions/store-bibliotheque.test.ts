import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, expect, test, vi } from "vitest";

// Le correctif de electron-chrome-web-store (patches/electron-chrome-web-store@0.13.0.patch) : l'API privée du Store
// n'est donnée qu'au cadre principal de l'origine exacte https://chromewebstore.google.com (preload et IPC), et
// `chrome.management.uninstall` passe par le crochet de WebAiOs (le registre), jamais par l'effacement de la bibliothèque.

const { gestionnaires } = vi.hoisted(() => ({ gestionnaires: new Map<string, (...a: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  app: { whenReady: async () => {}, getName: () => "WebAiOs", getPath: () => "/inexistant" },
  net: {},
  session: {},
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: { handle: (canal: string, f: (...a: unknown[]) => unknown) => void gestionnaires.set(canal, f) },
  nativeImage: {},
  powerMonitor: {},
  webContents: {},
}));

const { installChromeWebStore } = await import("electron-chrome-web-store");

const STORE = "https://chromewebstore.google.com";
const temporaires: string[] = [];
afterAll(() => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
});

// ——— preload ———

const cheminPreload = createRequire(import.meta.url).resolve("electron-chrome-web-store/preload");

/** Exécute le preload de la bibliothèque dans un cadre à `href` ; rend les noms exposés au monde principal. */
function preload(href: string, principal: boolean): string[] {
  const exposes: string[] = [];
  const electron = {
    ipcRenderer: {
      invoke: async (canal: string) => (canal === "chromeWebstore.getFullChromeVersion" ? { version_number: "140", app_name: "WebAiOs" } : undefined),
      on: () => {},
      removeListener: () => {},
    },
    contextBridge: { exposeInMainWorld: (nom: string) => void exposes.push(nom) },
    webFrame: { executeJavaScript: () => {} },
  };
  const ctx: Record<string, unknown> = {
    require: (nom: string) => (nom === "electron" ? electron : undefined),
    process: { isMainFrame: principal, once: () => {}, env: {} },
    location: new URL(href),
    navigator: { userAgent: "Chrome/140.0.0.0" },
    console: { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    URL,
    Object,
    // L'habillage (« Chrome » → nom de l'appli) n'est pas testé ici.
    requestAnimationFrame: () => {},
    setTimeout: () => {},
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  runInNewContext(readFileSync(cheminPreload, "utf8"), ctx);
  return exposes;
}

test("preload : l'API du Store seulement dans le cadre principal de l'origine exacte du Store", () => {
  expect(preload(`${STORE}/detail/x/${"a".repeat(32)}`, true)).toContain("electronWebstore");
  expect(preload(`${STORE}/`, true)).toContain("electronWebstore");
  for (const href of [
    "https://chromewebstore.google.com.attaquant.tld/detail/x",
    "https://chromewebstore.google.com:8443/",
    "http://chromewebstore.google.com/",
    "https://attaquant.tld/?https://chromewebstore.google.com",
  ])
    expect(preload(href, true), href).toEqual([]);
  // Une iframe de la vraie origine du Store dans une autre page : rien non plus.
  expect(preload(`${STORE}/detail/x`, false)).toEqual([]);
});

// ——— IPC ———

const ID = "b".repeat(32);

async function equiper(o: { desinstaller?: (id: string) => Promise<void> } = {}) {
  const dossier = mkdtempSync(join(tmpdir(), "webaios-store-bib-"));
  temporaires.push(dossier);
  mkdirSync(join(dossier, ID, "1.0.0_0"), { recursive: true });
  writeFileSync(join(dossier, ID, "1.0.0_0", "manifest.json"), "{}");
  const retraits: string[] = [];
  const extension = { id: ID, manifest: { name: "Essai", version: "1.0.0", manifest_version: 3 } };
  const session = {
    registerPreloadScript: () => {},
    extensions: {
      getAllExtensions: () => [extension],
      getExtension: (id: string) => (id === ID ? extension : null),
      removeExtension: (id: string) => void retraits.push(id),
    },
  };
  await installChromeWebStore({
    session: session as never,
    extensionsPath: dossier,
    loadExtensions: false,
    autoUpdate: false,
    ...(o.desinstaller ? { uninstallHandler: o.desinstaller } : {}),
  } as never);
  /** Un appel IPC venu d'un cadre d'origine `origine`, principal ou non. */
  const appeler = (canal: string, origine: string, principal: boolean, ...args: unknown[]) => {
    const mainFrame = { origin: origine };
    const sender = { session, mainFrame, send: () => {} };
    const senderFrame = principal ? mainFrame : { origin: origine, parent: mainFrame };
    return gestionnaires.get(canal)!({ sender, senderFrame }, ...args);
  };
  return { dossier, retraits, appeler };
}

test("IPC : seulement le cadre principal de l'origine exacte du Store", async () => {
  const { appeler } = await equiper();
  expect(await appeler("chrome.management.getAll", STORE, true)).toHaveLength(1);
  expect(await appeler("chrome.management.getAll", "https://chromewebstore.google.com.attaquant.tld", true)).toBeUndefined();
  expect(await appeler("chrome.management.getAll", "https://chromewebstore.google.com:8443", true)).toBeUndefined();
  expect(await appeler("chrome.management.getAll", STORE, false)).toBeUndefined();
});

test("chrome.management.uninstall passe par le crochet de WebAiOs : la bibliothèque n'efface rien elle-même", async () => {
  const demandes: string[] = [];
  const { dossier, retraits, appeler } = await equiper({ desinstaller: async (id) => void demandes.push(id) });
  expect(await appeler("chrome.management.uninstall", STORE, true, ID, {})).toBe("success");
  expect(demandes).toEqual([ID]);
  expect(retraits).toEqual([]);
  expect(existsSync(join(dossier, ID))).toBe(true);

  // Crochet en échec (extension inconnue du registre) : erreur, rien effacé.
  const refus = await equiper({
    desinstaller: async () => {
      throw new Error("inconnue");
    },
  });
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await refus.appeler("chrome.management.uninstall", STORE, true, ID, {})).toBe("unknown_error");
  erreur.mockRestore();
  expect(refus.retraits).toEqual([]);
  expect(existsSync(join(refus.dossier, ID))).toBe(true);

  // Depuis une origine piège : jamais appelé.
  const appels: string[] = [];
  const piege = await equiper({ desinstaller: async (id) => void appels.push(id) });
  expect(await piege.appeler("chrome.management.uninstall", "https://chromewebstore.google.com.attaquant.tld", true, ID, {})).toBeUndefined();
  expect(appels).toEqual([]);
});

test("le crochet appelé est celui de la session qui héberge la page du Store (le profil de l'expéditeur IPC)", async () => {
  const appels: string[] = [];
  const a = await equiper({ desinstaller: async (id) => void appels.push(`a:${id}`) });
  const b = await equiper({ desinstaller: async (id) => void appels.push(`b:${id}`) });
  await b.appeler("chrome.management.uninstall", STORE, true, ID, {});
  await a.appeler("chrome.management.uninstall", STORE, true, ID, {});
  expect(appels).toEqual([`b:${ID}`, `a:${ID}`]);
});
