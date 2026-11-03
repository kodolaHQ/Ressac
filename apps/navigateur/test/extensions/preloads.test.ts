import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";

// Les deux preloads des extensions : celui de electron-chrome-extensions (corrigé, exécuté dans un contexte à part avec
// un `electron` leurré, sans isolation de contexte : son script du monde principal tourne directement), et celui des
// correctifs de WebAiOs (src/preload/extensions.ts, importé avec un `electron` leurré).

const { invocations, executions, exposes, agent, monde } = vi.hoisted(() => ({
  invocations: [] as unknown[][],
  executions: [] as { func: (...a: unknown[]) => unknown; args: unknown[] }[],
  /** `contextBridge.exposeInMainWorld` : nom → objet. */
  exposes: new Map<string, Record<string, (...a: unknown[]) => unknown>>(),
  /** Réponse du processus principal à « page d'une extension de l'agent ? » (`sendSync`). */
  agent: { oui: false, demandes: 0 },
  /** Vrai pendant une exécution dans le monde principal (`executeInMainWorld` sans arguments). */
  monde: { principal: false },
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
      if (!o.args) {
        monde.principal = true;
        try {
          return o.func();
        } finally {
          monde.principal = false;
        }
      }
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

test("bibliothèque : avec un rappel, un refus de WebAiOs pose chrome.runtime.lastError avec son message pendant le rappel, puis l'efface", async () => {
  const chrome = { runtime: { id: "a".repeat(32), getManifest: () => ({ manifest_version: 3 }) }, i18n: { getMessage: () => "" } } as Record<string, unknown>;
  preloadBibliotheque(chrome, `chrome-extension://${"a".repeat(32)}/fond.js`, async () => {
    throw new Error("Error invoking remote method 'crx-msg': Error: Site refusé par WebAiOs");
  });
  const cookies = chrome.cookies as { set(d: unknown, rappel: (r: unknown) => void): void };
  const vu = await new Promise((ok) =>
    cookies.set({ url: "https://autre.test/" }, (r) => ok([r, (chrome.runtime as { lastError?: { message: string } }).lastError?.message])),
  );
  expect(vu).toEqual([undefined, "Site refusé par WebAiOs"]);
  expect((chrome.runtime as { lastError?: unknown }).lastError).toBeUndefined();
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

test("cadre about: : l'origine est lue dans le monde du preload, au démarrage ; celle que la page pose dans le monde principal ne compte pas", async () => {
  const origine = (principal: string, preload: string) =>
    Object.defineProperty(globalThis, "origin", { get: () => (monde.principal ? principal : preload), configurable: true });
  const avant = Object.getOwnPropertyDescriptor(globalThis, "origin");
  try {
    // La page (parent de même origine) a posé une origine d'extension dans le monde principal du cadre d'un site.
    origine(`chrome-extension://${"a".repeat(32)}`, "https://site.invalid");
    await preloadWebaios("renderer", "about:blank", null);
    expect(agent.demandes).toBe(0);
    // Dans une page de l'agent, le parent a masqué l'origine du cadre : la question est posée quand même.
    origine("https://site.invalid", `chrome-extension://${"a".repeat(32)}`);
    await preloadWebaios("renderer", "about:blank", null);
    expect(agent.demandes).toBe(1);
  } finally {
    if (avant) Object.defineProperty(globalThis, "origin", avant);
    else delete (globalThis as { origin?: unknown }).origin;
  }
});

test("cadre about: : la question synchrone n'est posée que si son origine est celle d'une extension", async () => {
  vi.stubGlobal("origin", "https://site.invalid");
  await preloadWebaios("renderer", "about:blank", null);
  expect(agent.demandes).toBe(0);
  vi.stubGlobal("origin", "null");
  await preloadWebaios("renderer", "about:srcdoc", null);
  expect(agent.demandes).toBe(0);
  vi.stubGlobal("origin", `chrome-extension://${"a".repeat(32)}`);
  await preloadWebaios("renderer", "about:blank", null);
  expect(agent.demandes).toBe(1);
});

test("I2 correctifs : l'accusé « démarrée » part après que updateEnabledRulesets a abouti, ou tout de suite sans ruleset ; jamais s'il échoue", async () => {
  await preloadWebaios("service-worker", `chrome-extension://${"a".repeat(32)}/fond.js`);
  const { func, args } = executions[0]!;
  // Dans un service worker, le second argument envoie l'accusé au processus principal.
  expect(typeof args[1]).toBe("function");
  (args[1] as () => void)();
  expect(invocations).toEqual([["webaios:extension-demarrage"], ["webaios:extension-demarree"]]);

  const ordre: string[] = [];
  const dnr = {
    updateEnabledRulesets: vi.fn(async () => {
      await new Promise((ok) => setTimeout(ok, 5));
      ordre.push("rulesets");
    }),
  };
  vi.stubGlobal("chrome", { runtime: {}, declarativeNetRequest: dnr });
  func(Promise.resolve({ installation: { reason: "install" }, rulesets: ["a"], rulesetsInactifs: [], agent: false }), () => ordre.push("demarree"));
  await vi.waitFor(() => expect(ordre).toEqual(["rulesets", "demarree"]));

  // Rien à poser (redémarrage) : tout de suite.
  ordre.length = 0;
  vi.stubGlobal("chrome", { runtime: {}, declarativeNetRequest: dnr });
  func(Promise.resolve({ installation: null, rulesets: [], rulesetsInactifs: [], agent: false }), () => ordre.push("demarree"));
  await vi.waitFor(() => expect(ordre).toEqual(["demarree"]));

  // Les rulesets refusés : aucun accusé (le processus principal attend jusqu'à son délai).
  ordre.length = 0;
  const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("chrome", { runtime: {}, declarativeNetRequest: { updateEnabledRulesets: async () => Promise.reject(new Error("non")) } });
  func(Promise.resolve({ installation: { reason: "install" }, rulesets: ["a"], rulesetsInactifs: [], agent: false }), () => ordre.push("demarree"));
  await new Promise((ok) => setTimeout(ok, 20));
  expect(ordre).toEqual([]);
  erreur.mockRestore();
});

test("I2 correctifs : une page d'extension n'envoie jamais l'accusé « démarrée » (seul le fond le fait)", async () => {
  await preloadWebaios("renderer", `chrome-extension://${"a".repeat(32)}/popup.html`);
  const { args } = executions[0]!;
  (args[1] as () => void)();
  expect(invocations).toEqual([["webaios:extension-demarrage"]]);
});
