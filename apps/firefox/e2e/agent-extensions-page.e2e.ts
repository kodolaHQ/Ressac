import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeAgentExtension } from "./extensions/fixtures";
import { DISABLED_CRASHES } from "../shared/extensions-messages";
import { button, cleanupXpis, installAddon } from "./addons";
import { agentAddons, grant, launchWithAmo, openTab } from "./agent-extensions";
import { state, waitFor } from "./firefox";
import type { LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { click, inUi, missingApi, waitUi } from "./ui";

// The Extensions page: the unlock on the page, Supprimer and Désactiver partout of an agent extension. The page lists the agent's extensions only
// (plan decision 8); list_extensions lists AMO add-ons too (decision 7).
const HOST = "http://127.0.0.1/*";
const GRANT = { permissions: [], hosts: [HOST], network: [], allSites: false, allSitesScripts: false, scripts: true };
const HIDER = {
  "manifest.json": { manifest_version: 3, name: "Cacheur de l'agent", version: "1.2", content_scripts: [{ matches: [HOST], css: ["cache.css"] }] },
  "cache.css": "#cache-moi { display: none !important; }\n",
};
const LOG = {
  "manifest.json": { manifest_version: 3, name: "Journal de l'agent", version: "1.0.0", background: { service_worker: "fond.js" }, content_scripts: [{ matches: [HOST], js: ["contenu.js"] }] },
  "fond.js": 'console.log("fond démarré");\n',
  "contenu.js": 'console.log("contenu:" + location.pathname);\n',
};
/** Its background logs what chrome.storage.local holds, then writes a value there once. */
const MEMORY = {
  "manifest.json": { manifest_version: 3, name: "Mémoire de l'agent", version: "1.0.0", permissions: ["storage"], background: { service_worker: "fond.js" } },
  "fond.js": `chrome.storage.local.get(null).then((l) => {
  console.log("lu:" + JSON.stringify(l));
  if (!l.k) chrome.storage.local.set({ k: "gardé" });
});
`,
};
/** Its background throws as it loads: a failed start, counted as a crash. */
const BROKEN = {
  "manifest.json": { manifest_version: 3, name: "Fond cassé", version: "1.0.0", background: { service_worker: "fond.js" } },
  "fond.js": 'throw new Error("fond-casse-au-chargement");\n',
};
/** Its background hangs the extension process soon after it starts. */
const LOOP = {
  "manifest.json": { manifest_version: 3, name: "Fond qui boucle", version: "1.0.0", background: { service_worker: "fond.js" } },
  "fond.js": "setTimeout(() => { while (true) {} }, 500);\n",
};
/** A module background that loads its popup in a frame at once: the popup throws within its first second, the background does not. */
const BROKEN_POPUP = {
  "manifest.json": { manifest_version: 3, name: "Popup cassée", version: "1.0.0", background: { service_worker: "fond.js", type: "module" }, action: { default_popup: "popup.html" } },
  "fond.js": 'const f = document.createElement("iframe");\nf.src = "popup.html";\ndocument.body.append(f);\n',
  "popup.html": '<!doctype html><script src="popup.js"></script>',
  "popup.js": 'throw new Error("popup-cassee");\n',
};
const PAGE = '[data-testid="page-extensions"]';
const LINE = '[data-testid="extension-page"]';
const CARD = '[data-testid="demande-extension"]';
const UNLOCK = '[data-testid="demande-console-extension"]';
const HIDDEN = "message(s) masqué(s) : venus d'onglets que tu ne peux pas lire";

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());

const dirs: string[] = [];
const opened: LaunchedWebAiOs[] = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await cleanupXpis();
});

/** WebAiOs with the fake AMO; `prepare` writes the agent's folder and the registry first. `agent`: the agent's session started. */
async function launch(o: { prepare?: (root: string, dataDir: string) => void; agent?: boolean; dirs?: { dataDir: string; profile: string }; env?: Record<string, string> } = {}) {
  const d = o.dirs ?? { dataDir: mkdtempSync(path.join(os.tmpdir(), "webaios-data-")), profile: mkdtempSync(path.join(os.tmpdir(), "webaios-firefox-")) };
  if (!o.dirs) dirs.push(d.dataDir, d.profile);
  const root = path.join(d.dataDir, "workspace");
  o.prepare?.(root, d.dataDir);
  const w = await launchWithAmo({ ...d, env: o.env });
  opened.push(w);
  if (o.agent) {
    const config = path.join(root, ".webaios", "mcp.json");
    for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
    await waitUi(w.marionette, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
  }
  return { ...w, ...d, root: root, call: (name: string, args: Record<string, unknown> = {}) => callTool(d.dataDir, name, args) };
}
type Launched = Awaited<ReturnType<typeof launch>>;

const registry = (dataDir: string) => {
  const f = path.join(dataDir, "extensions", "state.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { allCut: boolean; extensions: Record<string, { profiles: string[]; disabled?: unknown }> }) : { allCut: false, extensions: {} };
};
const waitActive = (m: Marionette, id: string, active: boolean) =>
  waitFor(m, `return (async () => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    return !!(await AddonManager.getAddonByID(${JSON.stringify(id)}))?.isActive;
  })();`, (v) => v === active, 30_000);
const activeSpace = async (m: Marionette) => {
  const s = await state(m);
  return s.spaces.find((e) => e.id === s.windows[0]!.activeSpace)!;
};

/** The strip's menu, then one of its buttons. */
async function fromStrip(m: Marionette, text: string): Promise<void> {
  await click(m, '[data-testid="menu-extensions"]');
  await click(m, '[data-testid="panneau-extensions"] button', { text });
}
/** Opens the Extensions page from the strip's « Extensions de l'agent ». */
async function openPage(m: Marionette): Promise<void> {
  await fromStrip(m, "Extensions de l'agent");
  await waitUi(m, `return !!doc.querySelector(${JSON.stringify(PAGE)})`);
}
/** The page's row naming `nom` (its text), or null. */
const row = (m: Marionette, name: string) =>
  inUi<string | null>(m, `return [...doc.querySelectorAll(arguments[0])].find((l) => l.querySelector("b")?.textContent === arguments[1])?.textContent ?? null`, [LINE, name]);
/** Waits until the row naming `nom` is there (`present`) or gone. */
const waitRow = (m: Marionette, name: string, present: boolean) =>
  waitUi(m, `return [...doc.querySelectorAll(arguments[0])].some((l) => l.querySelector("b")?.textContent === arguments[1]) === arguments[2]`, [LINE, name, present], 15_000);
/** Clicks the button `text` in the row naming `nom`. */
async function rowButton(m: Marionette, name: string, text: string): Promise<void> {
  await waitUi(m, `return [...doc.querySelectorAll(arguments[0])].some((l) => l.querySelector("b")?.textContent === arguments[1])`, [LINE, name]);
  await inUi(m, `const l = [...doc.querySelectorAll(arguments[0])].find((l) => l.querySelector("b")?.textContent === arguments[1]); l.setAttribute("data-cible", "1");`, [LINE, name]);
  await click(m, `${LINE}[data-cible="1"] button`, { text });
  await inUi(m, `doc.querySelector('[data-cible="1"]')?.removeAttribute("data-cible")`);
}
/** Supprimer, then its confirmation. */
async function remove(m: Marionette, name: string): Promise<void> {
  await rowButton(m, name, "Supprimer");
  await click(m, '[data-testid="confirmation-suppression-extension"] button.confirmer');
}
/** request_extension, then « Activer » on its card. */
async function enabledByAgent(w: Launched, id: string, name: string): Promise<string> {
  const call = w.call("request_extension", { id });
  expect(await waitUi<string>(w.marionette, `return doc.querySelector(${JSON.stringify(CARD)})?.textContent`, [], 15_000)).toContain(name);
  await click(w.marionette, `${CARD} button`, { text: "Activer" });
  return (await call).text;
}
/** extension_console until it contains `expected`. */
async function consoleUntil(w: Launched, id: string, expected: string): Promise<string> {
  let text = "";
  for (const deadline = Date.now() + 20_000; !text.includes(expected); await new Promise((r) => setTimeout(r, 200))) {
    if (Date.now() > deadline) throw new Error(`extension_console never said ${JSON.stringify(expected)}: ${text}`);
    text = (await w.call("extension_console", { id })).text;
  }
  return text;
}

describe("the Extensions page", () => {
  // extensions-interface.spec.ts:545
  it("lists source, the agent's version (without the counter), rights, sites and spaces; Détails opens", async () => {
    const w = await launch({ prepare: (root, dataDir) => (writeAgentExtension(root, "cacheur", HIDER), grant(dataDir, "cacheur", GRANT)) });
    const m = w.marionette;
    await waitActive(m, "cacheur@agent.webaios", true);
    expect((await agentAddons(m))[0]!.version).toBe("1.2.0.1");
    await openPage(m);
    await waitRow(m, "Cacheur de l'agent", true);
    const text = (await row(m, "Cacheur de l'agent"))!;
    expect(text).toContain("Écrite par l'agent · 1.2");
    expect(text).not.toContain("1.2.0.1");
    expect(text).toContain("Droits : ");
    expect(text).toContain(`Sites : ${HOST}`);
    expect(text).toContain(`« ${(await activeSpace(m)).name} » (profil defaut)`);
    await rowButton(m, "Cacheur de l'agent", "Détails");
    await waitUi(m, `return !!doc.querySelector('${LINE} [data-testid="details-extension"]')`);
    expect(await missingApi(m)).toEqual([]);
  });

  it("the strip's menu opens the page; Gérer les extensions still opens about:addons", async () => {
    const w = await launch();
    const m = w.marionette;
    await openPage(m);
    expect(Object.values((await state(m)).tabs).map((o) => o.url)).toContain("webaios://extensions");
    expect(await inUi(m, `return doc.querySelector(${JSON.stringify(PAGE)}).textContent`)).toContain("Aucune extension.");
    await fromStrip(m, "Gérer les extensions");
    await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec", (v) => typeof v === "string" && v.startsWith("about:addons"));
    expect(await missingApi(m)).toEqual([]);
  });

  // extensions-interface.spec.ts:577
  it("« Désactiver toutes les extensions »: the agent's add-ons disabled, still after a restart; unticked, they run again", async () => {
    const first = await launch({ prepare: (root, dataDir) => (writeAgentExtension(root, "cacheur", HIDER), grant(dataDir, "cacheur", GRANT)) });
    let m = first.marionette;
    await waitActive(m, "cacheur@agent.webaios", true);
    await openPage(m);
    await click(m, '[data-testid="couper-extensions"]');
    await waitUi(m, `return doc.querySelector('[data-testid="couper-extensions"]').checked`);
    await waitActive(m, "cacheur@agent.webaios", false);
    expect(registry(first.dataDir).allCut).toBe(true);
    // Disabled, never uninstalled (decision 4): its grant stays.
    expect(registry(first.dataDir).extensions["agent:cacheur"]?.profiles).toEqual(["defaut"]);
    await first.close();

    const w = await launch({ dirs: { dataDir: first.dataDir, profile: first.profile } });
    m = w.marionette;
    await m.execute(`return (async () => { await (await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready).agentExtensions.ready; })();`);
    expect((await agentAddons(m)).filter((a) => a.isActive)).toEqual([]);
    await openPage(m);
    await waitUi(m, `return doc.querySelector('[data-testid="couper-extensions"]')?.checked`);
    await waitRow(m, "Cacheur de l'agent", true);
    await click(m, '[data-testid="couper-extensions"]');
    await waitActive(m, "cacheur@agent.webaios", true);
    expect(registry(w.dataDir).allCut).toBe(false);
  });

  it("Désactiver partout keeps its storage: granted again, it reads what it wrote", async () => {
    const w = await launch({ agent: true });
    const m = w.marionette;
    writeAgentExtension(w.root, "memoire", MEMORY);
    expect(await enabledByAgent(w, "memoire", "Mémoire de l'agent")).toMatch(/^Activée/);
    await consoleUntil(w, "memoire", "lu:{}");
    await openPage(m);
    await rowButton(m, "Mémoire de l'agent", "Désactiver partout");
    await waitActive(m, "memoire@agent.webaios", false);
    expect(registry(w.dataDir).extensions["agent:memoire"]?.profiles).toEqual([]);
    await waitRow(m, "Mémoire de l'agent", true);
    expect(await row(m, "Mémoire de l'agent")).toContain("Espaces : Active nulle part");
    expect(await enabledByAgent(w, "memoire", "Mémoire de l'agent")).toMatch(/^Activée/);
    await waitActive(m, "memoire@agent.webaios", true);
    await consoleUntil(w, "memoire", 'lu:{"k":"gardé"}');
  });

  it("Supprimer uninstalls it and wipes its storage; the agent folder stays", async () => {
    const w = await launch({ agent: true });
    const m = w.marionette;
    writeAgentExtension(w.root, "memoire", MEMORY);
    expect(await enabledByAgent(w, "memoire", "Mémoire de l'agent")).toMatch(/^Activée/);
    await consoleUntil(w, "memoire", "lu:{}");
    await openPage(m);
    await remove(m, "Mémoire de l'agent");
    await waitRow(m, "Mémoire de l'agent", false);
    expect(await agentAddons(m)).toEqual([]);
    expect("agent:memoire" in registry(w.dataDir).extensions).toBe(false);
    expect(existsSync(path.join(w.root, "extensions", "memoire", "manifest.json"))).toBe(true);
    expect(existsSync(path.join(w.dataDir, "extensions", "copies", "memoire"))).toBe(false);
    // Granted again: a fresh storage, and the next version number (amo-versions.json is never cleared).
    expect(await enabledByAgent(w, "memoire", "Mémoire de l'agent")).toMatch(/^Activée/);
    await waitActive(m, "memoire@agent.webaios", true);
    expect((await agentAddons(m))[0]!.version).toBe("1.0.0.2");
    expect(await consoleUntil(w, "memoire", "lu:")).not.toContain("gardé");
  });

  // extensions-agent.spec.ts:1210, with the page open before: the unlock's start and end refresh it.
  it("says « Console débloquée pour l'agent »; « Couper le déblocage » and lock_console close it", async () => {
    const w = await launch({ agent: true });
    const m = w.marionette;
    writeAgentExtension(w.root, "journal", LOG);
    expect(await enabledByAgent(w, "journal", "Journal de l'agent")).toMatch(/^Activée/);
    await openTab(m, `${server.url}/a.html`);
    await consoleUntil(w, "journal", HIDDEN);
    await openPage(m);
    await waitRow(m, "Journal de l'agent", true);
    const unlock = async () => {
      const call = w.call("unlock_console", { id: "journal", reason: "r" });
      await click(m, `${UNLOCK} button`, { text: "Débloquer" });
      expect((await call).text).toContain("Console débloquée");
      await waitUi(m, `return doc.querySelector('${LINE} [data-testid="console-debloquee"]')?.textContent === "Console débloquée pour l'agent"`);
    };
    const closed = () => waitUi(m, `return !doc.querySelector('${LINE} [data-testid="console-debloquee"]')`);
    await unlock();
    await rowButton(m, "Journal de l'agent", "Couper le déblocage");
    await closed();
    expect((await w.call("extension_console", { id: "journal" })).text).not.toContain("contenu:/a.html");
    await unlock();
    expect((await w.call("lock_console", { id: "journal" })).text).toContain("refermée");
    await closed();
  });
});

describe("list_extensions", () => {
  it("lists an AMO add-on with source store", async () => {
    const w = await launch({ agent: true });
    const m = w.marionette;
    const id = await installAddon(m, button());
    const space = (await activeSpace(m)).name;
    expect((await w.call("list_extensions")).text).toContain(`store:${id} · Bouton de test · 1.0 · store · actives dans : ${space} · erreurs : aucune`);
    // Never on the page, which lists the agent's extensions only.
    await openPage(m);
    await waitUi(m, `return doc.querySelector(${JSON.stringify(PAGE)}).textContent.includes("Aucune extension.")`);
  });
});

describe("crashes", () => {
  /** Waits until the page's row for `nom` says it was disabled for its crashes, then « Réactiver » brings it back. */
  async function disabledThenReactivated(w: Launched, id: string, name: string): Promise<void> {
    const m = w.marionette;
    await waitActive(m, `${id}@agent.webaios`, false);
    expect(registry(w.dataDir).extensions[`agent:${id}`]).toMatchObject({ profiles: ["defaut"], disabled: { reason: "crashes" } });
    expect((await w.call("list_extensions")).text).toContain(DISABLED_CRASHES);
    await openPage(m);
    await waitRow(m, name, true);
    expect(await row(m, name)).toContain(DISABLED_CRASHES);
    await rowButton(m, name, "Réactiver");
    await waitActive(m, `${id}@agent.webaios`, true);
    expect(registry(w.dataDir).extensions[`agent:${id}`]).toMatchObject({ profiles: ["defaut"], disabled: null });
    await waitUi(m, `return ![...doc.querySelectorAll(arguments[0])].some((l) => l.textContent.includes(arguments[1]))`, [LINE, DISABLED_CRASHES]);
  }

  it("a background that throws at load three times is disabled", { timeout: 120_000 }, async () => {
    const w = await launch({ agent: true });
    writeAgentExtension(w.root, "cassee", BROKEN);
    // Each load's error, seen in its console before the next load: one crash each.
    const loads = async (n: number) => {
      for (const deadline = Date.now() + 20_000; ; await new Promise((r) => setTimeout(r, 200))) {
        const text = (await w.call("extension_console", { id: "cassee" })).text;
        if (text.split("fond-casse-au-chargement").length - 1 >= n) return;
        if (Date.now() > deadline) throw new Error(`fewer than ${n} load errors: ${text}`);
      }
    };
    expect(await enabledByAgent(w, "cassee", "Fond cassé")).toMatch(/^Activée/);
    await loads(1);
    expect((await w.call("reload_extension", { id: "cassee" })).text).toBe("state : reloaded");
    await loads(2);
    expect(registry(w.dataDir).extensions["agent:cassee"]?.disabled).toBeNull();
    expect((await w.call("reload_extension", { id: "cassee" })).text).toBe("state : reloaded");
    await disabledThenReactivated(w, "cassee", "Fond cassé");
  });

  it("a module background's popup that throws in its first second is no crash", { timeout: 120_000 }, async () => {
    const w = await launch({ agent: true });
    writeAgentExtension(w.root, "popup", BROKEN_POPUP);
    const errors = async (n: number) => {
      for (const deadline = Date.now() + 20_000; ; await new Promise((r) => setTimeout(r, 200))) {
        const text = (await w.call("extension_console", { id: "popup" })).text;
        if (text.split("popup-cassee").length - 1 >= n) return;
        if (Date.now() > deadline) throw new Error(`fewer than ${n} popup errors: ${text}`);
      }
    };
    expect(await enabledByAgent(w, "popup", "Popup cassée")).toMatch(/^Activée/);
    await errors(1);
    for (let n = 2; n <= 3; n++) {
      expect((await w.call("reload_extension", { id: "popup" })).text).toBe("state : reloaded");
      await errors(n);
    }
    // Time for a crash count to reach the kernel.
    await new Promise((r) => setTimeout(r, 1000));
    expect(registry(w.dataDir).extensions["agent:popup"]?.disabled).toBeNull();
    expect(await agentAddons(w.marionette)).toEqual([expect.objectContaining({ id: "popup@agent.webaios", isActive: true })]);
  });

  it("a background that hangs the extension process: killed, and the third time disabled", { timeout: 150_000 }, async () => {
    // Three kills must fit in a minute: 3 s windows here instead of 10 s.
    const w = await launch({ agent: true, env: { WEBAIOS_TEST_WATCHDOG_MS: "3000" } });
    const m = w.marionette;
    writeAgentExtension(w.root, "boucle", LOOP);
    const extensionProcess = () => m.execute<number | null>(`return ChromeUtils.getAllDOMProcesses().find((p) => p.remoteType === "extension")?.childID ?? null`);
    /** The hung extension process is killed by the watchdog (two missed windows), and a new one replaces it. */
    const killed = async () => {
      const before = await extensionProcess();
      await waitFor(m, `return ChromeUtils.getAllDOMProcesses().find((p) => p.remoteType === "extension")?.childID ?? null`, (v) => v !== null && v !== before, 30_000);
    };
    expect(await enabledByAgent(w, "boucle", "Fond qui boucle")).toMatch(/^Activée/);
    await killed();
    expect((await w.call("reload_extension", { id: "boucle" })).text).toBe("state : reloaded");
    await killed();
    expect((await w.call("reload_extension", { id: "boucle" })).text).toBe("state : reloaded");
    await killed();
    await disabledThenReactivated(w, "boucle", "Fond qui boucle");
  });
});
