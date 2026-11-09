import { execFile } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";
import { AMO_URL, readAmoKey, signer } from "../host/extensions/amo";
import { DEFAULT_GUARDS, prepareCopy } from "../../../packages/kernel/src/extensions/copy.ts";
import { writeXpi, type Fixture } from "./addons";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { ICON, startServer } from "./server";
import { waitUi } from "./ui";

// Probes of plan 25's unknowns (docs/superpowers/notes/2026-11-04-extensions-agent-essai.md). They print what they see
// rather than assert it: rerun them with WEBAIOS_SPIKE=1 after a Firefox version change and compare with the note.
// S1 signs for real on addons.mozilla.org: only with WEBAIOS_AMO=1, the network and the keychain's AMO keys.

const note = (what: string, v: unknown) => console.log(`[spike] ${what}: ${JSON.stringify(v)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);

/** Signed .xpi files of S1 are kept here (they hold no secret), so S3 can rerun without new uploads. */
const SIGNED = path.join(os.tmpdir(), "webaios-extensions-spike-signed");
const SPIKE_ID = `spike-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}@agent.webaios`;

// --- The extension the agent would write (MV3 for Chrome), and the copy Firefox gets ----------------------------

/**
 * An MV3 extension written for Chrome: a service worker that counts its starts and onInstalled in storage.local, a
 * content script on http://127.0.0.1/*, a popup, an options page and a page that shows its storage in its title.
 */
const SOURCE: Record<string, string | Buffer> = {
  "manifest.json": JSON.stringify({
    manifest_version: 3,
    name: "WebAiOs agent extension test",
    description: "Throwaway test of WebAiOs (agent-written extensions signing). Not for use.",
    version: "1.0",
    permissions: ["storage"],
    background: { service_worker: "background.js" },
    content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }],
    action: { default_icon: "icon.png", default_popup: "popup.html" },
    options_ui: { page: "options.html" },
  }),
  "webaios.json": "{}",
  "icon.png": ICON,
  "background.js": `console.log("spike-background", location.pathname);
const push = async (key, v) => { const o = await chrome.storage.local.get(key); await chrome.storage.local.set({ [key]: [...(o[key] ?? []), v] }); };
chrome.runtime.onInstalled.addListener((d) => void push("installs", d.reason + (d.previousVersion ? ":" + d.previousVersion : "") + "@" + Date.now()));
void push("starts", Date.now());
void chrome.storage.local.get("n").then((o) => (o.n ? undefined : chrome.storage.local.set({ n: 1 })));
`,
  "content.js": 'console.log("spike-content", location.href);\n',
  "popup.html": '<!doctype html><meta charset="utf-8"><title>Popup</title><script src="popup.js"></script>',
  "popup.js": 'document.title = "popup " + typeof globalThis.__webaios;\n',
  "options.html": '<!doctype html><meta charset="utf-8"><title>Options</title><script src="options.js"></script>',
  "options.js": 'document.title = "options " + typeof globalThis.__webaios;\n',
  "state.html": '<!doctype html><meta charset="utf-8"><title>…</title><script src="state.js"></script>',
  "state.js": 'chrome.storage.local.get(null).then((v) => (document.title = JSON.stringify(v)));\n',
};

async function writeTree(dir: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
}

/**
 * The base copy of SOURCE, then by hand what plan 25's decisions 2 and 3 add for Firefox: gecko id,
 * version `1.0.0.<n>`, background `scripts: [guard, original]` (webaios-fond.js dropped). `extra` is merged into the
 * manifest last (what AMO turns out to require). Returns the zipped .xpi path and the copy's manifest.
 */
async function firefoxCopy(o: { id: string; n: number; extra?: Record<string, unknown>; guards?: boolean; files?: Record<string, string> }): Promise<{ xpi: string; manifest: Record<string, any> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "webaios-spike-copy-"));
  await writeTree(path.join(dir, "source"), { ...SOURCE, ...o.files });
  const target = path.join(dir, "copy");
  const { analyse } = await prepareCopy({ source: path.join(dir, "source"), cible: target, dossierGardes: DEFAULT_GUARDS });
  if (analyse.refus.length) throw new Error(`copy refused: ${analyse.refus.join("; ")}`);
  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
  const gecko = { id: o.id, ...((o.extra?.gecko as object) ?? {}) };
  manifest.browser_specific_settings = { gecko };
  manifest.version = `1.0.0.${o.n}`;
  manifest.background = { scripts: ["webaios-garde-fond.js", "background.js"] };
  for (const [k, v] of Object.entries(o.extra ?? {})) if (k !== "gecko") manifest[k] = v;
  await rm(path.join(target, "webaios-fond.js"));
  if (o.guards === false) {
    // Control variant: the same extension without any WebAiOs file, to tell a guard rejection from anything else.
    for (const f of ["webaios-garde-fond.js", "webaios-garde-page.js", "webaios-correctifs-page.js", "webaios-portee.js", "webaios-fichiers"]) await rm(path.join(target, f), { recursive: true, force: true });
    manifest.background = { scripts: ["background.js"] };
    manifest.content_scripts = [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }];
  }
  await writeFile(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
  const xpi = path.join(dir, `copy-${o.n}.xpi`);
  await run("zip", ["-qr", xpi, "."], { cwd: target });
  return { xpi, manifest };
}

// --- Firefox side -------------------------------------------------------------------------------------------------

async function ready(m: Marionette, agent = true): Promise<void> {
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  if (!agent) return;
  // The home page's agent session settles first: quitting during its start-up leaves writers in the data dir.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
}

/** Installs the .xpi at `file` without waiting for its start (a background that never ends would hang Addon:Install). */
const installFile = (m: Marionette, file: string, temporary: boolean) =>
  m.execute<unknown>(
    `return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const file = new (ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs").FileUtils.File)(arguments[0]);
      if (arguments[1]) { window.spikeInstall = AddonManager.installTemporaryAddon(file).then((a) => a.id, (e) => "error " + e); return "started"; }
      const install = await AddonManager.getInstallForFile(file);
      const addon = await install.install();
      return { id: addon.id, version: addon.version, signedState: addon.signedState, temporarilyInstalled: addon.temporarilyInstalled, isActive: addon.isActive };
    })();`,
    [file, temporary],
  );

/** Opens moz-extension://<id's host>/<file> in a background tab until its title is no longer « … »; returns the title. */
const extPage = (m: Marionette, id: string, file: string, until = "") =>
  m.execute<string>(
    `return (async () => {
      let policy;
      for (let i = 0; i < 100 && !(policy = WebExtensionPolicy.getByID(arguments[0])); i++) await new Promise((r) => setTimeout(r, 100));
      const tab = gBrowser.addTab("moz-extension://" + policy.mozExtensionHostname + "/" + arguments[1], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      let t;
      for (let i = 0; i < 100; i++) {
        t = tab.linkedBrowser.contentTitle;
        if (t && t !== "…" && t.includes(arguments[2])) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      gBrowser.removeTab(tab);
      return t;
    })();`,
    [id, file, until],
  );

/** The storage.local of the copy, read by its state page once `key` is in it. */
const storageOf = async (m: Marionette, id: string, key: string) => {
  for (let i = 0; i < 10; i++) {
    const t = await extPage(m, id, "state.html", key);
    if (t?.includes(key)) return JSON.parse(t);
    await sleep(500);
  }
  return null;
};

/** Collects in window.spikeErrors the parent's nsIScriptError (and other console service messages) that mention `needle`. */
const LISTEN_ERRORS = `
  const needle = arguments[0];
  window.spikeErrors = [];
  window.spikeListener = { observe(msg) {
    const text = msg.message || "";
    const source = msg instanceof Ci.nsIScriptError ? msg.sourceName : "";
    if (!(text + source).includes(needle)) return;
    window.spikeErrors.push(msg instanceof Ci.nsIScriptError ? { flags: msg.flags, message: msg.errorMessage, sourceName: msg.sourceName, innerWindowID: msg.innerWindowID, category: msg.category } : { message: text });
  } };
  Services.console.registerListener(window.spikeListener);`;
const STOP_ERRORS = "Services.console.unregisterListener(window.spikeListener); return window.spikeErrors;";

/** A plain MV3 test extension (no copy), `<name>-spike@agent.webaios`; its `note(key, value)` asks base/note/<key>/<json>. */
function plain(base: string, name: string, files: Record<string, string>, manifest: Record<string, unknown> = {}): Fixture {
  const id = `${name}-spike@agent.webaios`;
  const helper = `const note = (k, v) => fetch(${JSON.stringify(base)} + "/note/" + k + "/" + encodeURIComponent(JSON.stringify(v))).catch(() => {});\n`;
  return {
    id,
    manifest: {
      manifest_version: 3,
      name: `WebAiOs spike ${name}`,
      version: "1.0",
      browser_specific_settings: { gecko: { id } },
      // Firefox's MV3 default adds upgrade-insecure-requests: the notes go to http://127.0.0.1.
      content_security_policy: { extension_pages: "script-src 'self'" },
      host_permissions: ["http://127.0.0.1/*"],
      ...manifest,
    },
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, k.endsWith(".js") ? helper + v : v])),
  };
}

/** The notes asked so far under `key`, decoded. */
const notes = (paths: string[], key: string) =>
  paths.filter((p) => p.startsWith(`/note/${key}/`)).map((p) => JSON.parse(decodeURIComponent(p.slice(`/note/${key}/`.length))));

/** Polls `read` until it is truthy (or `ms`). */
async function until<T>(read: () => T | Promise<T>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v || Date.now() > deadline) return v;
    await sleep(100);
  }
}

/** Opens `url` in a WebAiOs tab and waits until the selected browser shows it; returns the WebAiOs tab id. */
async function open(m: Marionette, url: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).onglets));
  const s = await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url });
  await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`, (v) => v === true);
  return Object.keys(s.onglets).find((id) => !before.has(id))!;
}

/** The test actors of S5 and S6, written in src/browser/base/content/webaios (where the real one will live) for the run only. */
const ACTOR_DIR = path.resolve(import.meta.dirname, "../src/browser/base/content/webaios");
const ACTOR_FILE = "extensions-spike-actor.sys.mjs";
const ACTOR_MODULE = `
export class WebAiOsSpikeExtParent extends JSWindowActorParent {
  receiveMessage(msg) {
    const el = this.browsingContext.top.embedderElement;
    return { echo: msg.data, group: el?.getAttribute?.("messagemanagergroup") ?? null, url: this.windowContext?.documentURI?.spec ?? null };
  }
}
export class WebAiOsSpikeExtChild extends JSWindowActorChild {
  handleEvent() {
    const win = this.contentWindow;
    const addonId = this.document.nodePrincipal.addonId;
    if (!addonId || !addonId.endsWith("@agent.webaios")) return;
    const api = Cu.createObjectIn(win);
    Cu.exportFunction((arg) => {
      const p = this.sendQuery("ask", arg);
      return new win.Promise((resolve, reject) => p.then((v) => resolve(Cu.cloneInto(v, win)), (e) => reject(new win.Error(String(e)))));
    }, api, { defineAs: "ask" });
    Object.freeze(Cu.waiveXrays(api));
    Object.defineProperty(win.wrappedJSObject, "__webaios", { value: api, writable: false, configurable: false, enumerable: false });
  }
}
/** What the process actors relayed (this module's global is not the window's). */
export const relayed = [];
export class WebAiOsSpikeConsoleParent extends JSProcessActorParent {
  receiveMessage(msg) {
    relayed.push({ remoteType: this.manager.remoteType, ...msg.data });
  }
}
export class WebAiOsSpikeConsoleChild extends JSProcessActorChild {
  receiveMessage(msg) {
    if (msg.name === "ping") return Date.now();
    if (msg.name !== "start" || this.started) return;
    this.started = true;
    const keep = (m) => m.addonId?.endsWith("@agent.webaios") || String(m.filename ?? "").startsWith("moz-extension:");
    const send = (m) => keep(m) && this.sendAsyncMessage("log", { kind: "console", level: m.level, args: (m.arguments ?? []).map(String), addonId: m.addonId, innerID: m.innerID, filename: m.filename });
    const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage);
    for (const m of storage.getEvents()) send(m);
    storage.addLogEventListener(send, Services.scriptSecurityManager.getSystemPrincipal());
    Services.console.registerListener({ observe: (m) => {
      if (m instanceof Ci.nsIScriptError && m.sourceName.startsWith("moz-extension:")) this.sendAsyncMessage("log", { kind: "error", message: m.errorMessage, sourceName: m.sourceName, innerWindowID: m.innerWindowID, flags: m.flags });
    } });
    return Services.appinfo.processType;
  }
}
`;

/** Registers S5's window actor (moz-extension, extension process) and S6's process actor from resource://webaios-test/. */
const REGISTER_ACTORS = `
  const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
  res.setSubstitution("webaios-test", Services.io.newFileURI(new (ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs").FileUtils.File)(arguments[0])));
  const uri = "resource://webaios-test/" + arguments[1];
  const out = {};
  try {
    ChromeUtils.registerWindowActor("WebAiOsSpikeExt", {
      parent: { esModuleURI: uri },
      child: { esModuleURI: uri, events: { DOMWindowCreated: {} } },
      matches: ["moz-extension://*/*"],
      remoteTypes: ["extension"],
      messageManagerGroups: ["webext-browsers", "browsers"],
      allFrames: true,
    });
    out.window = "ok";
  } catch (e) { out.window = String(e); }
  try {
    ChromeUtils.registerProcessActor("WebAiOsSpikeConsole", { parent: { esModuleURI: uri }, child: { esModuleURI: uri }, safeForUntrustedWebProcess: true });
    out.process = "ok";
  } catch (e) { out.process = String(e); }
  return out;`;

/** Starts S6's console relay in every content process; returns what each answered. */
const START_CONSOLE = `return (async () => Promise.all(ChromeUtils.getAllDOMProcesses().filter((p) => p.remoteType).map((p) =>
  Promise.race([p.getActor("WebAiOsSpikeConsole").sendQuery("start").then((t) => [p.remoteType, t], (e) => [p.remoteType, String(e)]), new Promise((r) => setTimeout(() => r([p.remoteType, "no answer in 3 s"]), 3000))]))))();`;

describe.skipIf(!process.env.WEBAIOS_SPIKE)("agent extensions spike", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => (server = await startServer()));
  afterAll(() => server?.close());

  it.skipIf(!process.env.WEBAIOS_AMO)("S1: real unlisted signing on addons.mozilla.org", { timeout: 90 * 60_000 }, async () => {
    const keys = await readAmoKey({});
    if (!keys) return note("S1", "not done: keys absent");
    note("S1 issuer", keys.emetteur.replace(/[^:]+$/, "…"));
    note("S1 guid", SPIKE_ID);
    // Plan 25 decision 2: `1.0` → `1.0.0.<n>`. WEBAIOS_SPIKE_EXTRA (JSON) is merged into the copy's manifest, for
    // what a first upload shows AMO requires (rerun with it rather than guess).
    const extra = process.env.WEBAIOS_SPIKE_EXTRA ? JSON.parse(process.env.WEBAIOS_SPIKE_EXTRA) : undefined;
    // WEBAIOS_SPIKE_FIRST / WEBAIOS_SPIKE_COUNT: a rerun continues the numbers already sent (AMO never takes one twice).
    const first = Number(process.env.WEBAIOS_SPIKE_FIRST ?? 1);
    const count = Number(process.env.WEBAIOS_SPIKE_COUNT ?? 3);
    const times: number[] = [];
    for (let n = first; n < first + count; n++) {
      const { xpi, manifest } = await firefoxCopy({ id: SPIKE_ID, n, extra });
      const t0 = Date.now();
      try {
        await signer({ xpi, guid: SPIKE_ID, version: manifest.version, cle: keys, base: AMO_URL, sortie: path.join(SIGNED, `${SPIKE_ID}-${manifest.version}.xpi`) });
      } catch (e) {
        note(`S1 sign ${manifest.version}`, (e as Error).message);
        break;
      }
      times.push(Date.now() - t0);
    }
    const sorted = [...times].sort((a, b) => a - b);
    note("S1 times ms", { times, median: sorted[Math.floor(sorted.length / 2)], worst: sorted.at(-1) });
  });
  it("S2: the copy's background as Firefox scripts (temporary install, no network)", { timeout: 120_000 }, async () => {
    const id = "s2-spike@agent.webaios";
    const w = await launchWebAiOs();
    try {
      const m = w.marionette;
      await ready(m);
      const facts = `
const facts = { pathname: location.pathname, importScripts: typeof importScripts, clients: typeof clients, self: typeof self,
  storagePromise: chrome.storage.local.get("x") instanceof Promise, browser: typeof browser, guardTable: typeof __webaiosFichiers,
  guardedExecuteScript: Object.getOwnPropertyDescriptor(chrome.scripting ?? {}, "executeScript")?.writable === false,
  guardedTabsCreate: Object.getOwnPropertyDescriptor(chrome.tabs ?? {}, "create")?.writable === false };
chrome.storage.local.set({ facts });
chrome.runtime.onInstalled.addListener((d) => chrome.storage.local.set({ installed: d }));
`;
      const { xpi, manifest } = await firefoxCopy({ id, n: 1, files: { "background.js": facts } });
      note("S2 copy manifest", { background: manifest.background, csp: manifest.content_security_policy, permissions: manifest.permissions, host_permissions: manifest.host_permissions, content_scripts: manifest.content_scripts });
      await m.execute(LISTEN_ERRORS, ["moz-extension"]);
      note("S2 install", await m.command("Addon:Install", { path: xpi, temporary: true }));
      note("S2 storage", await storageOf(m, id, "installed"));
      note(
        "S2 extension",
        await m.execute(`const e = WebExtensionPolicy.getByID(arguments[0]).extension; return { warnings: e.warnings, errors: e.errors, backgroundState: e.backgroundState, manifestVersion: e.manifestVersion, grantedOrigins: e.allowedOrigins.patterns.map((p) => p.pattern) };`, [id]),
      );
      await sleep(1000);
      note("S2 console errors", await m.execute(STOP_ERRORS));
    } finally {
      await w.close();
    }
  });

  it("S3: persistent install of the signed .xpi, restart, update, uninstall", { timeout: 300_000 }, async () => {
    const files = existsSync(SIGNED) ? (await import("node:fs/promises").then((f) => f.readdir(SIGNED))).filter((f) => f.endsWith(".xpi")).sort() : [];
    if (files.length < 2) return note("S3", `not done: ${files.length} signed .xpi in ${SIGNED} (S1 makes them)`);
    const [first, second] = files.map((f) => path.join(SIGNED, f));
    const id = path.basename(first!).replace(/-1\.0\.0\.\d+\.xpi$/, "");
    const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    // When each request reached the server (the restored tab's first load, against the background's start time).
    const seen: { path: string; at: number }[] = [];
    const ticker = setInterval(() => {
      while (seen.length < server.paths.length) seen.push({ path: server.paths[seen.length]!, at: Date.now() });
    }, 10);
    let w: LaunchedWebAiOs | undefined;
    try {
      w = await launchWebAiOs({ profile, dataDir });
      let m = w.marionette;
      await ready(m);
      note("S3 install", await installFile(m, first!, false));
      note("S3 storage after install", await storageOf(m, id, "installs"));
      await open(m, `${server.url}/texte.html?restored`);
      await w.close();
      const relaunched = Date.now();
      w = await launchWebAiOs({ profile, dataDir });
      m = w.marionette;
      // A restored session does not show the home page's agent.
      await ready(m, false);
      await sleep(2000);
      note("S3 add-on after restart", await m.execute(`return (async () => {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const a = await AddonManager.getAddonByID(arguments[0]);
        return a && { version: a.version, isActive: a.isActive, signedState: a.signedState, temporarilyInstalled: a.temporarilyInstalled };
      })();`, [id]));
      const s = await storageOf(m, id, "installs");
      note("S3 storage after restart", s);
      note("S3 timings after restart (ms since relaunch)", { backgroundStarts: (s?.starts ?? []).map((t: number) => t - relaunched), requests: seen.filter((x) => x.at >= relaunched).map((x) => ({ path: x.path, at: x.at - relaunched })) });
      note("S3 update", await installFile(m, second!, false));
      note("S3 storage after update", await storageOf(m, id, "update"));
      note("S3 uninstall", await m.execute(`return (async () => {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        await (await AddonManager.getAddonByID(arguments[0])).uninstall();
        return !!(await AddonManager.getAddonByID(arguments[0]));
      })();`, [id]));
      await sleep(2000);
      note("S3 reinstall", await installFile(m, second!, false));
      note("S3 storage after reinstall", await storageOf(m, id, "installs"));
    } finally {
      clearInterval(ticker);
      await w?.close();
      await Promise.all([rm(profile, { recursive: true, force: true }), rm(dataDir, { recursive: true, force: true })]);
    }
  });

  it("S4: containers, the tab tracker, invisible reads", { timeout: 120_000 }, async () => {
    const f = plain(server.url, "s4", {
      "background.js": `chrome.runtime.onMessage.addListener((msg, sender) => { note("s4", { href: msg.href, tab: sender.tab ? { id: sender.tab.id, cookieStoreId: sender.tab.cookieStoreId } : null, frameId: sender.frameId, url: sender.url }); });`,
      "content.js": 'document.documentElement.setAttribute("data-s4", "ran"); chrome.runtime.sendMessage({ href: location.href }).then((r) => document.documentElement.setAttribute("data-s4-sent", String(r)), (e) => document.documentElement.setAttribute("data-s4-sent", "error " + e));',
    }, { background: { scripts: ["background.js"] }, content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }] });
    const w = await launchWebAiOs();
    try {
      const m = w.marionette;
      await ready(m);
      note("S4 install", await m.command("Addon:Install", { path: await writeXpi(f), temporary: true }));
      const webaiosTab = await open(m, `${server.url}/texte.html?normal`);
      const normal = await until(() => notes(server.paths, "s4").find((n) => n.href.endsWith("?normal")));
      note("S4 normal tab message", normal);
      const CIS = 'ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs").ContextualIdentityService';
      const userContextId = await m.execute<number>(`return ${CIS}.create("webaios-spike", "fence", "blue").userContextId;`);
      await m.execute(`gBrowser.addTab(arguments[0], { userContextId: arguments[1], triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [`${server.url}/texte.html?container`, userContextId]);
      const container = await until(() => notes(server.paths, "s4").find((n) => n.href.endsWith("?container")));
      note("S4 container tab message", { userContextId, message: container });
      note(
        "S4 tabTracker",
        await m.execute(
          `const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
           const tt = ExtensionParent.apiManager.global.tabTracker;
           return arguments[0].map((id) => { try { const t = tt.getTab(id); return { id, localName: t.localName, webaiosTabId: t.getAttribute("webaios-tab-id"), userContextId: t.userContextId, url: t.linkedBrowser.currentURI.spec, group: t.linkedBrowser.getAttribute("messagemanagergroup") }; } catch (e) { return { id, error: String(e) }; } });`,
          [[normal?.tab?.id, container?.tab?.id].filter((x) => x !== undefined)],
        ),
      );
      note("S4 WebAiOs tab id of the normal tab", webaiosTab);
      // invisible.ts's reading browser: windowless, messagemanagergroup webaios-reading, an internal container.
      await m.execute(
        `return (async () => {
          const CIS = ${CIS};
          const userContextId = CIS.createForPolicy("userContextIdInternal.webaios-spike-" + Date.now()).userContextId;
          const windowless = Services.appShell.createWindowlessBrowser(true, Ci.nsIWebBrowserChrome.CHROME_REMOTE_WINDOW | Ci.nsIWebBrowserChrome.CHROME_FISSION_WINDOW);
          await new Promise((ok) => {
            const progress = windowless.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIWebProgress);
            const listener = {
              QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
              onStateChange(_p, request, state) {
                if (!request || !(state & Ci.nsIWebProgressListener.STATE_STOP) || !(state & Ci.nsIWebProgressListener.STATE_IS_NETWORK)) return;
                progress.removeProgressListener(listener);
                ok();
              },
            };
            progress.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_ALL);
            windowless.loadURI(Services.io.newURI("chrome://global/content/backgroundPageThumbs.xhtml"), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          });
          const browser = windowless.document.createXULElement("browser");
          for (const [k, v] of Object.entries({ type: "content", remote: "true", maychangeremoteness: "true", disableglobalhistory: "true", messagemanagergroup: "webaios-reading", manualactiveness: "true", usercontextid: String(userContextId) }))
            browser.setAttribute(k, v);
          windowless.document.documentElement.appendChild(browser);
          for (let i = 0; i < 500 && !browser.browsingContext.currentWindowGlobal; i++) await new Promise((r) => setTimeout(r, 10));
          await browser.browsingContext.currentWindowGlobal.getActor("WebAiOsReading").sendQuery("prepare");
          browser.docShellIsActive = true;
          const uri = Services.io.newURI(arguments[0]);
          browser.loadURI(uri, { triggeringPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId }) });
          window.spikeWindowless = windowless;
          window.spikeBrowser = browser;
        })();`,
        [`${server.url}/texte.html?reading`],
      );
      await sleep(3000);
      note("S4 invisible read: page asked", server.paths.includes("/texte.html"));
      note("S4 invisible read message", notes(server.paths, "s4").find((n) => n.href.endsWith("?reading")) ?? null);
      note("S4 invisible read: content script marks", await m.execute(`return (async () => { const html = await window.spikeBrowser.browsingContext.currentWindowGlobal.getActor("WebAiOsPage").sendQuery("html", { max: 100000 }); return [html.length, /data-s4="[^"]*"/.exec(html)?.[0] ?? null, /data-s4-sent="[^"]*"/.exec(html)?.[0] ?? null]; })();`));
      await m.execute("window.spikeWindowless?.close()");
    } finally {
      await w.close();
    }
  });

  it("S5+S6: an actor on the extension's pages, its console", { timeout: 120_000 }, async () => {
    const probe = (label: string) => `
const seen = { first: typeof globalThis.__webaios, pathname: location.pathname };
try { globalThis.__webaios = 1; } catch (e) { seen.assign = String(e); }
try { seen.deleted = delete globalThis.__webaios; } catch (e) { seen.delete = String(e); }
try { Object.defineProperty(globalThis, "__webaios", { value: 2 }); seen.redefine = "ok"; } catch (e) { seen.redefine = String(e); }
seen.after = typeof globalThis.__webaios;
Promise.resolve(globalThis.__webaios?.ask?.(${JSON.stringify(label)}) ?? "absent").then((v) => note("s5-${label}", { ...seen, answer: v }), (e) => note("s5-${label}", { ...seen, answer: "error " + e }));
console.log("s6-log-${label}");
setTimeout(() => { throw new Error("s6-uncaught-${label}"); }, 50);
`;
    const f = plain(server.url, "s5", {
      "background.js": probe("background") + 'chrome.runtime.onMessage.addListener((m) => { if (m === "options") chrome.runtime.openOptionsPage(); });',
      "popup.html": '<!doctype html><meta charset="utf-8"><title>Popup</title><script src="popup.js"></script>',
      "popup.js": probe("popup") + 'document.title = "Popup de test prête";',
      "options.html": '<!doctype html><meta charset="utf-8"><title>Options</title><script src="options.js"></script>',
      "options.js": probe("options"),
      "content.js": 'console.log("s6-log-content"); setTimeout(() => { throw new Error("s6-uncaught-content"); }, 50); if (location.search === "?options") chrome.runtime.sendMessage("options");',
    }, {
      background: { scripts: ["background.js"] },
      content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"] }],
      action: { default_icon: "icon.png", default_popup: "popup.html" },
      options_ui: { page: "options.html", open_in_tab: true },
    });
    f.files!["icon.png"] = ICON;
    // WEBAIOS_SPIKE_ACTOR_DIR: the same probe from another folder (to tell the sandbox from the module).
    const actorDir = process.env.WEBAIOS_SPIKE_ACTOR_DIR ?? ACTOR_DIR;
    await writeFile(path.join(actorDir, ACTOR_FILE), ACTOR_MODULE);
    // Without it, the content sandbox refuses the module in the extension and web processes (WEBAIOS_SPIKE_NO_READ_PATH=1
    // shows it; WEBAIOS_SPIKE_SANDBOX=0 turns the sandbox off instead).
    const prefs: Record<string, string | number> = process.env.WEBAIOS_SPIKE_NO_READ_PATH ? {} : { "security.sandbox.content.mac.testing_read_path1": actorDir };
    if (process.env.WEBAIOS_SPIKE_SANDBOX) prefs["security.sandbox.content.level"] = Number(process.env.WEBAIOS_SPIKE_SANDBOX);
    const w = await launchWebAiOs({ prefs });
    try {
      const m = w.marionette;
      await ready(m);
      await m.execute(LISTEN_ERRORS, ["spike-actor"]);
      note("S5 register", await m.execute(REGISTER_ACTORS, [actorDir, ACTOR_FILE]));
      note("S6 start before install", await m.execute(START_CONSOLE));
      note("S5 module load errors", await m.execute(STOP_ERRORS));
      await m.execute(LISTEN_ERRORS, ["s6-uncaught"]);
      note("S5 install", await m.command("Addon:Install", { path: await writeXpi(f), temporary: true }));
      await until(() => notes(server.paths, "s5-background").length > 0);
      // The popup through the strip (window/addons.ts), then the options page in a tab, asked by a content script.
      // The strip's buttons are enabled on a page only.
      await open(m, `${server.url}/texte.html?page`);
      await waitFor(m, `return !!window.webaiosWindow.addons.buttons().find((b) => b.id === ${JSON.stringify(f.id)})?.enabled`, (v) => v === true);
      await m.execute(`window.webaiosWindow.addons.click(arguments[0], { x: 0, y: 0, width: 24, height: 24 });`, [f.id]);
      await until(() => notes(server.paths, "s5-popup").length > 0);
      await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url: `${server.url}/texte.html?options` });
      await until(() => notes(server.paths, "s5-options").length > 0);
      for (const label of ["background", "popup", "options"]) note(`S5 ${label}`, notes(server.paths, `s5-${label}`));
      note("S6 start after pages", await m.execute(START_CONSOLE));
      await sleep(1500);
      note("S6 relayed", await m.execute("return ChromeUtils.importESModule('resource://webaios-test/' + arguments[0]).relayed", [ACTOR_FILE]));
      note("S6 parent nsIScriptError", await m.execute(STOP_ERRORS));
      note("S6 uuid", await m.execute("return WebExtensionPolicy.getByID(arguments[0]).mozExtensionHostname", [f.id]));
    } finally {
      await w.close();
      await rm(path.join(actorDir, ACTOR_FILE), { force: true });
    }
  });

  for (const kind of ["throws", "loops"] as const) {
    it(`S7: a background that ${kind}`, { timeout: 120_000 }, async () => {
      const f = plain(server.url, `s7-${kind}`, {
        "background.js": kind === "throws" ? 'note("s7-throws", "before " + Date.now());\nthrow new Error("s7-throw-at-load");' : 'note("s7-loops", "before " + Date.now());\nsetTimeout(() => { while (true) {} }, 500);',
      }, { background: { scripts: ["background.js"] } });
      await writeFile(path.join(ACTOR_DIR, ACTOR_FILE), ACTOR_MODULE);
      const w = await launchWebAiOs({ prefs: { "security.sandbox.content.mac.testing_read_path1": ACTOR_DIR } });
      try {
        const m = w.marionette;
        await ready(m);
        note(`S7 ${kind} actors`, await m.execute(REGISTER_ACTORS, [ACTOR_DIR, ACTOR_FILE]));
        await m.execute(
          `const { Management } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs");
           window.spikeEvents = [];
           const t0 = Date.now();
           const push = (what, extra) => window.spikeEvents.push({ at: Date.now() - t0, what, ...extra });
           for (const name of ["startup", "ready", "shutdown", "uninstall", "extension-process-crash", "extension-enable-process-spawning"])
             Management.on(name, (_e, x) => {
               push("Management:" + name, { id: x?.id, childID: x?.childID });
               if (name === "startup" && x?.id === arguments[0])
                 for (const ev of ["background-script-started", "background-script-aborted", "background-script-event", "shutdown"]) x.on(ev, () => push("extension:" + ev, { state: x.backgroundState }));
             });
           const prop = (s, name) => { try { return s.QueryInterface(Ci.nsIPropertyBag2).get(name); } catch { return undefined; } };
           for (const topic of ["ipc:content-shutdown", "extension:background-script-status", "process-hang-report", "clear-hang-report"])
             Services.obs.addObserver((s, t, d) => push(t, { data: d, abnormal: prop(s, "abnormal"), addonId: s?.wrappedJSObject?.addonId, isRunning: s?.wrappedJSObject?.isRunning }), topic);
           window.spikeStates = setInterval(() => push("backgroundState", { state: WebExtensionPolicy.getByID(arguments[0])?.extension?.backgroundState }), 1000);`,
          [f.id],
        );
        await m.execute(LISTEN_ERRORS.replace(/spike(Errors|Listener)/g, "spikeLoad$1"), ["s7-throw"]);
        note(`S7 ${kind} install`, await installFile(m, await writeXpi(f), true));
        await sleep(kind === "loops" ? 20_000 : 5000);
        note(`S7 ${kind} notes`, notes(server.paths, `s7-${kind}`));
        note(`S7 ${kind} install result`, await m.execute("return Promise.race([window.spikeInstall, new Promise((r) => setTimeout(() => r('pending'), 1000))])"));
        const events = await m.execute<any[]>("return window.spikeEvents");
        // Consecutive identical states collapsed.
        note(`S7 ${kind} events`, events.filter((e, i) => e.what !== "backgroundState" || events[i - 1]?.what !== "backgroundState" || events[i - 1]?.state !== e.state));
        note(`S7 ${kind} processes`, await m.execute("return ChromeUtils.getAllDOMProcesses().map((p) => [p.childID, p.remoteType])"));
        note(`S7 ${kind} parent nsIScriptError`, await m.execute(STOP_ERRORS.replace(/spike(Errors|Listener)/g, "spikeLoad$1")));
        note(`S7 ${kind} extension process answers a ping within 3 s`, await m.execute(`return (async () => {
          const p = ChromeUtils.getAllDOMProcesses().find((x) => x.remoteType === "extension");
          const t0 = Date.now();
          return Promise.race([p.getActor("WebAiOsSpikeConsole").sendQuery("ping").then(() => Date.now() - t0), new Promise((r) => setTimeout(() => r("no answer"), 3000))]);
        })();`));
        if (kind === "loops") {
          // What recovery looks like: the hung extension process killed (as about:processes does).
          note("S7 loops kill", await m.execute(`const p = ChromeUtils.getAllDOMProcesses().find((x) => x.remoteType === "extension");
            Cc["@mozilla.org/processtools-service;1"].getService(Ci.nsIProcessToolsService).kill(p.osPid);
            return { childID: p.childID, at: window.spikeEvents.length };`));
          await sleep(8000);
          const after = await m.execute<any[]>("return window.spikeEvents");
          note("S7 loops events after kill", after.slice(events.length).filter((e: any, i: number, a: any[]) => e.what !== "backgroundState" || a[i - 1]?.what !== "backgroundState" || a[i - 1]?.state !== e.state));
          note("S7 loops notes after kill", notes(server.paths, "s7-loops"));
          note("S7 loops processes after kill", await m.execute("return ChromeUtils.getAllDOMProcesses().map((p) => [p.childID, p.remoteType])"));
        }
      } finally {
        await w.close();
        await rm(path.join(ACTOR_DIR, ACTOR_FILE), { force: true });
      }
    });
  }
});
