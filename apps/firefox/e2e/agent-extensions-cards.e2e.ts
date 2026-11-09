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
import type { LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { click, inUi, pressKeys, waitUi } from "./ui";

// The agent's extension tools and their card (posed straight through the store's Questions; its answer is written to a file).
const MODAL = '[data-testid="modale-demande"]';
const CARD = '[data-testid="demande-extension"]';
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
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
const UNLOCK = '[data-testid="demande-console-extension"]';
const hider = (matches: string[]) => ({ manifest_version: 3, name: "Cacheur de l'agent", version: "1.0.0", content_scripts: [{ matches, css: ["cache.css"] }] });

const dirs: string[] = [];
const opened: LaunchedWebAiOs[] = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** WebAiOs with the fake AMO, the agent's session started (a new conversation takes down the cards asked before it). */
async function launch(o: { amo?: Parameters<typeof launchWithAmo>[0]["amo"] } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "webaios-data-"));
  const profile = mkdtempSync(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  const w = await launchWithAmo({ dataDir, profile, ...o });
  opened.push(w);
  const config = path.join(dataDir, "espace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the noyau did not write its MCP config");
  await waitUi(w.marionette, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
  return { ...w, racine: path.join(dataDir, "espace"), call: (name: string, args: Record<string, unknown> = {}) => callTool(dataDir, name, args) };
}

const cardText = (m: Marionette) => waitUi<string>(m, `return doc.querySelector(${JSON.stringify(CARD)})?.textContent`, [], 15_000);
const cardGone = (m: Marionette) => waitUi(m, `return !doc.querySelector(${JSON.stringify(MODAL)})`);
const enable = (m: Marionette) => click(m, `${CARD} button`, { text: "Activer" });
const registry = (dataDir: string) => {
  const f = path.join(dataDir, "extensions", "etat.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { extensions: Record<string, unknown> }).extensions : {};
};
const waitAddon = (m: Marionette, id: string, version: string) =>
  waitFor(m, `return (async () => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const a = await AddonManager.getAddonByID(${JSON.stringify(id)});
    return a && a.isActive ? a.version : null;
  })();`, (v) => v === version, 30_000);
/** demander_extension, then « Activer » on its card once it names the extension. */
async function enabledByAgent(w: Awaited<ReturnType<typeof launch>>, id: string, name: string): Promise<string> {
  const call = w.call("demander_extension", { id });
  expect(await cardText(w.marionette)).toContain(name);
  await enable(w.marionette);
  return (await call).texte;
}

/** console_extension until it contains `expected`. */
async function consoleUntil(w: { call: (n: string, a: Record<string, unknown>) => Promise<{ texte: string }> }, id: string, expected: string): Promise<string> {
  let text = "";
  for (const deadline = Date.now() + 15_000; !text.includes(expected); await new Promise((r) => setTimeout(r, 200))) {
    if (Date.now() > deadline) throw new Error(`console_extension never said ${JSON.stringify(expected)}: ${text}`);
    text = (await w.call("console_extension", { id })).texte;
  }
  return text;
}

describe("the agent's tools and their card", () => {
  it("demander_extension shows the card; Activer: signed, installed, « Activée » ; lister_extensions shows it active", async () => {
    const w = await launch();
    writeAgentExtension(w.racine, "fond", BACKGROUND_ONLY);
    expect(await enabledByAgent(w, "fond", "Fond de l'agent")).toMatch(/^Activée dans « .+ »\.$/);
    expect(await agentAddons(w.marionette)).toEqual([{ id: "fond@agent.webaios", version: "1.0.0.1", isActive: true }]);
    await cardGone(w.marionette);
    expect((await w.call("lister_extensions")).texte).toMatch(/^agent:fond · Fond de l'agent · 1\.0\.0 · agent · actives dans : [^·]+ · erreurs : aucune$/m);
    // console_extension gives its background's console.log.
    const text = await consoleUntil(w, "fond", "fond démarré");
    expect(text.startsWith(EXTENSION_CONSOLE_PREFIX)).toBe(true);
    expect((await w.call("console_extension", { id: `store:${"a".repeat(32)}` })).texte).toBe("Réservé aux extensions que tu as écrites.");
  });

  it("demander_extension in a private space: refused without a card", async () => {
    const w = await launch();
    const m = w.marionette;
    writeAgentExtension(w.racine, "fond", BACKGROUND_ONLY);
    const s = await state(m);
    const e = s.espaces.find((x) => x.id === s.fenetres[0]!.espaceActif)!;
    await dispatch(m, { type: "reglerEspace", id: e.id, nom: e.nom, icone: e.icone, prive: true, profil: e.profil } as Action);
    expect((await w.call("demander_extension", { id: "fond" })).texte).toBe(PRIVATE_PROFILE_ERROR);
    expect(await inUi(m, `return !!doc.querySelector(${JSON.stringify(MODAL)})`)).toBe(false);
    expect(w.amo.envois).toEqual([]);
  });

  it("changed with a new site, recharger_extension disables it and says to call demander_extension; the card comes back", async () => {
    const w = await launch();
    writeAgentExtension(w.racine, "cacheur", { "manifest.json": hider([HOST]), "cache.css": "#cache-moi { display: none !important; }\n" });
    await enabledByAgent(w, "cacheur", "Cacheur de l'agent");
    writeAgentExtension(w.racine, "cacheur", { "manifest.json": hider([HOST, "https://exemple.com/*"]) });
    const r = (await w.call("recharger_extension", { id: "cacheur" })).texte;
    expect(r).toContain("etat : desactivee");
    expect(r).toContain("Désactivée : elle demande plus de droits qu'accordé");
    expect(r).toContain("demander_extension");
    await waitFor(w.marionette, `return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      return (await AddonManager.getAddonByID("cacheur@agent.webaios"))?.isActive;
    })();`, (v) => v === false);
    expect(await enabledByAgent(w, "cacheur", "Cacheur de l'agent")).toMatch(/^Activée dans « .+ »\.$/);
    await waitAddon(w.marionette, "cacheur@agent.webaios", "1.0.0.2");
    expect((await w.call("lister_extensions")).texte).toMatch(/^agent:cacheur · Cacheur de l'agent · 1\.0\.0 · agent · actives dans : [^·]+ · /m);
  });

  it("changed without a new right: recharger_extension reloads it without a card, at the next version", async () => {
    const w = await launch();
    writeAgentExtension(w.racine, "cacheur", { "manifest.json": hider([HOST]), "cache.css": "#cache-moi { display: none !important; }\n" });
    await enabledByAgent(w, "cacheur", "Cacheur de l'agent");
    await cardGone(w.marionette);
    writeAgentExtension(w.racine, "cacheur", { "cache.css": "#cache-moi, #reste { display: none !important; }\n" });
    expect((await w.call("recharger_extension", { id: "cacheur" })).texte).toBe("etat : rechargee");
    expect(await inUi(w.marionette, `return !!doc.querySelector(${JSON.stringify(MODAL)})`)).toBe(false);
    await waitAddon(w.marionette, "cacheur@agent.webaios", "1.0.0.2");
  });

  it("AMO refuses: the agent gets AMO's message; nothing installed", async () => {
    const w = await launch({ amo: { refus: "Validation failed: eval" } });
    writeAgentExtension(w.racine, "fond", BACKGROUND_ONLY);
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
   * ReponseAccord once answered (written to a file: the window may be gone by then).
   */
  async function withCard(champs: Record<string, unknown> = {}, w?: Awaited<ReturnType<typeof launch>>) {
    w ??= await launch();
    const m = w.marionette;
    const s = await state(m);
    const win = await m.execute<string>("return window.webaiosWindow.fenetreId");
    const space = s.espaces.find((e) => e.id === (champs.espaceId ?? s.fenetres.find((f) => f.id === win)!.espaceActif))!;
    const card = {
      cle: "agent:essai", nom: "Essai", source: "agent", version: "1.0.0", droits: ["Modifier l'apparence et le contenu des pages"],
      sites: ["https://exemple.com/*"], tousLesSites: false, reseau: [], renforce: false, espace: space.nom, espaceId: space.id,
      autresEspaces: [], remplaceAussi: [], maj: null, empreinte: "0".repeat(64), ...champs,
    };
    const file = path.join(w.dataDir, "reponse.json");
    await m.execute(
      `return (async () => {
        const s = await ChromeUtils.importESModule("${STORE}").ready;
        s.questions.askExtension(JSON.parse(arguments[0]), arguments[1]).then((r) => IOUtils.writeUTF8(arguments[2], JSON.stringify(r)));
      })();`,
      [JSON.stringify(card), win, file],
    );
    const response = () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { accepte: boolean; retiree?: boolean }) : null);
    const wait = async () => {
      for (const deadline = Date.now() + 10_000; !response(); await new Promise((r) => setTimeout(r, 100)))
        if (Date.now() > deadline) throw new Error("no answer");
      return response()!;
    };
    await cardText(m);
    return { ...w, m, reponse: response, attendre: wait };
  }
  /** The card has the keyboard and Enter is armed. */
  const armed = (m: Marionette) =>
    waitUi(m, `return !!doc.querySelector('${MODAL}[data-armee]') && !!doc.activeElement?.closest('${MODAL}') && document.activeElement?.id === "webaios-sidebar"`);

  it("an agent card without network says « Elle ne peut rien envoyer vers internet. »", async () => {
    const { m, attendre: wait } = await withCard({ autresEspaces: ["Lecture"], remplaceAussi: ["Travail", "Achats"] });
    const c = await cardText(m);
    expect(await inUi(m, `return doc.querySelector('[data-testid="carte-extension-remplace"]').textContent`)).toBe(
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
      "L'agent ne voit pas ce que cette extension lit sur les onglets que tu ne lui as pas partagés.",
    ])
      expect(c).toContain(t);
    expect(c).toMatch(/Activer\s*« Essai »\s*dans « .+ » \?/);
    expect(c).not.toContain("l'agent pourra voir");
    expect(await inUi(m, `return doc.querySelectorAll('[data-testid="carte-extension-tous-sites"], [data-testid="carte-extension-confirmer"]').length`)).toBe(0);
    await enable(m);
    expect((await wait()).accepte).toBe(true);
    await cardGone(m);
  });

  it("renforcée: Activer does nothing until the box is ticked; a « yes » without it is refused", async () => {
    const { m, reponse: response, attendre: wait } = await withCard({ renforce: true, tousLesSites: true, sites: ["<all_urls>"] });
    expect(await cardText(m)).toContain("Je comprends : elle lira toutes les pages de cet espace");
    expect(await inUi(m, `return [...doc.querySelectorAll('${CARD} button')].find((b) => b.textContent.includes("Activer")).disabled`)).toBe(true);
    await enable(m);
    await new Promise((r) => setTimeout(r, 300));
    expect(response()).toBeNull();
    // A « yes » sent without the box (a compromised or buggy UI): refused.
    await m.execute(`return (async () => {
      const s = await ChromeUtils.importESModule("${STORE}").ready;
      s.questions.answer(s.questions.pending()[0].id, "autoriser");
    })();`);
    expect((await wait()).accepte).toBe(false);
  });

  it("renforcée: the box ticked, Activer activates", async () => {
    const { m, attendre: wait } = await withCard({ renforce: true, tousLesSites: true, sites: ["<all_urls>"] });
    await click(m, '[data-testid="carte-extension-confirmer"]');
    await waitUi(m, `return doc.querySelector('[data-testid="carte-extension-confirmer"]').checked`);
    await enable(m);
    expect((await wait()).accepte).toBe(true);
  });

  it("Enter refuses an extension card, even renforcée and ticked", async () => {
    const { m, attendre: wait } = await withCard({ renforce: true, tousLesSites: true, sites: ["<all_urls>"] });
    await click(m, '[data-testid="carte-extension-confirmer"]');
    await waitUi(m, `return doc.querySelector('[data-testid="carte-extension-confirmer"]').checked`);
    await armed(m);
    await pressKeys(m, "Enter");
    expect((await wait()).accepte).toBe(false);
    await cardGone(m);
  });

  it("Escape refuses", async () => {
    const { m, attendre: wait } = await withCard();
    await armed(m);
    await pressKeys(m, "Escape");
    expect((await wait()).accepte).toBe(false);
    await cardGone(m);
  });

  it("the card's window closes: the card moves to another window; no window left: refused", async () => {
    const { m, reponse: response, attendre: wait } = await withCard();
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
    expect(await wait()).toMatchObject({ accepte: false, retiree: true });
  });

  it("a card gone stale (space deleted) falls and counts as a refusal", async () => {
    const w = await launch();
    const windowId = await w.marionette.execute<string>("return window.webaiosWindow.fenetreId");
    const reading = (await dispatch(w.marionette, { type: "creerEspace", nom: "Lecture", icone: "📚", prive: false, profil: "defaut", fenetreId: windowId } as Action)).espaces.at(-1)!;
    const { m, attendre: wait } = await withCard({ espaceId: reading.id }, w);
    await dispatch(m, { type: "supprimerEspace", id: reading.id } as Action);
    expect(await wait()).toMatchObject({ accepte: false, retiree: true });
    await cardGone(m);
  });
});

describe("the console", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => (server = await startServer()));
  afterAll(() => server?.close());

  /** The journal granted by its card, then a.html opened in a tab of the user's (not shared): its script writes there. */
  async function logInAnUnsharedTab() {
    const w = await launch();
    writeAgentExtension(w.racine, "journal", LOG);
    expect(await enabledByAgent(w, "journal", "Journal de l'agent")).toMatch(/^Activée dans « .+ »\.$/);
    await cardGone(w.marionette);
    await openTab(w.marionette, `${server.url}/a.html`);
    await consoleUntil(w, "journal", HIDDEN);
    return w;
  }
  /** debloquer_console, then « Débloquer » on its card. */
  async function unlock(w: Awaited<ReturnType<typeof launch>>, id: string) {
    const call = w.call("debloquer_console", { id, raison: "r" });
    await waitUi(w.marionette, `return !!doc.querySelector(${JSON.stringify(UNLOCK)})`, [], 15_000);
    await click(w.marionette, `${UNLOCK} button`, { text: "Débloquer" });
    expect((await call).texte).toContain("Console débloquée");
  }

  it("console_extension leaves out a content script's console.log in an unshared tab, and counts it", async () => {
    const w = await logInAnUnsharedTab();
    let text = (await w.call("console_extension", { id: "journal" })).texte;
    expect(text).not.toContain("contenu:/a.html");
    // It ran in an unshared tab: its background is masked too.
    expect(text).toContain(CONSOLE_BACKGROUND_HIDDEN);
    expect(text).not.toContain("fond démarré");
    // A tab the agent opens itself is readable: its message passes, the other stays masked.
    await w.call("ouvrir_onglet", { url: `${server.url}/b.html` });
    text = await consoleUntil(w, "journal", "contenu:/b.html");
    expect(text).not.toContain("contenu:/a.html");
    expect(text).toMatch(/^1 message\(s\) masqué\(s\)/m);
    // A reload does not reset the masking (its storage may have kept what it read).
    expect((await w.call("recharger_extension", { id: "journal" })).texte).toBe("etat : rechargee");
    expect((await w.call("console_extension", { id: "journal" })).texte).toContain(CONSOLE_BACKGROUND_HIDDEN);
  });

  it("debloquer_console granted → whole; refermer_console → masked again", async () => {
    const w = await logInAnUnsharedTab();
    const m = w.marionette;
    const call = w.call("debloquer_console", { id: "journal", raison: "le script de contenu ne trouve pas le bouton" });
    const card = await waitUi<string>(m, `return doc.querySelector(${JSON.stringify(UNLOCK)})?.textContent`, [], 15_000);
    const s = await state(m);
    const space = s.espaces.find((e) => e.id === s.fenetres[0]!.espaceActif)!.nom;
    expect(card).toContain(
      `L'agent demande à voir toute la console de « Journal de l'agent » pour la corriger. Il verra ce que l'extension écrit dans sa console sur tous les onglets de l'espace « ${space} », y compris ceux que tu ne partages pas. Jusqu'à ce que tu le coupes ou qu'il ait fini.`,
    );
    expect(card).toContain("le script de contenu ne trouve pas le bouton");
    // Refuser is the default button (Enter).
    expect(await inUi(m, `return [...doc.querySelectorAll('${UNLOCK} button')].find((b) => b.textContent.includes("Refuser")).hasAttribute("data-principal")`)).toBe(true);
    await click(m, `${UNLOCK} button`, { text: "Débloquer" });
    expect((await call).texte).toContain("Console débloquée");
    let text = await consoleUntil(w, "journal", "contenu:/a.html");
    expect(text).toContain("fond démarré");
    expect(text).not.toContain("message(s) masqué(s)");
    expect(text).not.toContain(CONSOLE_BACKGROUND_HIDDEN);
    expect((await w.call("refermer_console", { id: "journal" })).texte).toContain("refermée");
    text = (await w.call("console_extension", { id: "journal" })).texte;
    expect(text).not.toContain("contenu:/a.html");
    expect(text).toContain("message(s) masqué(s)");
  });

  it("with a right that observes tabs (hosts), its background's console is always masked, even without an unshared tab, and the tool says why; unlocked, it passes", async () => {
    const w = await launch();
    writeAgentExtension(w.racine, "veilleur", {
      "manifest.json": { manifest_version: 3, name: "Veilleur de l'agent", version: "1.0.0", host_permissions: [HOST], background: { service_worker: "fond.js" } },
      "fond.js": 'setInterval(() => console.log("tic du fond"), 300);\n',
    });
    expect(await enabledByAgent(w, "veilleur", "Veilleur de l'agent")).toMatch(/^Activée/);
    await cardGone(w.marionette);
    await consoleUntil(w, "veilleur", OBSERVED_BACKGROUND_CONSOLE);
    await new Promise((r) => setTimeout(r, 1000));
    const text = (await w.call("console_extension", { id: "veilleur" })).texte;
    expect(text).not.toContain("tic du fond");
    expect(text).toContain("debloquer_console");
    await unlock(w, "veilleur");
    await consoleUntil(w, "veilleur", "tic du fond");
  });

  it("removed then recreated in the same place: nothing of its old storage, and its console stays masked (it ran in an unshared tab)", async () => {
    const w = await launch();
    const m = w.marionette;
    writeAgentExtension(w.racine, "journal", {
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
      await (await AddonManager.getAddonByID("journal@agent.webaios")).uninstall();
    })();`);
    for (const deadline = Date.now() + 15_000; "agent:journal" in registry(w.dataDir); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > deadline) throw new Error("not removed");
    // Recreated in the same place, without content script nor site: it reads what would be left.
    rmSync(path.join(w.racine, "extensions", "journal"), { recursive: true, force: true });
    writeAgentExtension(w.racine, "journal", {
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
