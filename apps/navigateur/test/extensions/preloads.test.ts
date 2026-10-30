import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";

// Les deux preloads des extensions : celui de electron-chrome-extensions (corrigé, exécuté dans un contexte à part avec
// un `electron` leurré, sans isolation de contexte : son script du monde principal tourne directement), et celui des
// correctifs de WebAiOs (src/preload/extensions.ts, importé avec un `electron` leurré).

const { invocations, executions, exposes, agent } = vi.hoisted(() => ({
  invocations: [] as unknown[][],
  executions: [] as { func: (...a: unknown[]) => unknown; args: unknown[] }[],
  /** `contextBridge.exposeInMainWorld` : nom → objet. */
  exposes: new Map<string, Record<string, (...a: unknown[]) => unknown>>(),
  /** Réponse du processus principal à « page d'une extension de l'agent ? » (`sendSync`). */
  agent: { oui: false, demandes: 0 },
}));
vi.mock("electron", () => ({
  ipcRenderer: {
    invoke: (...a: unknown[]) => {
      invocations.push(a);
      return new Promise(() => {});
    },
    sendSync: (canal: string) => {
      if (canal !== "webaios:extension-agent") throw new Error(canal);
      agent.demandes++;
      return agent.oui;
    },
  },
  // Sans arguments (lecture du protocole) : exécuté ici ; avec (les correctifs) : noté, appelé par le test.
  contextBridge: {
    exposeInMainWorld: (nom: string, o: Record<string, (...a: unknown[]) => unknown>) => void exposes.set(nom, o),
    executeInMainWorld: (o: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => {
      if (!o.args) return o.func();
      executions.push(o as { func: (...a: unknown[]) => unknown; args: unknown[] });
      return undefined;
    },
  },
}));

const cheminBibliotheque = createRequire(import.meta.url).resolve("electron-chrome-extensions/preload");

/** Exécute le preload de la bibliothèque comme dans un service worker ; rend le contexte global. */
function preloadBibliotheque(chrome: object, href: string, invoke: (...a: unknown[]) => Promise<unknown> = async () => undefined): Record<string, unknown> {
  const electron = {
    ipcRenderer: { invoke, send: () => {}, on: () => {}, once: () => {}, addListener: () => {}, removeListener: () => {}, off: () => {} },
    contextBridge: { exposeInMainWorld: () => {}, executeInMainWorld: () => {} },
    webFrame: { executeJavaScript: () => {} },
  };
  const ctx: Record<string, unknown> = {
    require: (nom: string) => (nom === "electron" ? electron : undefined),
    process: { type: "service-worker", contextIsolated: false },
    location: { href },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    chrome,
    URL,
  };
  ctx.globalThis = ctx;
  runInNewContext(readFileSync(cheminBibliotheque, "utf8"), ctx);
  return ctx;
}

test("bibliothèque : dans le service worker d'une extension, browser est chrome et chrome n'est pas gelé", () => {
  const chrome = { runtime: { id: "a".repeat(32), getManifest: () => ({ manifest_version: 3 }) }, i18n: { getMessage: () => "" } };
  const ctx = preloadBibliotheque(chrome, `chrome-extension://${"a".repeat(32)}/fond.js`);
  expect(ctx.browser).toBe(chrome);
  expect(Object.isFrozen(chrome)).toBe(false);
});

test("bibliothèque : un refus de WebAiOs rejette l'appel avec son message (promesse) ou appelle le rappel sans résultat ; une autre erreur rend undefined", async () => {
  let erreur = "Error invoking remote method 'crx-msg': Error: URL refusée par WebAiOs";
  const chrome = { runtime: { id: "a".repeat(32), getManifest: () => ({ manifest_version: 3 }) }, i18n: { getMessage: () => "" } } as Record<string, unknown>;
  preloadBibliotheque(chrome, `chrome-extension://${"a".repeat(32)}/fond.js`, async () => {
    throw new Error(erreur);
  });
  const tabs = chrome.tabs as { create(d: unknown, rappel?: (r: unknown) => void): Promise<unknown> };
  await expect(tabs.create({ url: "https://autre.test/" })).rejects.toThrow(/^URL refusée par WebAiOs$/);
  const rappel = await new Promise((ok) => void tabs.create({ url: "https://autre.test/" }, (r) => ok(["rappel", r])));
  expect(rappel).toEqual(["rappel", undefined]);
  erreur = "Error invoking remote method 'crx-msg': Error: autre chose";
  await expect(tabs.create({ url: "https://autre.test/" })).resolves.toBeUndefined();
});

test("bibliothèque : dans le service worker d'un site web (sans id d'extension), aucun alias browser", () => {
  const ctx = preloadBibliotheque({}, "https://site.invalid/sw.js");
  expect(ctx.browser).toBeUndefined();
  // Ni l'objet IPC de la bibliothèque (détectable, même sans accès), ni ses API.
  expect(ctx.electron).toBeUndefined();
});

const typeAvant = (process as unknown as { type?: string }).type;
afterEach(() => {
  (process as unknown as { type?: string }).type = typeAvant;
  vi.unstubAllGlobals();
  invocations.length = 0;
  executions.length = 0;
  exposes.clear();
  agent.oui = false;
  agent.demandes = 0;
});

async function preloadWebaios(type: string, href: string, idExtension: string | null = new URL(href).protocol === "chrome-extension:" ? new URL(href).host : null): Promise<void> {
  (process as unknown as { type?: string }).type = type;
  vi.stubGlobal("location", new URL(href));
  // Le contexte d'une extension a aussi `chrome.runtime.id` (lu avec le protocole, dans le monde principal).
  vi.stubGlobal("chrome", idExtension ? { runtime: { id: idExtension } } : undefined);
  vi.resetModules();
  await import("../../src/preload/extensions");
}

test("correctifs : demandés dans un service worker ou une page chrome-extension://, jamais pour un site web", async () => {
  await preloadWebaios("service-worker", `chrome-extension://${"a".repeat(32)}/fond.js`);
  expect(invocations).toEqual([["webaios:extension-demarrage"]]);
  expect(executions).toHaveLength(1);
  await preloadWebaios("service-worker", "https://site.invalid/sw.js");
  await preloadWebaios("renderer", "https://site.invalid/page.html");
  expect(invocations).toHaveLength(1);
  await preloadWebaios("renderer", `chrome-extension://${"a".repeat(32)}/popup.html`);
  expect(invocations).toHaveLength(2);
});

test("correctifs, monde principal : rulesets remis aux valeurs du manifeste, puis onInstalled une fois ; rien sans installation", async () => {
  await preloadWebaios("service-worker", `chrome-extension://${"a".repeat(32)}/fond.js`);
  const { func } = executions[0]!;
  const ordre: string[] = [];
  const dnr = {
    updateEnabledRulesets: vi.fn(async (o: unknown) => {
      await new Promise((ok) => setTimeout(ok, 5));
      ordre.push(`rulesets ${JSON.stringify(o)}`);
    }),
  };
  const chrome = { runtime: {} as { onInstalled?: { addListener(f: (d: unknown) => void): void } }, declarativeNetRequest: dnr };
  vi.stubGlobal("chrome", chrome);
  let repondre!: (r: unknown) => void;
  func(new Promise((ok) => (repondre = ok)));
  chrome.runtime.onInstalled!.addListener((d) => ordre.push(`installe ${JSON.stringify(d)}`));
  repondre({ installation: { reason: "update", previousVersion: "1.0.0" }, rulesets: ["a"], rulesetsInactifs: ["b"], agent: false });
  await vi.waitFor(() => expect(ordre).toHaveLength(2));
  expect(ordre).toEqual([
    `rulesets ${JSON.stringify({ enableRulesetIds: ["a"], disableRulesetIds: ["b"] })}`,
    `installe ${JSON.stringify({ reason: "update", previousVersion: "1.0.0" })}`,
  ]);

  // Redémarrage : ni rulesets touchés, ni écouteurs appelés.
  ordre.length = 0;
  dnr.updateEnabledRulesets.mockClear();
  const chrome2 = { runtime: {} as { onInstalled?: { addListener(f: () => void): void } }, declarativeNetRequest: dnr };
  vi.stubGlobal("chrome", chrome2);
  func(Promise.resolve({ installation: null, rulesets: [], rulesetsInactifs: [], agent: false }));
  chrome2.runtime.onInstalled!.addListener(() => ordre.push("installe"));
  await new Promise((ok) => setTimeout(ok, 20));
  expect(ordre).toEqual([]);
  expect(dnr.updateEnabledRulesets).not.toHaveBeenCalled();
});

test("garde de l'agent : __webaios exposé dans un contexte d'extension seulement, et ses appels vont au processus principal", async () => {
  await preloadWebaios("service-worker", "https://site.invalid/sw.js");
  // Un service worker de site web sans id d'extension, même à l'adresse d'une extension : rien.
  await preloadWebaios("service-worker", `chrome-extension://${"a".repeat(32)}/fond.js`, null);
  expect(exposes.size).toBe(0);
  expect(invocations).toEqual([]);
  await preloadWebaios("service-worker", `chrome-extension://${"a".repeat(32)}/fond.js`);
  const w = exposes.get("__webaios")!;
  void w.urlPermise!("https://x.test/");
  void w.hotePermis!("4");
  expect(invocations.slice(1)).toEqual([
    ["webaios:extension-url-permise", "https://x.test/"],
    ["webaios:extension-hote-permis", 4],
  ]);
  // Un service worker n'a pas de WebRTC : aucune question synchrone.
  expect(agent.demandes).toBe(0);
});

test("pages d'une extension de l'agent : RTCPeerConnection, webkitRTCPeerConnection et RTCDataChannel retirés ; pas ailleurs", async () => {
  const noms = ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"];
  for (const n of noms) vi.stubGlobal(n, class {});
  await preloadWebaios("renderer", `chrome-extension://${"b".repeat(32)}/popup.html`);
  expect(agent.demandes).toBe(1);
  for (const n of noms) expect(n in globalThis).toBe(true);
  agent.oui = true;
  await preloadWebaios("renderer", `chrome-extension://${"a".repeat(32)}/popup.html`);
  for (const n of noms) expect(n in globalThis).toBe(false);
});
