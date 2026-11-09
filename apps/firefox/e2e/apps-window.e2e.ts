import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { answers, APPS_ENV, appWindowExpr, inAppView, killFakeApps, launchEssai, stopsLog, writeProject } from "./apps";
import { state, waitFor, waitReady } from "./firefox";
import { installAddon, type Fixture } from "./addons";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { inBrowser } from "./sites";

// Plan 35a Task 3: the agent app's window, its container, its origin guard and the agent's `app:<dossier>`, plus
// the security checks of spike S8 on the real code.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const BLOCK: [number, number] = [15280, 15284];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const app = appWindowExpr("essai");
const view = `${app}.gBrowser.selectedBrowser`;

interface Instance {
  w: LaunchedWebAiOs;
  m: Marionette;
  dataDir: string;
}

/** WebAiOs with the essai project (and `plante`, a crashing one), its MCP server up. */
async function start(o: { serveur?: "ok" | "plante" } = {}): Promise<Instance> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  writeProject(dataDir, "essai", { manifeste: { nom: "Essai" }, serveur: o.serveur ?? "ok" });
  writeProject(dataDir, "autre", { manifeste: { nom: "Autre" } });
  writeProject(dataDir, "plante", { manifeste: { nom: "Plante" }, serveur: "plante" });
  const w = await launchWebAiOs({ dataDir, env: APPS_ENV(BLOCK) });
  const m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  // Not expect.poll: also run from beforeAll.
  for (const end = Date.now() + 15_000; !existsSync(path.join(dataDir, "espace", ".webaios", "mcp.json")); await sleep(100))
    if (Date.now() > end) throw new Error("the MCP server did not start");
  return { w, m, dataDir };
}
async function stop(i: Instance | undefined): Promise<void> {
  if (!i) return;
  await i.w.close();
  killFakeApps(i.dataDir);
  await rm(i.dataDir, { recursive: true, force: true });
}

const inStore = <T = unknown>(m: Marionette, body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
const appWindows = (m: Marionette) => m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].filter((w) => w.document.documentElement.hasAttribute("webaios-app")).length;`);
const browserWindows = (m: Marionette) => m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].length;`);
const viewUrl = (m: Marionette) => m.execute<string | null>(`return ${app}?.gBrowser.selectedBrowser.currentURI.spec ?? null;`);
/** The app view shows `url`, loaded. */
const viewAt = (m: Marionette, url: string) =>
  waitFor(m, `const b = ${app}?.gBrowser.selectedBrowser; return !!b && b.currentURI.spec === ${JSON.stringify(url)} && !b.webProgress.isLoadingDocument;`, (v) => v === true, 15_000);
const tabUrls = async (m: Marionette) => Object.values((await state(m)).onglets).map((o) => o.url);
const fenetre = async (m: Marionette) => (await state(m)).fenetres[0]!.id;
const agir = async (m: Marionette, dossier: string, action: string) =>
  inStore(m, `await store.agent.request("applications.agir", { dossier: arguments[0], action: arguments[1], fenetre: arguments[2] });`, [dossier, action, await fenetre(m)]);
const liste = (m: Marionette) => inStore<{ applications: { dossier: string; etat: string; port?: number; favicon?: string }[] }>(m, `return await store.agent.request("applications.liste");`);
/** The view is still on `url` and its page was not replaced (window.marque kept). */
async function stays(m: Marionette, url: string, what: string) {
  await sleep(700);
  expect(await viewUrl(m), what).toBe(url);
  expect(await inAppView(m, "essai", "return window.marque;"), what).toBe(7);
}
/** Quits as ⌘Q does (no forced quit: pages and windows are asked); resolves with the time Firefox took to exit. */
async function quit(i: Instance): Promise<number> {
  const t = Date.now();
  await i.m.command("Marionette:Quit", { flags: ["eAttemptQuit"] }).catch(() => {});
  for (const end = Date.now() + 10_000; Date.now() < end; await sleep(50))
    try {
      process.kill(i.w.pid, 0);
    } catch {
      return Date.now() - t;
    }
  throw new Error("Firefox did not quit");
}

/** A server on [::1] (never OrbStack's 127.0.0.1:5300-5319): another origin, noting what it receives. */
async function otherOrigin(): Promise<{ origin: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const s: Server = createServer((req, res) => {
    hits.push(req.url ?? "/");
    if (req.url === "/icon.png") return void res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
    res.writeHead(200, { "Content-Type": "text/html" }).end("<title>other</title>");
  });
  await new Promise<void>((ok) => s.listen(0, "::1", ok));
  return { origin: `http://[::1]:${(s.address() as AddressInfo).port}`, hits, close: () => new Promise((ok) => (s.closeAllConnections(), s.close(() => ok()))) };
}

describe("one WebAiOs, the app launched in each test", () => {
  let i: Instance;
  let m: Marionette;
  let port: number;
  let essai: string;

  beforeAll(async () => {
    i = await start();
    m = i.m;
  }, 90_000);
  afterAll(() => stop(i));
  afterEach(async () => {
    for (const dossier of ["essai", "autre"]) await callTool(i.dataDir, "arreter_application", { dossier }).catch(() => {});
    await waitFor(m, `return [...Services.wm.getEnumerator("navigator:browser")].filter((w) => w.document.documentElement.hasAttribute("webaios-app")).length;`, (n) => n === 0);
    await waitFor(m, "for (const t of gBrowser.tabs.slice(1)) gBrowser.removeTab(t); return gBrowser.tabs.length;", (n) => n === 1);
    await expect.poll(async () => (await liste(m)).applications.filter((a) => a.etat !== "arretee" && a.etat !== "erreur").length, { timeout: 10_000 }).toBe(0);
  });
  async function launched(): Promise<void> {
    port = await launchEssai(i.dataDir);
    essai = `http://localhost:${port}/`;
    await viewAt(m, essai);
  }

  // applications.spec.ts:236
  it("orphan apps are stopped at launch", async () => {
    await expect.poll(() => stopsLog(i.dataDir), { timeout: 10_000 }).toContain("WEBAIOS_APP=.*");
  });

  // applications.spec.ts:84
  it("lancer_application opens a window without bar on the app", async () => {
    await launched();
    expect(port).toBeGreaterThanOrEqual(BLOCK[0]);
    expect(port).toBeLessThanOrEqual(BLOCK[1]);
    const shape = await m.execute<{ toolbox: boolean; browsers: number; sidebar: boolean; uc: number; container: number | null; toolbar: boolean }>(
      `const win = ${app};
       const { ContextualIdentityService: C } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
       return { toolbox: win.document.getElementById("navigator-toolbox").hidden, browsers: win.gBrowser.browsers.length,
         sidebar: !!win.document.getElementById("webaios-sidebar"), uc: win.gBrowser.selectedBrowser.browsingContext.originAttributes.userContextId,
         container: C.getPrivateIdentity("userContextIdInternal.webaios-app-essai")?.userContextId ?? null, toolbar: win.toolbar.visible };`,
    );
    expect(shape).toMatchObject({ toolbox: true, browsers: 1, sidebar: false, toolbar: false });
    expect(shape.uc).toBeGreaterThan(0);
    expect(shape.uc).toBe(shape.container);
  });

  // applications.spec.ts:93
  it("after lancer_application, the agent reads and captures the app's window without asking", async () => {
    const { texte } = await callTool(i.dataDir, "lancer_application", { dossier: "essai" });
    expect(texte).toContain("(onglet app:essai)");
    await expect.poll(async () => (await callTool(i.dataDir, "lister_onglets")).texte, { timeout: 10_000 }).toContain("app:essai");
    await expect.poll(async () => (await callTool(i.dataDir, "lire_onglet", { id: "app:essai" })).texte, { timeout: 10_000 }).toContain("Titre : Essai essai");
    expect((await callTool(i.dataDir, "lire_onglet", { id: "app:essai" })).texte).toContain("lien");
    const capture = await callTool(i.dataDir, "capture_ecran", { id: "app:essai" });
    expect(capture.image!.length).toBeGreaterThan(1000);
    expect(await inStore(m, "return store.questions.pending().length;")).toBe(0);
  });

  // applications.spec.ts:107
  it("closing the app's window stops it", async () => {
    await launched();
    expect(await answers(port)).toBe(true);
    await m.execute(`${app}.close();`);
    await expect.poll(() => stopsLog(i.dataDir), { timeout: 10_000 }).toContain("WEBAIOS_APP=essai");
    await expect.poll(() => answers(port), { timeout: 10_000 }).toBe(false);
  });

  // applications.spec.ts:136
  it("an external link of the app opens in a tab of the main window", async () => {
    await launched();
    await inAppView(m, "essai", 'document.querySelector("a").click(); return 1;');
    await expect.poll(() => tabUrls(m), { timeout: 10_000 }).toContain("https://exemple.invalide/");
    expect(await viewUrl(m)).toBe(essai);
  });

  // applications.spec.ts:161
  it("navigating the app to another site opens it in a tab; the window stays on the app", async () => {
    await launched();
    const r = await callTool(i.dataDir, "naviguer", { id: "app:essai", url: "https://exemple.invalide/ailleurs" });
    expect(r.erreur).toBe(false);
    await expect.poll(() => tabUrls(m), { timeout: 10_000 }).toContain("https://exemple.invalide/ailleurs");
    expect(await viewUrl(m)).toBe(essai);
    expect((await callTool(i.dataDir, "lire_onglet", { id: "app:essai" })).texte).toContain("lien");
    // On the app itself, the window navigates.
    await callTool(i.dataDir, "naviguer", { id: "app:essai", url: `${essai}sans-titre` });
    await viewAt(m, `${essai}sans-titre`);
  });

  // applications.spec.ts:177
  it("a server redirect of the app to another site opens in a tab", async () => {
    await launched();
    await inAppView(m, "essai", 'location.href = "/redirige"; return 1;');
    await expect.poll(() => tabUrls(m), { timeout: 10_000 }).toContain("https://exemple.invalide/redirige");
    expect(await viewUrl(m)).toBe(essai);
  });

  // applications.spec.ts:147
  it("the app window has no permission: notifications, position and camera refused", async () => {
    await launched();
    const r = await inAppView(
      m,
      "essai",
      `return (async () => ({
        notifications: await Notification.requestPermission(),
        position: (await navigator.permissions.query({ name: "geolocation" })).state,
        camera: (await navigator.permissions.query({ name: "camera" })).state,
      }))();`,
    );
    expect(r).toEqual({ notifications: "denied", position: "denied", camera: "denied" });
  });

  // applications.spec.ts:195
  it("a page that refuses to be left still closes when the app stops", async () => {
    await launched();
    await inAppView(m, "essai", 'location.href = "/retient"; return 1;');
    await viewAt(m, `${essai}retient`);
    // A click gives the page the activation its refusal needs.
    await inAppView(m, "essai", "return 1;", { gesture: true });
    await callTool(i.dataDir, "arreter_application", { dossier: "essai" });
    await expect.poll(() => appWindows(m), { timeout: 10_000 }).toBe(0);
  });

  // applications.spec.ts:214
  it("the app window's title is the page's, else the app's name", async () => {
    await launched();
    const title = () => m.execute<string>(`return ${app}.document.title;`);
    await expect.poll(title, { timeout: 10_000 }).toBe("Essai essai");
    await inAppView(m, "essai", 'location.href = "/sans-titre"; return 1;');
    await viewAt(m, `${essai}sans-titre`);
    await expect.poll(title, { timeout: 10_000 }).toBe("Essai");
  });

  // applications.spec.ts:227
  it("a crashing app opens no window", async () => {
    const { texte } = await callTool(i.dataDir, "lancer_application", { dossier: "plante" });
    expect(texte).toContain("en erreur");
    expect(texte).toContain("boum");
    expect(await appWindows(m)).toBe(0);
  });

  // applications.spec.ts:251
  it("the app window's size is kept", async () => {
    await launched();
    await m.execute(`${app}.resizeTo(640, 480);`);
    await waitFor(m, `return [${app}.outerWidth, ${app}.outerHeight];`, (v: number[]) => v[0] === 640 && v[1] === 480);
    await sleep(500);
    await m.execute(`${app}.close();`);
    await expect.poll(() => appWindows(m), { timeout: 10_000 }).toBe(0);
    // Under <dataDir>, never in <dataDir>/espace that the container mounts.
    const memory = path.join(i.dataDir, "applications.json");
    await expect.poll(() => existsSync(memory) && JSON.parse(readFileSync(memory, "utf8")).essai?.cadre, { timeout: 10_000 }).toMatchObject({ largeur: 640, hauteur: 480 });
    expect(existsSync(path.join(i.dataDir, "espace", "applications.json"))).toBe(false);
    await launched();
    expect(await m.execute(`return [${app}.outerWidth, ${app}.outerHeight];`)).toEqual([640, 480]);
  });

  it("containers are isolated: an app's cookie and storage are seen neither by another app, a tab on its origin, nor a site app", async () => {
    await launched();
    await inAppView(m, "essai", "document.cookie = 'essai=1; max-age=3600; path=/'; localStorage.k = 'essai'; sessionStorage.k = 'essai'; return 1;");
    const read = "return { cookie: document.cookie, local: localStorage.k ?? null, session: sessionStorage.k ?? null };";
    const none = { cookie: "", local: null, session: null };
    // Another app, on another port.
    const { texte } = await callTool(i.dataDir, "lancer_application", { dossier: "autre" });
    const autre = Number(/localhost:(\d+)/.exec(texte)![1]);
    const autreWin = appWindowExpr("autre");
    await waitFor(m, `const b = ${autreWin}?.gBrowser.selectedBrowser; return !!b && b.currentURI.spec === "http://localhost:${autre}/" && !b.webProgress.isLoadingDocument;`, (v) => v === true, 15_000);
    expect(await inAppView(m, "autre", read)).toEqual(none);
    // A tab of the main window on the app's own origin (the default container): sees nothing, and sets its own.
    await inStore(m, `store.dispatch({ type: "ouvrirOnglet", fenetreId: store.state.fenetres[0].id, url: arguments[0] });`, [`${essai}page2`]);
    await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(`${essai}page2`)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument;`, (v) => v === true);
    expect(await inBrowser(m, "gBrowser.selectedBrowser", read)).toEqual(none);
    await inBrowser(m, "gBrowser.selectedBrowser", "document.cookie = 'tab=1; max-age=3600; path=/'; localStorage.k = 'tab'; return 1;");
    // A site app's container can load nothing on localhost (no site app may declare it): its cookie jar is read instead.
    const jars = await m.execute<{ uc: number; name: string }[]>(
      `return Services.cookies.getCookiesFromHost("localhost", {}).concat(...[...Array(64).keys()].map((uc) => Services.cookies.getCookiesFromHost("localhost", { userContextId: uc })))
         .filter((c) => c.name === "essai").map((c) => ({ uc: c.originAttributes.userContextId, name: c.name }));`,
    );
    const uc = await m.execute<number>(`return ${view}.browsingContext.originAttributes.userContextId;`);
    expect(jars).toEqual([{ uc, name: "essai" }]);
    // And back: the app sees neither the tab's cookie nor its storage.
    await inAppView(m, "essai", 'location.href = "/page2"; return 1;');
    await viewAt(m, `${essai}page2`);
    expect(await inAppView(m, "essai", read)).toEqual({ cookie: "essai=1", local: "essai", session: "essai" });
  });

  it("file:, data: and blob: are refused in the app window", async () => {
    await launched();
    await inAppView(m, "essai", "window.marque = 7; return 1;");
    const system = "Services.scriptSecurityManager.getSystemPrincipal()";
    const file = `file://${i.w.profile}/user.js`;
    // ⌘O and a dropped file.
    await m.execute(`${app}.openLinkIn(arguments[0], "current", { triggeringPrincipal: ${system} });`, [file]);
    await stays(m, essai, "⌘O file:");
    await m.execute(`${view}.droppedLinkHandler(null, [{ url: arguments[0], name: "", type: "" }], ${system});`, [file]);
    await stays(m, essai, "dropped file:");
    await m.execute(`${view}.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: ${system} });`, ["data:text/html,<title>data</title>"]);
    await stays(m, essai, "data: by the system principal");
    for (const [what, code] of [
      ["page file:", `location.href = "${file}"`],
      ["page data:", `location.href = "data:text/html,<title>data</title>"`],
      ["page blob:", `location.href = URL.createObjectURL(new Blob(["<title>blob</title>"], { type: "text/html" }))`],
    ] as const) {
      await inAppView(m, "essai", `${code}; return 1;`, { gesture: true });
      await stays(m, essai, what);
    }
  });

  it("an http redirect to file: or data: is refused in the app view", async () => {
    await launched();
    await inAppView(m, "essai", "window.marque = 7; return 1;");
    for (const p of ["/vers-file", "/vers-data"]) {
      await inAppView(m, "essai", `location.href = ${JSON.stringify(p)}; return 1;`, { gesture: true });
      await stays(m, essai, p);
    }
  });

  it("a window.open with features that loads no http page is closed: about:blank", async () => {
    await launched();
    const windows = await browserWindows(m);
    await inAppView(m, "essai", 'window.open("", "x", "width=300,height=300"); return 1;', { gesture: true });
    await sleep(1500);
    expect(await browserWindows(m)).toBe(windows);
  });

  it("a window.open with features that loads no http page is closed: a same-origin blob:", async () => {
    await launched();
    const windows = await browserWindows(m);
    await inAppView(m, "essai", 'window.open(URL.createObjectURL(new Blob(["<title>blob</title><p>blob</p>"], { type: "text/html" })), "y", "width=300,height=300"); return 1;', { gesture: true });
    await sleep(1500);
    expect(await browserWindows(m)).toBe(windows);
  });

  it("no window of the app's container survives the app's stop", async () => {
    await launched();
    const uc = await m.execute<number>(`return ${view}.browsingContext.originAttributes.userContextId;`);
    for (const code of ['window.open("", "a", "width=300,height=300")', 'window.open(URL.createObjectURL(new Blob(["<p>b</p>"], { type: "text/html" })), "b", "width=300,height=300")', 'window.open("/page2")'])
      await inAppView(m, "essai", `${code}; return 1;`, { gesture: true });
    await callTool(i.dataDir, "arreter_application", { dossier: "essai" });
    await expect.poll(() => appWindows(m), { timeout: 10_000 }).toBe(0);
    await sleep(1000);
    const left = await m.execute<number>(
      `return [...Services.wm.getEnumerator(null)].filter((w) => w.gBrowser?.browsers.some((b) => b.browsingContext?.originAttributes.userContextId === arguments[0])).length;`,
      [uc],
    );
    expect(left).toBe(0);
  });

  it("a stopped app's container loads nothing", async () => {
    const other = await otherOrigin();
    try {
      await launched();
      const uc = await m.execute<number>(`return ${view}.browsingContext.originAttributes.userContextId;`);
      await callTool(i.dataDir, "arreter_application", { dossier: "essai" });
      await expect.poll(() => appWindows(m), { timeout: 10_000 }).toBe(0);
      // What could still load in its container: a tab left behind, towards a server that is up.
      await m.execute(`window.strayTab = gBrowser.addTab(arguments[0], { userContextId: arguments[1], triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [`${other.origin}/stray`, uc]);
      await sleep(1500);
      const url = await m.execute<string>("const u = window.strayTab.linkedBrowser.currentURI.spec; gBrowser.removeTab(window.strayTab); return u;");
      expect(other.hits).toEqual([]);
      expect(url).not.toBe(`${other.origin}/stray`);
    } finally {
      await other.close();
    }
  });

  it("a cross-origin favicon is dropped, a same-origin one is kept", async () => {
    const other = await otherOrigin();
    try {
      await launched();
      const favicon = async () => (await liste(m)).applications.find((a) => a.dossier === "essai")?.favicon;
      await inAppView(m, "essai", `location.href = "/icone?href=" + encodeURIComponent(${JSON.stringify(`${other.origin}/icon.png`)}); return 1;`);
      await expect.poll(() => other.hits.includes("/icon.png"), { timeout: 10_000 }).toBe(true);
      await sleep(1500);
      expect(await favicon()).toBeUndefined();
      await inAppView(m, "essai", 'location.href = "/icone?href=/icon.png"; return 1;');
      await expect.poll(favicon, { timeout: 10_000 }).toMatch(/^data:image\//);
    } finally {
      await other.close();
    }
  });

  it("window.open to the app's own origin opens a tab, never a window; one with features gets its window closed", async () => {
    await launched();
    await inAppView(m, "essai", "window.marque = 7; return 1;");
    const windows = await browserWindows(m);
    await inAppView(m, "essai", 'window.open("/page2"); return 1;', { gesture: true });
    await expect.poll(() => tabUrls(m), { timeout: 10_000 }).toContain(`${essai}page2`);
    await inAppView(m, "essai", 'window.open("https://exemple.invalide/pop", "x", "width=300,height=300"); return 1;', { gesture: true });
    await expect.poll(() => tabUrls(m), { timeout: 10_000 }).toContain("https://exemple.invalide/pop");
    await expect.poll(() => browserWindows(m), { timeout: 10_000 }).toBe(windows);
    await stays(m, essai, "window.open");
  });

  it("a relaunch on another port: the window follows, the old port opens in a tab", async () => {
    // The block's first port taken: essai gets the next one, then, the first freed, the relaunch takes it.
    const taken = createServer((_q, r) => r.end("taken"));
    await new Promise<void>((ok) => taken.listen(BLOCK[0], "127.0.0.1", ok));
    try {
      await launched();
    } finally {
      await new Promise((ok) => (taken.closeAllConnections(), taken.close(ok)));
    }
    const old = essai;
    expect(port).not.toBe(BLOCK[0]);
    await m.execute(`${app}.webaiosMark = 1;`);
    await agir(m, "essai", "relancer");
    const next = `http://localhost:${BLOCK[0]}/`;
    await viewAt(m, next);
    expect(await m.execute(`return ${app}.webaiosMark;`)).toBe(1);
    expect(await appWindows(m)).toBe(1);
    await inAppView(m, "essai", "window.marque = 7; return 1;");
    await inAppView(m, "essai", `location.href = ${JSON.stringify(`${old}page2`)}; return 1;`);
    await expect.poll(() => tabUrls(m), { timeout: 10_000 }).toContain(`${old}page2`);
    await stays(m, next, "old port");
  });
});

/**
 * An add-on taking orders from the test: the test writes `order <n> <json>` as the app page's title, its background
 * runs the order on that tab and writes `result <n> <json>` back as the page's title.
 */
const addonProbe = (): Fixture => ({
  id: "app-probe@webaios.test",
  manifest: { manifest_version: 2, name: "Sonde des applis", version: "1.0", browser_specific_settings: { gecko: { id: "app-probe@webaios.test" } }, permissions: ["tabs", "<all_urls>"], background: { scripts: ["background.js"] } },
  files: {
    "page.html": '<!doctype html><meta charset="utf-8"><title>Page</title>',
    "background.js": `let done = 0;
const run = async (o, t) => {
  if (o.op === "create") return browser.tabs.create({ windowId: t.windowId, url: o.url }).then((n) => (n.windowId === t.windowId ? "same-window" : "other-window"));
  if (o.op === "update") return browser.tabs.update(t.id, { url: o.url }).then(() => "updated");
  if (o.op === "remove") return browser.tabs.remove(t.id).then(() => "removed");
  if (o.op === "move") {
    const other = (await browser.windows.getAll()).find((x) => x.id !== t.windowId);
    return browser.tabs.move(t.id, { windowId: other.id, index: 0 }).then(() => "moved");
  }
  if (o.op === "window") return browser.windows.create({ tabId: t.id }).then(() => "window");
  if (o.op === "close-window") return browser.windows.remove(t.windowId).then(() => "closed");
};
setInterval(async () => {
  for (const t of await browser.tabs.query({})) {
    const m = /^order (\\d+) (.*)$/.exec(t.title || "");
    if (!m || Number(m[1]) <= done) continue;
    done = Number(m[1]);
    let r;
    try {
      r = { ok: await run(JSON.parse(m[2]), t) };
    } catch (e) {
      r = { error: String(e && e.message) };
    }
    await browser.tabs.executeScript(t.id, { code: "document.title = " + JSON.stringify("result " + m[1] + " " + JSON.stringify(r)) }).catch(() => {});
  }
}, 100);`,
  },
});
let orders = 0;
/** One order to the probe, through the app page's title; its answer. */
async function order(m: Marionette, o: object, wait = true): Promise<{ ok?: unknown; error?: string }> {
  const n = ++orders;
  await inAppView(m, "essai", `document.title = ${JSON.stringify(`order ${n} ${JSON.stringify(o)}`)}; return 1;`);
  if (!wait) return {};
  const t = await waitFor<string>(m, `return ${view}.contentTitle ?? ""`, (x) => x.startsWith(`result ${n} `), 15_000);
  return JSON.parse(t.slice(`result ${n} `.length));
}

async function waitHandles(m: Marionette, ok: (hs: string[]) => boolean): Promise<string[]> {
  for (const end = Date.now() + 10_000; Date.now() < end; await sleep(100)) {
    const hs = await m.command<string[]>("WebDriver:GetWindowHandles");
    if (ok(hs)) return hs;
  }
  throw new Error("timed out waiting on the window handles");
}

describe("each with its own WebAiOs", () => {
  let i: Instance | undefined;
  afterEach(async () => {
    await stop(i);
    i = undefined;
  });

  // applications.spec.ts:118
  it("closing the agent's window does not stop the app", async () => {
    i = await start();
    const port = await launchEssai(i.dataDir);
    await viewAt(i.m, `http://localhost:${port}/`);
    const main = (await i.m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    await i.m.execute("window.close();");
    // The current window is gone: Marionette goes on in the app's.
    const [h] = await waitHandles(i.m, (hs) => !hs.includes(main));
    await i.m.command("WebDriver:SwitchToWindow", { handle: h, focus: false });
    await sleep(1000);
    expect(await appWindows(i.m)).toBe(1);
    expect(await answers(port)).toBe(true);
    expect(stopsLog(i.dataDir)).not.toContain("WEBAIOS_APP=essai");
  });

  it("add-ons can neither add a tab to the app window, nor close, move or detach its view", async () => {
    i = await start();
    await installAddon(i.m, addonProbe());
    const port = await launchEssai(i.dataDir);
    const essai = `http://localhost:${port}/`;
    await viewAt(i.m, essai);
    expect(await order(i.m, { op: "create", url: "https://exemple.invalide/dans-l-appli" })).toEqual({ error: "Chargement refusé par WebAiOs" });
    expect(await order(i.m, { op: "update", url: "page.html" })).toEqual({ error: "Chargement refusé par WebAiOs" });
    expect(await order(i.m, { op: "remove" })).toEqual({ error: "Onglet protégé par WebAiOs" });
    expect(await order(i.m, { op: "move" })).toEqual({ error: "Onglet protégé par WebAiOs" });
    expect(await order(i.m, { op: "close-window" })).toEqual({ error: "Onglet protégé par WebAiOs" });
    // windows.create({ tabId }): the view does not go into a new window (its answer may never come: not awaited).
    await order(i.m, { op: "window" }, false);
    await sleep(1500);
    expect(await i.m.execute(`return ${app}.gBrowser.tabs.length;`)).toBe(1);
    expect(await viewUrl(i.m)).toBe(essai);
    expect(await appWindows(i.m)).toBe(1);
    expect(stopsLog(i.dataDir)).not.toContain("WEBAIOS_APP=essai");
  });

  // applications.spec.ts:205
  it("a page that refuses to be left does not block ⌘Q", async () => {
    i = await start();
    const port = await launchEssai(i.dataDir);
    const essai = `http://localhost:${port}/`;
    await viewAt(i.m, essai);
    await inAppView(i.m, "essai", 'location.href = "/retient"; return 1;');
    await viewAt(i.m, `${essai}retient`);
    await inAppView(i.m, "essai", "return 1;", { gesture: true });
    await quit(i);
    expect(await answers(port)).toBe(false);
  });

  // applications.spec.ts:242
  it("⌘Q stops the running apps, in under 8 s (target 5 s)", async () => {
    i = await start();
    const port = await launchEssai(i.dataDir);
    await viewAt(i.m, `http://localhost:${port}/`);
    const ms = await quit(i);
    console.log(`[apps-window] quit with an app running: ${ms} ms`);
    // The spec's target is 5 s (S8 measured 1.2 s); 8 s leaves room under 6 parallel Firefox instances.
    expect(ms).toBeLessThan(8000);
    expect(stopsLog(i.dataDir)).toContain("WEBAIOS_APP=essai");
    expect(await answers(port)).toBe(false);
  });

  it("host killed: the app window closes, the restarted host stops the orphan", async () => {
    i = await start();
    const m = i.m;
    const port = await launchEssai(i.dataDir);
    await viewAt(m, `http://localhost:${port}/`);
    const sweeps = () => stopsLog(i!.dataDir).split("\n").filter((l) => l.includes("WEBAIOS_APP=.*")).length;
    await expect.poll(sweeps, { timeout: 10_000 }).toBe(1);
    const pid = await inStore<number>(m, "return store.agent.pid;");
    process.kill(pid, "SIGKILL");
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`, (v) => v === null);
    await expect.poll(() => appWindows(m), { timeout: 10_000 }).toBe(0);
    // The chrome forgot it: nothing left for the agent, nothing a new host would be told was closed by the user.
    expect(await m.execute(`return ChromeUtils.importESModule("${STORE}").apps.forAgent();`)).toEqual([]);
    // « Réessayer »: the new host sweeps the orphan away.
    await inStore(m, "await store.agent.ensure();");
    await expect.poll(sweeps, { timeout: 15_000 }).toBe(2);
    await expect.poll(() => answers(port), { timeout: 10_000 }).toBe(false);
    // Launched again: a new window, and the app keeps running (no stale close stops it).
    const again = await launchEssai(i.dataDir);
    await viewAt(m, `http://localhost:${again}/`);
    await sleep(2000);
    expect(await appWindows(m)).toBe(1);
    expect(stopsLog(i.dataDir)).not.toContain("WEBAIOS_APP=essai");
    expect(await answers(again)).toBe(true);
  });
});
