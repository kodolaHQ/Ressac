import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import { writeAgentExtension } from "./extensions/fixtures";
import { CONSOLE_BACKGROUND_HIDDEN, OBSERVED_BACKGROUND_CONSOLE, EXTENSION_CONSOLE_PREFIX } from "../../../packages/kernel/src/index";
import { deniedSignature } from "../host/extensions/amo";
import { agentAddons, launchWithAmo, openTab } from "./agent-extensions";
import { dispatch, newWindow, state, waitFor, waitWindowCount } from "./firefox";
import type { LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { click, inUi, pressKeys, waitUi, agentPanelReady } from "./ui";

// The agent's extension tools and their card (posed straight through the store's Questions; its answer is written to a file).
const MODAL = '[data-testid="request-modal"]';
const CARD = '[data-testid="extension-request"]';
const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const HOST = "http://127.0.0.1/*";
const PRIVATE_PROFILE_ERROR = "Donne à cet espace privé son propre profil pour y utiliser des extensions de l'agent";
const BACKGROUND_ONLY = {
  "manifest.json": { manifest_version: 3, name: "Fond de l'agent", version: "1.0.0", background: { service_worker: "fond.js" } },
  "fond.js": 'console.log("fond démarré");\n',
};
/** A background and a content script on HOTE that both write to the console. */
const LOG = {
  "manifest.json": { manifest_version: 3, name: "Journal de l'agent", version: "1.0.0", background: { service_worker: "fond.js" }, content_scripts: [{ matches: [HOST], js: ["contenu.js"] }] },
  "fond.js": 'console.log("fond démarré");\n',
  "contenu.js": 'console.log("contenu:" + location.pathname);\n',
};
const HIDDEN = "message(s) masqué(s) : venus d'onglets que tu ne peux pas lire";
const UNLOCK = '[data-testid="extension-console-request"]';
const hider = (matches: string[]) => ({ manifest_version: 3, name: "Cacheur de l'agent", version: "1.0.0", content_scripts: [{ matches, css: ["cache.css"] }] });

const dirs: string[] = [];
const opened: LaunchedRessac[] = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Ressac with the fake AMO, the agent's session started (a new conversation takes down the cards asked before it). */
async function launch(o: { amo?: Parameters<typeof launchWithAmo>[0]["amo"]; env?: Record<string, string> } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ressac-data-"));
  const profile = mkdtempSync(path.join(os.tmpdir(), "ressac-firefox-"));
  dirs.push(dataDir, profile);
  const w = await launchWithAmo({ dataDir, profile, ...o });
  opened.push(w);
  const config = path.join(dataDir, "workspace", ".ressac", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  await agentPanelReady(w.marionette);
  return { ...w, root: path.join(dataDir, "workspace"), call: (name: string, args: Record<string, unknown> = {}) => callTool(dataDir, name, args) };
}

const cardText = (m: Marionette) => waitUi<string>(m, `return doc.querySelector(${JSON.stringify(CARD)})?.textContent`, [], 15_000);
const cardGone = (m: Marionette) => waitUi(m, `return !doc.querySelector(${JSON.stringify(MODAL)})`);
const enable = (m: Marionette) => click(m, `${CARD} button`, { text: "Activer" });
const registry = (dataDir: string) => {
  const f = path.join(dataDir, "extensions", "state.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { extensions: Record<string, unknown> }).extensions : {};
};
const waitAddon = (m: Marionette, id: string, version: string) =>
  waitFor(m, `return (async () => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const a = await AddonManager.getAddonByID(${JSON.stringify(id)});
    return a && a.isActive ? a.version : null;
  })();`, (v) => v === version, 30_000);
/** request_extension, then « Activer » on its card once it names the extension. */
async function enabledByAgent(w: Awaited<ReturnType<typeof launch>>, id: string, name: string): Promise<string> {
  const call = w.call("request_extension", { id });
  expect(await cardText(w.marionette)).toContain(name);
  await enable(w.marionette);
  return (await call).text;
}

/** extension_console until it contains `expected`. */
async function consoleUntil(w: { call: (n: string, a: Record<string, unknown>) => Promise<{ text: string }> }, id: string, expected: string): Promise<string> {
  let text = "";
  for (const deadline = Date.now() + 15_000; !text.includes(expected); await new Promise((r) => setTimeout(r, 200))) {
    if (Date.now() > deadline) throw new Error(`extension_console never said ${JSON.stringify(expected)}: ${text}`);
    text = (await w.call("extension_console", { id })).text;
  }
  return text;
}

describe("the agent's tools and their card", () => {
  it("request_extension shows the card; Activer: signed, installed, « Activée » ; list_extensions shows it active", async () => {
    const w = await launch();
    writeAgentExtension(w.root, "fond", BACKGROUND_ONLY);
    expect(await enabledByAgent(w, "fond", "Fond de l'agent")).toMatch(/^Activée dans « .+ »\.$/);
    expect(await agentAddons(w.marionette)).toEqual([{ id: "fond@agent.ressac", version: "1.0.0.1", isActive: true }]);
    await cardGone(w.marionette);
    expect((await w.call("list_extensions")).text).toMatch(/^agent:fond · Fond de l'agent · 1\.0\.0 · agent · actives dans : [^·]+ · erreurs : aucune$/m);
    // extension_console gives its background's console.log.
    const text = await consoleUntil(w, "fond", "fond démarré");
    expect(text.startsWith(EXTENSION_CONSOLE_PREFIX)).toBe(true);
    expect((await w.call("extension_console", { id: `store:${"a".repeat(32)}` })).text).toBe("Réservé aux extensions que tu as écrites.");
  });

  it("request_extension in a private space: refused without a card", async () => {
    const w = await launch();
    const m = w.marionette;
    writeAgentExtension(w.root, "fond", BACKGROUND_ONLY);
    const s = await state(m);
    const e = s.spaces.find((x) => x.id === s.windows[0]!.activeSpace)!;
    await dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: true, profile: e.profile } as Action);
    expect((await w.call("request_extension", { id: "fond" })).text).toBe(PRIVATE_PROFILE_ERROR);
    expect(await inUi(m, `return !!doc.querySelector(${JSON.stringify(MODAL)})`)).toBe(false);
    expect(w.amo.sends).toEqual([]);
  });

  it("changed with a new site, reload_extension disables it and says to call request_extension; the card comes back", async () => {
    const w = await launch();
    writeAgentExtension(w.root, "cacheur", { "manifest.json": hider([HOST]), "cache.css": "#cache-moi { display: none !important; }\n" });
    await enabledByAgent(w, "cacheur", "Cacheur de l'agent");
    writeAgentExtension(w.root, "cacheur", { "manifest.json": hider([HOST, "https://exemple.com/*"]) });
    const r = (await w.call("reload_extension", { id: "cacheur" })).text;
    expect(r).toContain("state : disabled");
    expect(r).toContain("Désactivée : elle demande plus de droits qu'accordé");
    expect(r).toContain("request_extension");
    await waitFor(w.marionette, `return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      return (await AddonManager.getAddonByID("cacheur@agent.ressac"))?.isActive;
    })();`, (v) => v === false);
    expect(await enabledByAgent(w, "cacheur", "Cacheur de l'agent")).toMatch(/^Activée dans « .+ »\.$/);
    await waitAddon(w.marionette, "cacheur@agent.ressac", "1.0.0.2");
    expect((await w.call("list_extensions")).text).toMatch(/^agent:cacheur · Cacheur de l'agent · 1\.0\.0 · agent · actives dans : [^·]+ · /m);
  });

  it("changed without a new right: reload_extension reloads it without a card, at the next version", async () => {
    const w = await launch();
    writeAgentExtension(w.root, "cacheur", { "manifest.json": hider([HOST]), "cache.css": "#cache-moi { display: none !important; }\n" });
    await enabledByAgent(w, "cacheur", "Cacheur de l'agent");
    await cardGone(w.marionette);
    writeAgentExtension(w.root, "cacheur", { "cache.css": "#cache-moi, #reste { display: none !important; }\n" });
    expect((await w.call("reload_extension", { id: "cacheur" })).text).toBe("state : reloaded");
    expect(await inUi(w.marionette, `return !!doc.querySelector(${JSON.stringify(MODAL)})`)).toBe(false);
    await waitAddon(w.marionette, "cacheur@agent.ressac", "1.0.0.2");
  });

  it("AMO refuses: the agent gets AMO's message; nothing installed", async () => {
    const w = await launch({ amo: { denial: "Validation failed: eval" } });
    writeAgentExtension(w.root, "fond", BACKGROUND_ONLY);
    const r = await enabledByAgent(w, "fond", "Fond de l'agent");
    expect(r).toBe(deniedSignature("Validation failed: eval"));
    expect(r).not.toContain("test-secret");
    expect(await agentAddons(w.marionette)).toEqual([]);
    expect(registry(w.dataDir)).toEqual({});
  });
});

describe("the grant card", () => {
  /**
   * A card in the current window for its active space (or `espaceId`), posed through the store; `reponse()` is its
   * GrantResponse once answered (written to a file: the window may be gone by then).
   */
  async function withCard(overrides: Record<string, unknown> = {}, w?: Awaited<ReturnType<typeof launch>>) {
    w ??= await launch();
    const m = w.marionette;
    const s = await state(m);
    const win = await m.execute<string>("return window.ressacWindow.windowId");
    const space = s.spaces.find((e) => e.id === (overrides.spaceId ?? s.windows.find((f) => f.id === win)!.activeSpace))!;
    const card = {
      key: "agent:essai", name: "Essai", source: "agent", version: "1.0.0", rights: ["Modifier l'apparence et le contenu des pages"],
      sites: ["https://exemple.com/*"], allSites: false, network: [], hardened: false, space: space.name, spaceId: space.id,
      otherSpaces: [], alsoReplaces: [], update: null, hash: "0".repeat(64), ...overrides,
    };
    const file = path.join(w.dataDir, "reponse.json");
    await m.execute(
      `return (async () => {
        const s = await ChromeUtils.importESModule("${STORE}").ready;
        s.questions.askExtension(JSON.parse(arguments[0]), arguments[1]).then((r) => IOUtils.writeUTF8(arguments[2], JSON.stringify(r)));
      })();`,
      [JSON.stringify(card), win, file],
    );
    const response = () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { accepted: boolean; removed?: boolean }) : null);
    const wait = async () => {
      for (const deadline = Date.now() + 10_000; !response(); await new Promise((r) => setTimeout(r, 100)))
        if (Date.now() > deadline) throw new Error("no answer");
      return response()!;
    };
    await cardText(m);
    return { ...w, m, answer: response, wait: wait };
  }
  /** The card has the keyboard and Enter is armed. */
  const armed = (m: Marionette) =>
    waitUi(m, `return !!doc.querySelector('${MODAL}[data-armed]') && !!doc.activeElement?.closest('${MODAL}') && document.activeElement?.id === "ressac-sidebar"`);

  it("an agent card without network says « Elle ne peut rien envoyer vers internet. »", async () => {
    const { m, wait } = await withCard({ otherSpaces: ["Lecture"], alsoReplaces: ["Travail", "Achats"] });
    const c = await cardText(m);
    expect(await inUi(m, `return doc.querySelector('[data-testid="extension-card-replaces"]').textContent`)).toBe(
      "La nouvelle version remplacera aussi celle de « Travail », « Achats ».",
    );
    for (const t of [
      "Écrite par l'agent",
      "Ce qu'elle veut faire :",
      "Modifier l'apparence et le contenu des pages",
      "Sur : https://exemple.com/*",
      "Elle sera active aussi dans « Lecture » (même profil).",
      "Elle ne peut rien envoyer vers internet.",
      "Ses scripts tournent dans les pages : ils pourraient faire charger une ressource à la page",
      "L'agent ne voit pas ce que cette extension lit sur les onglets que vous ne lui avez pas partagés.",
    ])
      expect(c).toContain(t);
    expect(c).toMatch(/Activer\s*« Essai »\s*dans « .+ » \?/);
    expect(c).not.toContain("l'agent pourra voir");
    expect(await inUi(m, `return doc.querySelectorAll('[data-testid="extension-card-all-sites"], [data-testid="extension-card-confirm"]').length`)).toBe(0);
    await enable(m);
    expect((await wait()).accepted).toBe(true);
    await cardGone(m);
  });

  it("renforcée: Activer does nothing until the box is ticked; a « yes » without it is refused", async () => {
    const { m, answer: response, wait } = await withCard({ hardened: true, allSites: true, sites: ["<all_urls>"] });
    expect(await cardText(m)).toContain("Je comprends : elle lira toutes les pages de cet espace");
    expect(await inUi(m, `return [...doc.querySelectorAll('${CARD} button')].find((b) => b.textContent.includes("Activer")).disabled`)).toBe(true);
    await enable(m);
    await new Promise((r) => setTimeout(r, 300));
    expect(response()).toBeNull();
    // A « yes » sent without the box (a compromised or buggy UI): refused.
    await m.execute(`return (async () => {
      const s = await ChromeUtils.importESModule("${STORE}").ready;
      s.questions.answer(s.questions.pending()[0].id, "allow");
    })();`);
    expect((await wait()).accepted).toBe(false);
  });

  it("renforcée: the box ticked, Activer activates", async () => {
    const { m, wait } = await withCard({ hardened: true, allSites: true, sites: ["<all_urls>"] });
    await click(m, '[data-testid="extension-card-confirm"]');
    await waitUi(m, `return doc.querySelector('[data-testid="extension-card-confirm"]').checked`);
    await enable(m);
    expect((await wait()).accepted).toBe(true);
  });

  it("an address card shows what sensitive data the address carries, as an alert", async () => {
    const w = await launch();
    const m = w.marionette;
    const win = await m.execute<string>("return window.ressacWindow.windowId");
    await m.execute(
      `return (async () => {
        const s = await ChromeUtils.importESModule("${STORE}").ready;
        s.questions.askAddress(JSON.parse(arguments[0]), arguments[1]);
      })();`,
      [JSON.stringify({ url: "https://exemple.com/?q=FR76", reason: "test", agent: "A", danger: "Contient un IBAN, lu dans ta banque : FR76••••0189" }), win],
    );
    await waitUi(m, `return !!doc.querySelector('[data-testid="address-request-danger"]')`);
    expect(await inUi(m, `const d = doc.querySelector('[data-testid="address-request-danger"]'); return [d.textContent, d.getAttribute("role")]`)).toEqual([
      "⚠ Contient un IBAN, lu dans ta banque : FR76••••0189", "alert",
    ]);
  });

  it("Enter refuses an extension card, even renforcée and ticked", async () => {
    const { m, wait } = await withCard({ hardened: true, allSites: true, sites: ["<all_urls>"] });
    await click(m, '[data-testid="extension-card-confirm"]');
    await waitUi(m, `return doc.querySelector('[data-testid="extension-card-confirm"]').checked`);
    await armed(m);
    await pressKeys(m, "Enter");
    expect((await wait()).accepted).toBe(false);
    await cardGone(m);
  });

  it("Escape refuses", async () => {
    const { m, wait } = await withCard();
    await armed(m);
    await pressKeys(m, "Escape");
    expect((await wait()).accepted).toBe(false);
    await cardGone(m);
  });

  it("the card's window closes: the card moves to another window; no window left: refused", async () => {
    const { m, answer: response, wait } = await withCard();
    const first = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    const second = await newWindow(m);
    await m.command("WebDriver:SwitchToWindow", { handle: second, focus: false });
    expect(await inUi(m, `return !!doc.querySelector(${JSON.stringify(CARD)})`)).toBe(false);
    await m.command("WebDriver:SwitchToWindow", { handle: first, focus: false });
    await m.execute("window.close()");
    await waitWindowCount(m, 1);
    await m.command("WebDriver:SwitchToWindow", { handle: second, focus: false });
    await cardText(m);
    expect(response()).toBeNull();
    await m.execute("window.close()");
    expect(await wait()).toMatchObject({ accepted: false, removed: true });
  });

  it("a card gone stale (space deleted) falls and counts as a refusal", async () => {
    const w = await launch();
    const windowId = await w.marionette.execute<string>("return window.ressacWindow.windowId");
    const reading = (await dispatch(w.marionette, { type: "createSpace", name: "Lecture", icon: "📚", private: false, profile: "default", windowId: windowId } as Action)).spaces.at(-1)!;
    const { m, wait } = await withCard({ spaceId: reading.id }, w);
    await dispatch(m, { type: "deleteSpace", id: reading.id } as Action);
    expect(await wait()).toMatchObject({ accepted: false, removed: true });
    await cardGone(m);
  });
});

describe("the console", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => (server = await startServer()));
  afterAll(() => server?.close());

  /** The journal granted by its card, then a.html opened in a tab of the user's (not shared): its script writes there. */
  async function logInAnUnsharedTab() {
    // The server's port as the agent's app range: a tab the agent opens there is its own, readable.
    const w = await launch({ env: { RESSAC_CONTAINER_PORTS: `${server.port}-${server.port}` } });
    writeAgentExtension(w.root, "journal", LOG);
    expect(await enabledByAgent(w, "journal", "Journal de l'agent")).toMatch(/^Activée dans « .+ »\.$/);
    await cardGone(w.marionette);
    await openTab(w.marionette, `${server.url}/a.html`);
    await consoleUntil(w, "journal", HIDDEN);
    return w;
  }
  /** unlock_console, then « Débloquer » on its card. */
  async function unlock(w: Awaited<ReturnType<typeof launch>>, id: string) {
    const call = w.call("unlock_console", { id, reason: "r" });
    await waitUi(w.marionette, `return !!doc.querySelector(${JSON.stringify(UNLOCK)})`, [], 15_000);
    await click(w.marionette, `${UNLOCK} button`, { text: "Débloquer" });
    expect((await call).text).toContain("Console débloquée");
  }

  it("extension_console leaves out a content script's console.log in an unshared tab, and counts it", async () => {
    const w = await logInAnUnsharedTab();
    let text = (await w.call("extension_console", { id: "journal" })).text;
    expect(text).not.toContain("contenu:/a.html");
    // It ran in an unshared tab: its background is masked too.
    expect(text).toContain(CONSOLE_BACKGROUND_HIDDEN);
    expect(text).not.toContain("fond démarré");
    // A tab the agent opens itself is readable: its message passes, the other stays masked.
    await w.call("open_tab", { url: `${server.url}/b.html` });
    text = await consoleUntil(w, "journal", "contenu:/b.html");
    expect(text).not.toContain("contenu:/a.html");
    expect(text).toMatch(/^1 message\(s\) masqué\(s\)/m);
    // A reload does not reset the masking (its storage may have kept what it read).
    expect((await w.call("reload_extension", { id: "journal" })).text).toBe("state : reloaded");
    expect((await w.call("extension_console", { id: "journal" })).text).toContain(CONSOLE_BACKGROUND_HIDDEN);
  });

  it("unlock_console granted → whole; lock_console → masked again", async () => {
    const w = await logInAnUnsharedTab();
    const m = w.marionette;
    const call = w.call("unlock_console", { id: "journal", reason: "le script de contenu ne trouve pas le bouton" });
    const card = await waitUi<string>(m, `return doc.querySelector(${JSON.stringify(UNLOCK)})?.textContent`, [], 15_000);
    const s = await state(m);
    const space = s.spaces.find((e) => e.id === s.windows[0]!.activeSpace)!.name;
    expect(card).toContain(
      `L'agent demande à voir toute la console de « Journal de l'agent » pour la corriger. Il verra ce que l'extension écrit dans sa console sur tous les onglets de l'espace « ${space} », y compris ceux que vous ne partagez pas. Jusqu'à ce que vous le coupiez ou qu'il ait fini.`,
    );
    expect(card).toContain("le script de contenu ne trouve pas le bouton");
    // Refuser is the default button (Enter).
    expect(await inUi(m, `return [...doc.querySelectorAll('${UNLOCK} button')].find((b) => b.textContent.includes("Refuser")).hasAttribute("data-main")`)).toBe(true);
    await click(m, `${UNLOCK} button`, { text: "Débloquer" });
    expect((await call).text).toContain("Console débloquée");
    let text = await consoleUntil(w, "journal", "contenu:/a.html");
    expect(text).toContain("fond démarré");
    expect(text).not.toContain("message(s) masqué(s)");
    expect(text).not.toContain(CONSOLE_BACKGROUND_HIDDEN);
    expect((await w.call("lock_console", { id: "journal" })).text).toContain("refermée");
    text = (await w.call("extension_console", { id: "journal" })).text;
    expect(text).not.toContain("contenu:/a.html");
    expect(text).toContain("message(s) masqué(s)");
  });

  it("with a right that observes tabs (hosts), its background's console is always masked, even without an unshared tab, and the tool says why; unlocked, it passes", async () => {
    const w = await launch();
    writeAgentExtension(w.root, "veilleur", {
      "manifest.json": { manifest_version: 3, name: "Veilleur de l'agent", version: "1.0.0", host_permissions: [HOST], background: { service_worker: "fond.js" } },
      "fond.js": 'setInterval(() => console.log("tic du fond"), 300);\n',
    });
    expect(await enabledByAgent(w, "veilleur", "Veilleur de l'agent")).toMatch(/^Activée/);
    await cardGone(w.marionette);
    await consoleUntil(w, "veilleur", OBSERVED_BACKGROUND_CONSOLE);
    await new Promise((r) => setTimeout(r, 1000));
    const text = (await w.call("extension_console", { id: "veilleur" })).text;
    expect(text).not.toContain("tic du fond");
    expect(text).toContain("unlock_console");
    await unlock(w, "veilleur");
    await consoleUntil(w, "veilleur", "tic du fond");
  });

  it("removed then recreated in the same place: nothing of its old storage, and its console stays masked (it ran in an unshared tab)", async () => {
    const w = await launch();
    const m = w.marionette;
    writeAgentExtension(w.root, "journal", {
      ...LOG,
      "manifest.json": { ...LOG["manifest.json"], permissions: ["storage"] },
      "fond.js": `chrome.storage.local.set({ k: "secret-local" });
const r = indexedDB.open("b", 1);
r.onupgradeneeded = () => r.result.createObjectStore("s");
r.onsuccess = () => { const t = r.result.transaction("s", "readwrite"); t.objectStore("s").put("secret-idb", "k"); t.oncomplete = () => console.log("écrit"); };
`,
    });
    expect(await enabledByAgent(w, "journal", "Journal de l'agent")).toMatch(/^Activée/);
    await cardGone(m);
    await openTab(m, `${server.url}/a.html`);
    await consoleUntil(w, "journal", HIDDEN);
    // Removed from about:addons: « Supprimer » (decision 6).
    await m.execute(`return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      await (await AddonManager.getAddonByID("journal@agent.ressac")).uninstall();
    })();`);
    for (const deadline = Date.now() + 15_000; "agent:journal" in registry(w.dataDir); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > deadline) throw new Error("not removed");
    // Recreated in the same place, without content script nor site: it reads what would be left.
    rmSync(path.join(w.root, "extensions", "journal"), { recursive: true, force: true });
    writeAgentExtension(w.root, "journal", {
      "manifest.json": { manifest_version: 3, name: "Journal de l'agent", version: "2.0.0", permissions: ["storage"], background: { service_worker: "fond.js" } },
      "fond.js": `(async () => {
  const l = await chrome.storage.local.get(null);
  const idb = await new Promise((ok) => { const r = indexedDB.open("b", 1); r.onupgradeneeded = () => r.result.createObjectStore("s"); r.onsuccess = () => { const g = r.result.transaction("s").objectStore("s").get("k"); g.onsuccess = () => ok(g.result ?? null); }; });
  console.log("lu:" + JSON.stringify({ l, idb }));
})();
`,
    });
    expect(await enabledByAgent(w, "journal", "Journal de l'agent")).toMatch(/^Activée/);
    await cardGone(m);
    // Its console stays masked: the old one ran in an unshared tab (same add-on id).
    expect(await consoleUntil(w, "journal", CONSOLE_BACKGROUND_HIDDEN)).not.toContain("lu:");
    // Unlocked: what it read, nothing of the old one.
    await unlock(w, "journal");
    expect(await consoleUntil(w, "journal", 'lu:{"l":{},"idb":null}')).not.toContain("secret");
  });
});
