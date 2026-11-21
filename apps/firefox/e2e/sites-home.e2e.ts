import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testActor } from "./agent-extensions";
import { waitReady, windowHandles } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { HOME_COPY, SITE_HOME, acceptHomeCard, homePoint, inBrowser, inHomeFrame, inSiteBar, inSiteView, resolveLocalHosts, siteHomeBrowser, siteWindowExpr, startSitesServer, writeSite } from "./sites";
import { inFrame, killFrames, missingApi } from "./ui";

// Plan 31 Task 5: the site app's home screen and its messages. The home is the test
// home (SITE_HOME) as is, plus a probe script the test drives by
// posting it commands from the chrome: what it then does is the home's own page code (fetch, image, navigation…).

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const HOSTS = ["vidola-a.localhost", "vidola-b.localhost", "pub.localhost"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Commands of the test, run by the home's page code (never by the chrome on its behalf). */
const PROBE = `<script>
  addEventListener("message", (e) => {
    const c = e.data && e.data.attempt;
    if (!c) return;
    if (c === "demander") parent.postMessage(e.data.m, "*");
    if (c === "fetch") fetch(e.data.url).then(() => (window.fetchResult = "ok"), () => (window.fetchResult = "refused"));
    if (c === "fuites") {
      const i = new Image();
      i.src = e.data.img;
      try { navigator.sendBeacon(e.data.beacon, "x"); } catch {}
      const f = document.createElement("form");
      f.action = e.data.form;
      f.method = "post";
      document.body.append(f);
      f.submit();
    }
    if (c === "aller") location.href = e.data.url;
    if (c === "lien") {
      const a = document.createElement("a");
      a.id = "lien";
      a.textContent = "lien";
      a.style = "display: block; font-size: 40px";
      a.href = e.data.url;
      document.body.prepend(a);
    }
    if (c === "refresh") {
      const r = document.createElement("meta");
      r.httpEquiv = "refresh";
      r.content = "0;url=" + e.data.url;
      document.head.append(r);
    }
    if (c === "logo") {
      const i = new Image();
      i.onload = () => (window.logo = i.naturalWidth);
      i.onerror = () => (window.logo = -1);
      i.src = e.data.url;
    }
  });
</script>`;
const HOME = SITE_HOME + PROBE;
// A JS router: moves to its own route as it loads (a same-document change), then says ready.
const ROUTER = SITE_HOME.replace('parent.postMessage({ type: "ready" }, "*");', 'history.pushState(null, "", "/settings"); parent.postMessage({ type: "ready" }, "*");');
const AUTO = HOME.replace('parent.postMessage({ type: "ready" }, "*");', 'parent.postMessage({ type: "ready" }, "*"); parent.postMessage({ type: "open", url: "/serie/the-bear?e=9" }, "*");');

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedRessac;
let m: Marionette;
let dataDir: string;
let profile: string;

const url = (p: string, host = "vidola-a.localhost") => server.url(host, p);
const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
const openSite = (id: string) => inStore(`await store.agent.request("sites.act", { id: arguments[0], action: "open", window: store.state.windows[0].id });`, [id]);

/** The view's address ("" before any load) and whether it shows (not under the home screen). */
const viewState = (id: string) =>
  m.execute<{ url: string; visible: boolean } | null>(
    `const win = ${siteWindowExpr(id)}; if (!win?.gBrowser) return null;
     const spec = win.gBrowser.selectedBrowser.currentURI?.spec ?? "";
     return { url: spec === "about:blank" ? "" : spec, visible: !win.document.documentElement.hasAttribute("ressac-site-home") };`,
  );

/** Async body run in the home page of app `id` (`fw` = its window, Xrays waived; `args`): `null` until it shows its home. */
const inHome = <T = unknown>(id: string, body: string, args: unknown[] = []) => inHomeFrame<T>(m, siteHomeBrowser(id), body, args);
/** The home frame's document address (chrome side), or null. */
const homeUri = (id: string) => m.execute<string | null>(`return (${siteHomeBrowser(id)})?.browsingContext?.currentWindowGlobal?.documentURI?.spec ?? null;`);
/** What the home received (its `recus`), once it has received something. */
const received = (id: string) => inHome<{ type: string; n?: number; data?: string | null; domain?: string }[]>(id, "return fw.recus ? JSON.parse(JSON.stringify(fw.recus)) : null;");
/** Posts a command to the home's probe, from the chrome (as the bar's own messages go). */
const probe = (id: string, cmd: object) => inHome(id, `window.postMessage(args[0], "*"); return true;`, [cmd]);
/** The home sends `m` to the bar (as the agent's code would). */
const ask = (id: string, msg: object) => probe(id, { attempt: "demander", m: msg });

/** The served home copy of app « autre » (opened for it): another app's home, for navigations that must be refused. */
async function otherHome(): Promise<string> {
  await openSite("autre");
  await expect.poll(() => homeUri("autre"), { timeout: 15_000 }).toMatch(HOME_COPY);
  return (await homeUri("autre"))!;
}

/** Waits for the home to be loaded and to have received something; returns once so. */
async function homeReady(id: string): Promise<void> {
  await expect.poll(async () => ((await received(id).catch(() => null)) ?? []).length, { timeout: 15_000 }).toBeGreaterThan(0);
}

/**
 * Sets the home's `adresse`, then a real WebDriver click on « Reprendre » in the home. An address other than the start
 * waits on the « Ouvrir l'appli ? » card over the home: with `accept` (default), « Ouvrir » once it shows (`wait` ms at most).
 */
async function clickOpen(id: string, address: string, o: { accept?: boolean; wait?: number } = {}): Promise<void> {
  await inHome(id, "fw.adresse = args[0]; return true;", [address]);
  await realClick(id, "#ouvrir");
  if (o.accept !== false) await acceptHomeCard(m, id, o.wait ?? 3000);
}

/**
 * A real click on `selector` in the home's frame of app `id`: WebDriver actions in the app window's chrome context, at the
 * element's centre (Marionette cannot switch into the bar's frames there, so the point is computed through them).
 */
async function realClick(id: string, selector: string): Promise<void> {
  const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  try {
    let found = false;
    for (const h of await windowHandles(m)) {
      await m.command("WebDriver:SwitchToWindow", { handle: h, focus: false });
      if ((found = (await m.execute<string | null>(`return document.documentElement.getAttribute("ressac-site");`)) === id)) break;
    }
    if (!found) throw new Error(`no window for ${id}`);
    const { x, y } = await homePoint(m, siteHomeBrowser(id), selector);
    await m.command("WebDriver:PerformActions", {
      actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
    });
    await m.command("WebDriver:ReleaseActions");
  } finally {
    await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
  }
}

/** A trusted click (synthesizeMouseEvent from the bar) on a bar button. */
const barClick = (id: string, testid: string) =>
  inSiteBar(
    m,
    id,
    `for (let i = 0; i < 100 && !doc.querySelector('[data-testid="' + arguments[0] + '"]'); i++) await new Promise((r) => setTimeout(r, 100));
     const r = doc.querySelector('[data-testid="' + arguments[0] + '"]').getBoundingClientRect();
     for (const type of ["mousedown", "mouseup"]) doc.defaultView.synthesizeMouseEvent(type, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1 });
     return true;`,
    [testid],
  );

/** Opens app `id` and waits for its home to have received its first message. */
async function openHome(id = "vidola"): Promise<void> {
  await openSite(id);
  await homeReady(id);
}

function writeMemory(id: string, current?: string): void {
  const dir = path.join(dataDir, "sites", id);
  mkdirSync(dir, { recursive: true });
  const when = new Date().toISOString();
  writeFileSync(
    path.join(dir, "memory.json"),
    JSON.stringify({ version: 1, values: { "encours.the-bear": { value: { titre: "The Bear", episode: "S2E4" }, url: "/serie/the-bear?e=4", when: when } }, positions: {} }),
  );
  if (current) writeFileSync(path.join(dir, "url.json"), JSON.stringify({ current: current, previous: ["vidola-a.localhost"], since: when }));
}

beforeAll(async () => {
  server = await startSitesServer();
  server.define("vidola-a.localhost", "/serie/the-bear", "<title>The Bear</title>");
  server.define("vidola-b.localhost", "/serie/the-bear", "<title>The Bear</title>");
  const png = (_req: unknown, res: { writeHead(s: number, h: object): { end(b: Buffer): void } }) => res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
  server.define("vidola-a.localhost", "/affiche.png", png as never);
  server.define("pub.localhost", "/pub.png", png as never);
  server.define("vidola-a.localhost", "/img/123", (_req, res) => res.writeHead(302, { Location: "/affiche.png" }).end());
  server.define("vidola-a.localhost", "/img/pub", (_req, res) => res.writeHead(302, { Location: server.url("pub.localhost", "/pub.png") }).end());
  for (let i = 0; i < 5; i++) server.define("vidola-a.localhost", `/boucle/${i}`, (_req, res) => res.writeHead(302, { Location: `/boucle/${i + 1}` }).end());
  dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  const declaration = { name: "Vidola", url: url("/"), domains: ["vidola-a.localhost"], login: ["compte.localhost"] };
  // Written before the launch: the watcher sees no initial event that would reread the apps on the way.
  // Documents with scripts that would run without the home's CSP (no meta in them) if the frame loaded them.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${url("/espion-svg-img")}" width="1" height="1"/><script>fetch("${url("/espion-svg-fetch")}")</script></svg>`;
  const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="${url("/espion-xhtml-img")}"/><script>fetch("${url("/espion-xhtml-fetch")}")</script></body></html>`;
  writeSite(dataDir, "vidola", { declaration, files: { "home/index.html": HOME, "home/img/logo.png": PNG, "home/app.js": "window.appJs = 1;", "home/style.css": "p { color: red; }", "home/x.svg": svg, "home/x.xhtml": xhtml } });
  writeSite(dataDir, "demenage", { declaration: { ...declaration, name: "Déménagé" }, files: { "home/index.html": HOME } });
  writeSite(dataDir, "auto", { declaration: { ...declaration, name: "Auto" }, files: { "home/index.html": AUTO } });
  writeSite(dataDir, "routeur", { declaration: { ...declaration, name: "Routeur" }, files: { "home/index.html": ROUTER } });
  writeSite(dataDir, "tube", { declaration: { ...declaration, name: "Tube" }, files: { "home/index.html": "<p>accueil</p>" } });
  writeSite(dataDir, "autre", { declaration: { name: "Autre", url: url("/", "vidola-b.localhost"), domains: ["vidola-b.localhost"] }, files: { "home/index.html": "<p>autre</p>" } });
  writeMemory("vidola");
  writeMemory("auto");
  writeMemory("demenage", "vidola-b.localhost");
  const actor = testActor(profile);
  w = await launchRessac({ dataDir, profile, env: { RESSAC_TEST_LOCAL_ADDRESSES: "1", ...actor.env }, prefs: actor.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, HOSTS);
}, 90_000);
afterAll(async () => {
  await w?.close();
  await server?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  if (profile) await rm(profile, { recursive: true, force: true });
});
beforeEach(() => void server.requests.splice(0));
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await inStore(`for (const id of store.sites.openIds()) await store.sites.close(id);`).catch(() => {});
  }
});

describe("site app home screen", () => {
  it("with a home: the site view stays hidden; « Entrer dans le site » loads the start once, ⌂ comes back without reloading", async () => {
    await openSite("tube");
    await expect.poll(() => inSiteBar(m, "tube", `return doc.querySelector('[data-testid="site-enter"]')?.textContent ?? null;`), { timeout: 10_000 }).toBe("Entrer dans le site");
    await expect.poll(async () => (await viewState("tube"))?.visible).toBe(false);
    expect((await viewState("tube"))!.url).toBe("");
    await barClick("tube", "site-enter");
    await expect.poll(async () => (await viewState("tube"))?.url, { timeout: 10_000 }).toBe(url("/"));
    expect((await viewState("tube"))!.visible).toBe(true);
    await expect.poll(() => inSiteView(m, "tube", "return document.readyState;").catch(() => null)).toBe("complete");
    await inSiteView(m, "tube", "window.marque = 7; return 1;");
    await barClick("tube", "site-home");
    await expect.poll(async () => (await viewState("tube"))?.visible).toBe(false);
    await barClick("tube", "site-enter");
    await expect.poll(async () => (await viewState("tube"))?.visible).toBe(true);
    expect(await inSiteView(m, "tube", "return window.marque;")).toBe(7);
  });

  it("the home gets the memory written by the test (encours.the-bear) and shows it; it has the widgets' guard", async () => {
    await openHome();
    // Out of the parent process, in the frames' process, sandboxed like <iframe sandbox="allow-scripts">.
    const frame = await m.execute<{ pid: number; parent: number; type: string; isNull: boolean; flags: number; uri: string }>(
      `const b = ${siteHomeBrowser("vidola")}, g = b.browsingContext.currentWindowGlobal;
       return { pid: g.osPid, parent: Services.appinfo.processID, type: b.remoteType, isNull: g.documentPrincipal.isNullPrincipal, flags: b.browsingContext.sandboxFlags, uri: g.documentURI.spec };`,
    );
    expect(frame.pid).not.toBe(frame.parent);
    expect(frame.type).toMatch(/^webIsolated=resource:\/\/ressac-frames-[0-9a-f]{16}$/);
    expect(frame.isNull).toBe(true);
    expect(frame.flags).toBe(1048191);
    expect(frame.uri).toMatch(/^resource:\/\/ressac-frames-[0-9a-f]{16}\/sites\/vidola-[0-9a-f]+\/index\.html$/);
    await expect.poll(() => inHome("vidola", `return document.getElementById("series").textContent;`)).toBe("encours.the-bear : The Bear /serie/the-bear?e=4");
    expect(await inHome("vidola", `return document.getElementById("domaine").textContent;`)).toBe("vidola-a.localhost");
    // Opaque origin, the guard in place (no WebRTC, WebTransport nor XSLT), no Ressac API.
    expect(await inHome("vidola", `return [fw.origin, typeof fw.RTCPeerConnection, typeof fw.WebTransport, typeof fw.XSLTProcessor, typeof fw.ressac];`)).toEqual(["null", "undefined", "undefined", "undefined", "undefined"]);
    expect(await inSiteBar(m, "vidola", `return doc.querySelector('[data-testid="site-enter"]').textContent;`)).toBe("Entrer dans le site");
  });

  it("it asks for « /serie/the-bear?e=4 »: the site view goes there on the current domain", async () => {
    await openHome("demenage");
    await expect.poll(async () => ((await received("demenage")) ?? []).find((x) => x.type === "memory")).toMatchObject({ domain: "vidola-b.localhost" });
    await clickOpen("demenage", "/serie/the-bear?e=4");
    await expect.poll(async () => (await viewState("demenage"))?.url, { timeout: 10_000 }).toBe(url("/serie/the-bear?e=4", "vidola-b.localhost"));
    expect((await viewState("demenage"))!.visible).toBe(true);
    expect(server.requests.filter((r) => r.host === "vidola-a.localhost")).toEqual([]);
  });

  it("it asks for javascript:alert(1), //pub.localhost/x, https://pub.localhost/: nothing opens", async () => {
    await openHome();
    // After a real click in the home: refused all the same.
    for (const address of ["javascript:alert(1)", "//pub.localhost/x", "https://pub.localhost/", url("/x", "pub.localhost"), "/\\pub.localhost/x", "x".repeat(2001)]) await clickOpen("vidola", address, { accept: false });
    await ask("vidola", { type: "open", url: "javascript:alert(1)" });
    // The same refusals through the bar's API (what the relay calls).
    const api = (a: string) => inSiteBar<boolean>(m, "vidola", "return await doc.defaultView.ressac.site.open(arguments[0]);", [a]);
    expect(await api("javascript:alert(1)")).toBe(false);
    expect(await api("https://pub.localhost/")).toBe(false);
    await sleep(500);
    expect(await viewState("vidola")).toEqual({ url: "", visible: false });
    expect(server.requests).toEqual([]);
    // The refusals consumed nothing: an address of the site opens right after a click.
    await clickOpen("vidola", "/serie/the-bear?e=4");
    await expect.poll(async () => (await viewState("vidola"))?.url, { timeout: 10_000 }).toBe(url("/serie/the-bear?e=4"));
  });

  it("an address the home composed waits on the card with the whole address: « Ne pas ouvrir » requests nothing, « Ouvrir » loads it", async () => {
    await openHome();
    await clickOpen("vidola", "/serie/the-bear?d=secret", { accept: false });
    await expect.poll(() => inSiteBar<string | null>(m, "vidola", `return doc.querySelector('[data-testid="site-home-zone"] [data-testid="site-start-url"]')?.textContent ?? null;`), { timeout: 10_000 }).toBe(url("/serie/the-bear?d=secret"));
    expect(await acceptHomeCard(m, "vidola", 3000, "refuse-start")).toBe(true);
    await sleep(1000);
    expect(server.requests.filter((r) => r.path.includes("secret"))).toEqual([]);
    expect(await viewState("vidola")).toEqual({ url: "", visible: false });
    await sleep(1100);
    await clickOpen("vidola", "/serie/the-bear?d=secret");
    await expect.poll(async () => (await viewState("vidola"))?.url, { timeout: 10_000 }).toBe(url("/serie/the-bear?d=secret"));
  });

  it("at most one address opened per second from the home", async () => {
    await openHome();
    await clickOpen("vidola", "/serie/the-bear?e=1");
    await expect.poll(async () => (await viewState("vidola"))?.url, { timeout: 10_000 }).toBe(url("/serie/the-bear?e=1"));
    await barClick("vidola", "site-home");
    await expect.poll(async () => (await viewState("vidola"))?.visible).toBe(false);
    await homeReady("vidola");
    await clickOpen("vidola", "/serie/the-bear?e=2");
    await sleep(300);
    expect(await viewState("vidola")).toEqual({ visible: false, url: url("/serie/the-bear?e=1") });
    await sleep(1100);
    await clickOpen("vidola", "/serie/the-bear?e=3");
    await expect.poll(async () => (await viewState("vidola"))?.url, { timeout: 10_000 }).toBe(url("/serie/the-bear?e=3"));
  });

  it("fetch from the home to the test server: no request received; it does not leave its home", async () => {
    await openHome();
    const spy = (c: string) => url(`/espion-${c}`);
    await probe("vidola", { attempt: "fetch", url: spy("fetch") });
    await expect.poll(() => inHome("vidola", "return fw.fetchResult ?? null;")).toBe("refused");
    await probe("vidola", { attempt: "fuites", img: spy("img"), beacon: spy("beacon"), form: spy("form") });
    // The frame navigating to the web, then to another app's home: refused.
    await probe("vidola", { attempt: "aller", url: spy("nav") });
    await sleep(500);
    await probe("vidola", { attempt: "aller", url: await otherHome() }).catch(() => {});
    await sleep(800);
    expect(server.requests).toEqual([]);
    expect(await homeUri("vidola")).toMatch(HOME_COPY);
    expect(await homeUri("vidola")).toContain("/sites/vidola-");
  });

  it("a script-bearing SVG or XHTML file, or any page that is not one of its .html, never loads in the home's frame: no request", async () => {
    await openHome();
    // The home's document stays the same one (a load sent back afterwards would give a new window).
    await inHome("vidola", "fw.marque = 7; return true;");
    const same = async (what: string) => {
      await sleep(800);
      expect(await inHome("vidola", "return fw.marque ?? null;"), what).toBe(7);
    };
    // The home's own code: Firefox refuses its navigations to resource: (« Access … from script denied »), a real
    // click on a link and a <meta refresh> do nothing (measured).
    for (const target of ["x.svg", "x.xhtml", "img/logo.png", await otherHome()]) {
      await probe("vidola", { attempt: "aller", url: target });
      await same(`aller ${target}`);
    }
    await probe("vidola", { attempt: "refresh", url: "x.svg" });
    await same("refresh");
    await probe("vidola", { attempt: "lien", url: "x.svg" });
    await sleep(200);
    await realClick("vidola", "#lien");
    await same("lien");
    // Any other load of the frame (here put there by the chrome) is stopped as it starts (guardHome): the same document.
    for (const target of ["x.svg", "img/logo.png"]) {
      await m.execute(`const b = ${siteHomeBrowser("vidola")}; b.loadURI(Services.io.newURI(new URL(arguments[0], b.currentURI.spec).href), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return 1;`, [target]);
      await same(`chrome ${target}`);
    }
    // about:blank, the one other page it lets load: sent back to its own page (a new document), which gets its memory again.
    await probe("vidola", { attempt: "aller", url: "about:blank" });
    await expect.poll(() => inHome("vidola", "return fw.marque === undefined && fw.recus.some((x) => x.type === 'memory');"), { timeout: 10_000 }).toBe(true);
    expect(server.requests).toEqual([]);
  });

  it("a site image asked for comes back as data: (with the app's cookies); a pub.localhost image comes back null", async () => {
    await openHome();
    await inStore(
      `const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
       const { userContextId } = ContextualIdentityService.getPrivateIdentity("userContextIdInternal.webaios-site-vidola");
       Services.cookies.add("vidola-a.localhost", "/", "essai", "appli", false, false, true, Date.now() + 86_400_000, { userContextId }, Ci.nsICookie.SAMESITE_LAX, Ci.nsICookie.SCHEME_HTTP, false);`,
    );
    await ask("vidola", { type: "image", n: 1, url: url("/affiche.png") });
    await ask("vidola", { type: "image", n: 2, url: url("/pub.png", "pub.localhost") });
    await expect.poll(async () => ((await received("vidola")) ?? []).filter((x) => x.type === "image").length, { timeout: 15_000 }).toBe(2);
    const images = (await received("vidola"))!.filter((x) => x.type === "image");
    expect(images.find((x) => x.n === 1)?.data).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(images.find((x) => x.n === 2)?.data).toBeNull();
    expect(server.requests.map((r) => [r.host, r.path, r.cookie])).toEqual([["vidola-a.localhost", "/affiche.png", "essai=appli"]]);
    // Its own images (accueil/img/) load from the served copy, without going through Ressac.
    await probe("vidola", { attempt: "logo", url: "img/logo.png" });
    await expect.poll(() => inHome("vidola", "return fw.logo ?? null;")).toBe(1);
  });

  it("⌂ comes back to the home, « Entrer dans le site » finds the page it was on (same URL, no reload)", async () => {
    await openHome();
    await clickOpen("vidola", "/serie/the-bear?e=4");
    const u = url("/serie/the-bear?e=4");
    await expect.poll(async () => (await viewState("vidola"))?.url, { timeout: 10_000 }).toBe(u);
    await expect.poll(() => inSiteView(m, "vidola", "return document.readyState;").catch(() => null)).toBe("complete");
    await inSiteView(m, "vidola", "window.marque = 7; return 1;");
    await barClick("vidola", "site-home");
    await expect.poll(async () => (await viewState("vidola"))?.visible).toBe(false);
    // The home comes back (a new frame) and reads the memory again.
    await expect.poll(() => inHome("vidola", `return document.getElementById("series").textContent;`)).toContain("The Bear");
    const before = server.requests.length;
    await barClick("vidola", "site-enter");
    await expect.poll(async () => (await viewState("vidola"))?.visible).toBe(true);
    expect((await viewState("vidola"))!.url).toBe(u);
    expect(await inSiteView(m, "vidola", "return window.marque;")).toBe(7);
    expect(server.requests.length).toBe(before);
  });

  it("an « ouvrir » sent as the home loads is refused; the same after a click in the home opens", async () => {
    await openHome("auto");
    // Without a gesture, even asked again by the home's code (a click it simulates included): nothing opens.
    await ask("auto", { type: "open", url: "/serie/the-bear?e=9" });
    await inHome("auto", `document.getElementById("ouvrir").click(); return true;`);
    await sleep(1500);
    expect(await viewState("auto")).toEqual({ url: "", visible: false });
    expect(server.requests).toEqual([]);
    // A real WebDriver click in the frame opens; ⌂ does not go back to the site: the home reloaded asks again, to no effect.
    await clickOpen("auto", "/serie/the-bear?e=4");
    await expect.poll(async () => (await viewState("auto"))?.url, { timeout: 10_000 }).toBe(url("/serie/the-bear?e=4"));
    await barClick("auto", "site-home");
    await expect.poll(async () => (await viewState("auto"))?.visible).toBe(false);
    await sleep(2000);
    expect(await viewState("auto")).toEqual({ visible: false, url: url("/serie/the-bear?e=4") });
  });

  it("a web page in a tab loads no home file: neither the guessable forms nor the served copy under another token", async () => {
    await openHome();
    // The frames' substitution is open to content (remote frames need it): only its launch token hides it (spec constraint 3).
    const real = (await homeUri("vidola"))!.replace(/\/index\.html$/, "");
    const token = real.match(/ressac-frames-([0-9a-f]{16})/)![1]!;
    const other = real.replace(token, token.replace(/^./, (c) => (c === "0" ? "1" : "0")));
    server.define("pub.localhost", "/sonde", "<title>sonde</title><p>sonde</p>");
    const probeFn = url("/sonde", "pub.localhost");
    await inStore(`store.dispatch({ type: "openTab", windowId: store.state.windows[0].id, url: arguments[0], activate: true });`, [probeFn]);
    await expect.poll(() => m.execute<boolean>(`const b = gBrowser.selectedBrowser; return b.currentURI.spec === arguments[0] && !b.webProgress.isLoadingDocument;`, [probeFn]), { timeout: 15_000 }).toBe(true);
    // The former forms (the id as host, a counter), the substitution root, and the copy actually served.
    const guessable = ["resource://ressac-site-vidola", "resource://ressac-frames", "resource://ressac-frames/sites"];
    const urls = [...guessable, other].flatMap((b) => [`${b}/`, `${b}/index.html`, `${b}/app.js`, `${b}/style.css`, `${b}/img/logo.png`]);
    const results = await inBrowser<Record<string, string>>(
      m,
      "gBrowser.selectedBrowser",
      `const load = (make) => new Promise((ok) => { const el = make(); el.onload = () => ok("loaded"); el.onerror = () => ok("error"); setTimeout(() => ok("timeout"), 3000); document.head.append(el); });
       return (async () => {
         const out = {};
         for (const u of arguments[0]) {
           out["script " + u] = await load(() => Object.assign(document.createElement("script"), { src: u }));
           out["css " + u] = await load(() => Object.assign(document.createElement("link"), { rel: "stylesheet", href: u }));
           out["img " + u] = await load(() => Object.assign(document.createElement("img"), { src: u }));
           out["fetch " + u] = await fetch(u).then(() => "loaded", () => "error");
         }
         out.appJs = String(window.appJs);
         return out;
       })();`.replace("arguments[0]", JSON.stringify(urls)),
    );
    expect(Object.entries(results).filter(([, v]) => v !== "error" && v !== "undefined")).toEqual([]);
    // The served copy itself still loads in its own frame.
    await probe("vidola", { attempt: "logo", url: "img/logo.png" });
    await expect.poll(() => inHome("vidola", "return fw.logo ?? null;")).toBe(1);
  });

  it("a site image redirected (a real 302): followed on the site, refused to pub.localhost without going there", async () => {
    await openHome();
    await inStore(
      `const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
       const { userContextId } = ContextualIdentityService.getPrivateIdentity("userContextIdInternal.webaios-site-vidola");
       Services.cookies.add("vidola-a.localhost", "/", "essai", "appli", false, false, true, Date.now() + 86_400_000, { userContextId }, Ci.nsICookie.SAMESITE_LAX, Ci.nsICookie.SCHEME_HTTP, false);`,
    );
    await ask("vidola", { type: "image", n: 1, url: url("/img/123") });
    await ask("vidola", { type: "image", n: 2, url: url("/img/pub") });
    await ask("vidola", { type: "image", n: 3, url: url("/boucle/0") });
    await expect.poll(async () => ((await received("vidola")) ?? []).filter((x) => x.type === "image").length, { timeout: 15_000 }).toBe(3);
    const images = (await received("vidola"))!.filter((x) => x.type === "image");
    expect(images.find((x) => x.n === 1)?.data).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(images.find((x) => x.n === 2)?.data).toBeNull();
    expect(images.find((x) => x.n === 3)?.data).toBeNull();
    const seen = server.requests.map((r) => `${r.host}${r.path}`);
    expect(seen.filter((v) => v.startsWith("pub.localhost"))).toEqual([]);
    // The redirect followed keeps the app's cookies; the loop stops after 3 hops.
    expect(server.requests.find((r) => r.path === "/affiche.png")?.cookie).toBe("essai=appli");
    expect(seen.filter((v) => v.includes("/boucle/"))).toEqual(["/boucle/0", "/boucle/1", "/boucle/2", "/boucle/3"].map((c) => `vidola-a.localhost${c}`));
  });

  it("a home whose router calls pushState as it loads: a bounded number of loads, and it is sent nothing", async () => {
    await openSite("routeur");
    // Every document load in the home's frame from its first one, counted chrome side for 3 s.
    await expect.poll(() => m.execute<boolean>(`return !!(${siteHomeBrowser("routeur")})?.browsingContext?.webProgress;`), { timeout: 15_000 }).toBe(true);
    await m.execute(
      `const b = ${siteHomeBrowser("routeur")}; b.ressacTestLoads = 0;
       b.ressacTestCounter = { QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
         onStateChange(_p, _r, f) { if (f & Ci.nsIWebProgressListener.STATE_START && f & Ci.nsIWebProgressListener.STATE_IS_DOCUMENT) b.ressacTestLoads++; } };
       b.browsingContext.webProgress.addProgressListener(b.ressacTestCounter, Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT);`,
    );
    await sleep(3000);
    const loads = await m.execute<number>(`return (${siteHomeBrowser("routeur")}).ressacTestLoads;`);
    console.log(`[pushState] home loads over 3 s: ${loads}; address: ${await homeUri("routeur")}`);
    // Firefox lets the sandboxed (opaque origin) document rewrite its address: it then fails the home's check.
    expect(await homeUri("routeur")).toMatch(/^resource:\/\/ressac-frames-[0-9a-f]{16}\/settings$/);
    // At most its first loads (about:blank, the copy, the load-bearing revert); a guard reload each pushState looped (286).
    expect(loads).toBeLessThanOrEqual(3);
    expect(await inFrame<unknown[]>(m, { browser: siteHomeBrowser("routeur") }, "JSON.parse(JSON.stringify(window.wrappedJSObject.recus))")).toEqual([]);
  });

  // Measured before the fix: after the kill, the home stays blank for good.
  it("the frames' process killed: the home comes back with its memory, still guarded", async () => {
    await openHome();
    await killFrames(m);
    await expect.poll(() => inHome("vidola", `return document.getElementById("series").textContent;`).catch(() => null), { timeout: 20_000 }).toBe("encours.the-bear : The Bear /serie/the-bear?e=4");
    expect(await homeUri("vidola")).toMatch(HOME_COPY);
    // guardHome watches the new browsing context: a load put there by the chrome is still stopped as it starts.
    await inHome("vidola", "fw.marque = 7; return true;");
    await m.execute(`const b = ${siteHomeBrowser("vidola")}; b.loadURI(Services.io.newURI(new URL("x.svg", b.currentURI.spec).href), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return 1;`);
    await sleep(800);
    expect(await inHome("vidola", "return fw.marque ?? null;")).toBe(7);
  }, 60_000);
});
