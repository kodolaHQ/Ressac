import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testActor } from "./agent-extensions";
import { waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { inSiteBar, inSiteView, resolveLocalHosts, siteWindowExpr, startSitesServer, writeSite } from "./sites";
import { missingApi } from "./ui";

// Plan 32 Task 2: the « Autoriser les retouches » grant card. No no-drag buttons:
// the bar keeps Firefox's native title bar, nothing drags it.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const HOSTS = ["vidola-a.localhost", "lecteur.localhost", "compte.localhost"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let dataDir: string;
let profile: string;

const url = (p: string, host = "vidola-a.localhost") => server.url(host, p);
const reader = () => server.url("lecteur.localhost", "/*").replace(/^http:/, "https:");
const declaration = (extra: { login?: string[] } = {}) => ({
  name: "Vidola",
  url: url("/serie/the-bear"),
  domains: ["vidola-a.localhost"],
  login: extra.login ?? ["compte.localhost"],
  tweaks: [{ matches: ["/serie/*"], js: ["a.js"], css: ["cacher.css"], frames: [reader()] }],
  resume: true,
});
const A_JS = 'document.body.dataset.retouche = "oui";';
const FILES = { "tweaks/a.js": A_JS, "tweaks/cacher.css": ".shorts { display: none; }" };
const grantsFile = () => path.join(dataDir, "site-grants.json");
const grants = (): Record<string, unknown> => (existsSync(grantsFile()) ? JSON.parse(readFileSync(grantsFile(), "utf8")) : {});

const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
const openSite = (id = "vidola") => inStore(`await store.agent.request("sites.act", { id: arguments[0], action: "open", window: store.state.windows[0].id });`, [id]);
const viewUrl = (id = "vidola") => m.execute<string>(`const u = ${siteWindowExpr(id)}?.gBrowser?.selectedBrowser.currentURI?.spec ?? ""; return u === "about:blank" ? "" : u;`);
/** The view's address, and whether it shows (the bar covers the window on the card and the home). */
const viewState = (id = "vidola") =>
  m.execute<{ url: string; visible: boolean } | null>(
    `const win = ${siteWindowExpr(id)}; if (!win?.gBrowser) return null;
     const spec = win.gBrowser.selectedBrowser.currentURI?.spec ?? "";
     return { url: spec === "about:blank" ? "" : spec, visible: !win.document.documentElement.hasAttribute("webaios-site-home") };`,
  );
const state = (id = "vidola") => m.execute<{ viewState: string; hasHome: boolean; grant: { hash: string; login: string[]; tracked: string[] } | null }>(`return JSON.parse(JSON.stringify(${siteWindowExpr(id)}.webaiosSiteWindow.state()));`);
const view = <T = unknown>(expr: string, o: { id?: string; frame?: number } = {}) => inSiteView<T>(m, o.id ?? "vidola", `return ${expr};`, { frame: o.frame }).catch(() => null);
const shorts = () => view('getComputedStyle(document.getElementById("shorts")).display');
const tweak = () => view("document.body.dataset.retouche ?? null");
/** The card's text, or null while the bar shows no card. */
const card = (testid?: string, id = "vidola") =>
  inSiteBar<string | null>(m, id, `const c = doc.querySelector(${JSON.stringify(testid ? `[data-testid="${testid}"]` : '[data-testid="carte-accord-site"]')}); return c ? c.textContent : null;`);
const heading = () => inSiteBar<string | null>(m, "vidola", `return doc.querySelector('[data-testid="carte-accord-site"] :is(h1,h2,h3)')?.textContent ?? null;`);
/** A click on a bar button, once there. */
const click = (testid: string, id = "vidola") =>
  inSiteBar(m, id, `for (let i = 0; i < 100 && !doc.querySelector('[data-testid="' + arguments[0] + '"]'); i++) await new Promise((r) => setTimeout(r, 100)); doc.querySelector('[data-testid="' + arguments[0] + '"]').click(); return true;`, [testid]);
const barApi = <T>(body: string, args: unknown[] = []) => inSiteBar<T>(m, "vidola", `const site = doc.defaultView.webaios.site; ${body}`, args);
const rewriteDeclaration = (d: object) => writeFileSync(path.join(dataDir, "workspace", "sites", "vidola", "site.json"), JSON.stringify(d));

/** Opens the app and waits for its card. */
async function openToCard() {
  await openSite();
  await expect.poll(() => card(), { timeout: 15_000 }).not.toBeNull();
}
/** Closes the app's window (as the user would) and opens it again. */
async function reopen() {
  await inStore(`await store.sites.close("vidola");`);
  await sleep(300);
  await openToCard().catch(() => openSite());
}

beforeAll(async () => {
  server = await startSitesServer();
  server.define("vidola-a.localhost", "/serie/the-bear", '<title>The Bear</title><div class="shorts" id="shorts">shorts</div><p>épisode</p>');
  server.define("vidola-a.localhost", "/lecteur", `<title>Lecteur</title><div class="shorts" id="shorts">shorts</div><iframe id="l" src="${url("/v", "lecteur.localhost")}"></iframe>`);
  server.define("lecteur.localhost", "/v", "<title>Vidéo</title><p>vidéo</p>");
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  writeSite(dataDir, "vidola", { declaration: declaration(), files: FILES });
  const actor = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_LOCAL_ADDRESSES: "1", ...actor.env }, prefs: actor.prefs });
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
beforeEach(async () => {
  server.requests.splice(0);
  writeSite(dataDir, "vidola", { declaration: declaration(), files: FILES });
  rmSync(path.join(dataDir, "workspace", "sites", "vidola", "home"), { recursive: true, force: true });
  rmSync(path.join(dataDir, "sites", "vidola"), { recursive: true, force: true });
  writeFileSync(grantsFile(), "{}");
});
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await inStore(`for (const id of store.sites.openIds()) await store.sites.close(id);`).catch(() => {});
  }
});

describe("grant card", () => {
  it("first open of an app with tweaks: the card lists domains, sign-in, files and resume; the site view is hidden and loads nothing (sites.spec.ts:1007)", async () => {
    await openToCard();
    expect(await heading()).toBe("Autoriser les retouches de « Vidola » ?");
    expect(await card("accord-site-domaines")).toContain("vidola-a.localhost");
    expect(await card("accord-site-connexion")).toContain("compte.localhost");
    expect(await card("accord-site-cadres")).toContain(reader());
    expect(await card("accord-site-fichiers")).toContain("a.js");
    expect(await card("accord-site-fichiers")).toContain("cacher.css");
    expect(await card("accord-site-reprise")).toBe("Reprend les vidéos à la minute");
    expect(await card()).toContain("Ses retouches voient et modifient les pages de ces domaines. Une image ajoutée à la page peut encore envoyer des données à un autre site.");
    expect(await card("accorder-site")).toBe("Autoriser");
    expect(await card("refuser-site")).toBe("Ouvrir sans retouches");
    expect(await viewState()).toEqual({ url: "", visible: false });
    await sleep(300);
    expect(server.requests.filter((r) => r.host === "vidola-a.localhost")).toEqual([]);
  });

  it("Ouvrir sans retouches: the site opens, .shorts visible, no position noted; the card comes back at the next open (sites.spec.ts:1027)", async () => {
    await openToCard();
    await click("refuser-site");
    await expect.poll(() => viewUrl(), { timeout: 15_000 }).toBe(url("/serie/the-bear"));
    await expect.poll(() => view("document.readyState")).toBe("complete");
    expect((await viewState())?.visible).toBe(true);
    expect(await card()).toBeNull();
    expect(await shorts()).toBe("block");
    expect(await tweak()).toBeNull();
    const memory = path.join(dataDir, "sites", "vidola", "memory.json");
    expect(!existsSync(memory) || Object.keys(JSON.parse(readFileSync(memory, "utf8")).positions).length === 0).toBe(true);
    expect(grants().vidola).toBeFalsy();
    // Refusing counts for this open only.
    await reopen();
    expect(await card()).not.toBeNull();
    expect((await viewState())?.visible).toBe(false);
  });

  it("Autoriser: .shorts hidden; opening again does not ask again (sites.spec.ts:1046)", async () => {
    await openToCard();
    await click("accorder-site");
    await expect.poll(() => viewUrl(), { timeout: 15_000 }).toBe(url("/serie/the-bear"));
    await expect.poll(() => shorts(), { timeout: 10_000 }).toBe("none");
    await expect.poll(() => tweak()).toBe("oui");
    expect((await viewState())?.visible).toBe(true);
    expect(grants().vidola).toEqual({ domains: ["vidola-a.localhost"], login: ["compte.localhost"], frames: [reader()], resume: true });
    await reopen();
    await expect.poll(() => viewUrl(), { timeout: 15_000 }).toBe(url("/serie/the-bear"));
    expect(await card()).toBeNull();
    await expect.poll(() => shorts(), { timeout: 10_000 }).toBe("none");
  });

  it("changing the code of a.js: no card (sites.spec.ts:1063)", async () => {
    await openToCard();
    await click("accorder-site");
    await expect.poll(() => tweak(), { timeout: 15_000 }).toBe("oui");
    writeFileSync(path.join(dataDir, "workspace", "sites", "vidola", "tweaks", "a.js"), 'document.body.dataset.retouche = "v2";');
    await expect.poll(() => tweak(), { timeout: 10_000 }).toBe("v2");
    expect(await card()).toBeNull();
    expect((await viewState())?.visible).toBe(true);
  });

  it("adding a sign-in domain to site.json: the card comes back, nothing injected before the choice (sites.spec.ts:1074)", async () => {
    await openToCard();
    await click("accorder-site");
    await expect.poll(() => tweak(), { timeout: 15_000 }).toBe("oui");
    await view("(window.marque = 1, 1)");
    rewriteDeclaration(declaration({ login: ["compte.localhost", "autre-compte.localhost"] }));
    await expect.poll(() => card(), { timeout: 10_000 }).not.toBeNull();
    expect(await card("accord-site-connexion")).toContain("autre-compte.localhost");
    expect((await viewState())?.visible).toBe(false);
    // The page is reloaded behind the card, without tweaks.
    await expect.poll(() => view("window.marque ?? null"), { timeout: 10_000 }).toBeNull();
    await expect.poll(() => view("document.readyState")).toBe("complete");
    await sleep(300);
    expect(await tweak()).toBeNull();
    expect(await shorts()).toBe("block");
    // Allow again: the page reloads with its tweaks.
    await click("accorder-site");
    await expect.poll(() => shorts(), { timeout: 10_000 }).toBe("none");
    expect((await viewState())?.visible).toBe(true);
  });

  it("opening the open window again after the grant was removed: the card comes back, the page reloaded without tweaks (sites.spec.ts:1096)", async () => {
    await openToCard();
    await click("accorder-site");
    await expect.poll(() => shorts(), { timeout: 15_000 }).toBe("none");
    await view("(window.marque = 1, 1)");
    writeFileSync(grantsFile(), "{}");
    await openSite();
    await expect.poll(() => card(), { timeout: 10_000 }).not.toBeNull();
    expect((await viewState())?.visible).toBe(false);
    await expect.poll(() => view("window.marque ?? null"), { timeout: 10_000 }).toBeNull();
    await expect.poll(() => view("document.readyState")).toBe("complete");
    await sleep(300);
    expect(await shorts()).toBe("block");
    expect(await tweak()).toBeNull();
    expect(await m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].filter((w) => w.document.documentElement.getAttribute("webaios-site") === "vidola").length;`)).toBe(1);
  });

  it("Allow with the hash of v1 after v2 was written: nothing is granted, the card stays and shows v2 (sites.spec.ts:1115)", async () => {
    await openToCard();
    const v1 = (await state()).grant!.hash;
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    rewriteDeclaration(declaration({ login: ["compte.localhost", "evil.localhost"] }));
    await expect.poll(async () => (await state()).grant?.hash, { timeout: 10_000 }).not.toBe(v1);
    await barApi(`await site.grant(true, arguments[0]); return true;`, [v1]);
    await sleep(300);
    expect(grants().vidola).toBeFalsy();
    expect(await card("accord-site-connexion")).toContain("evil.localhost");
    expect((await viewState())?.visible).toBe(false);
    // With the hash of the card up to date, the click grants.
    await click("accorder-site");
    await expect.poll(() => shorts(), { timeout: 15_000 }).toBe("none");
    expect((grants().vidola as { login: string[] }).login).toEqual(["compte.localhost", "evil.localhost"]);
  });

  it("the domains added by address tracking are named on the card (sites.spec.ts:1137)", async () => {
    const dir = path.join(dataDir, "sites", "vidola");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "url.json"), JSON.stringify({ current: "vidola-b.localhost", previous: ["vidola-a.localhost"], since: new Date().toISOString() }));
    await openToCard();
    expect(await card("accord-site-suivis")).toContain("vidola-b.localhost");
    expect(await card("accord-site-suivis")).not.toContain("vidola-a.localhost");
  });

  it("the choice is refused from the bar's invalid requests: a hash that is not a bounded string rejects, nothing is granted (sites.spec.ts:1149)", async () => {
    await openToCard();
    const denial = await barApi<string>(`return site.grant(true, "x".repeat(200)).then(() => "accepted", (e) => e.message);`);
    expect(denial).toBe("invalid accord request");
    const notBool = await barApi<string>(`return site.grant("yes", "x").then(() => "accepted", (e) => e.message);`);
    expect(notBool).toBe("invalid accord request");
    await sleep(200);
    expect(grants().vidola).toBeFalsy();
    expect(await card()).not.toBeNull();
  });

  it("nothing in the site view, a sub-frame or the home frame reaches the bar's controller: nothing is granted (sites.spec.ts:1149)", async () => {
    // A live page behind the card: allowed once, then the grant removed and the app opened again.
    await openToCard();
    await click("accorder-site");
    await expect.poll(() => shorts(), { timeout: 15_000 }).toBe("none");
    await view(`(location.href = ${JSON.stringify(url("/lecteur"))}, 1)`);
    await expect.poll(() => viewUrl(), { timeout: 10_000 }).toBe(url("/lecteur"));
    await expect.poll(() => view("document.readyState")).toBe("complete");
    writeFileSync(grantsFile(), "{}");
    await openSite();
    await expect.poll(() => card(), { timeout: 10_000 }).not.toBeNull();
    await expect.poll(() => view("document.readyState")).toBe("complete");
    await expect.poll(() => view("document.getElementById('l') ? 1 : 0")).toBe(1);
    const hash = (await state()).grant!.hash;
    const attack = `(() => {
      const r = [];
      for (const t of [() => typeof window.parent.webaiosSiteWindow, () => typeof top.webaiosSiteWindow, () => typeof top.webaios, () => typeof window.webaiosSiteWindow, () => typeof window.webaios]) {
        try { r.push(t()); } catch (e) { r.push("blocked"); }
      }
      for (const target of [window.parent, window.top]) {
        try { target.postMessage({ type: "grant", yes: true, hash: ${JSON.stringify(hash)} }, "*"); } catch (e) {}
      }
      return r;
    })()`;
    const inView = await view<string[]>(attack);
    const inFrame = await view<string[]>(attack, { frame: 0 });
    for (const r of [inView, inFrame]) expect(r!.every((x) => x === "undefined" || x === "blocked")).toBe(true);
    await sleep(500);
    expect(grants().vidola).toBeFalsy();
    expect(await card()).not.toBeNull();
    expect((await state()).viewState).toBe("grant");
  });

  it("rewriting site.json to add a home while the card shows: the home comes after the choice, never before", async () => {
    await openToCard();
    mkdirSync(path.join(dataDir, "workspace", "sites", "vidola", "home"), { recursive: true });
    writeFileSync(path.join(dataDir, "workspace", "sites", "vidola", "home", "index.html"), "<p>accueil</p>");
    // A home-only change is not a reread: the declaration's rewrite is.
    rewriteDeclaration(declaration());
    await expect.poll(async () => (await state()).hasHome, { timeout: 10_000 }).toBe(true);
    expect((await state()).viewState).toBe("grant");
    await click("refuser-site");
    await expect.poll(async () => (await state()).viewState, { timeout: 10_000 }).toBe("home");
  });
});

describe("home frame", () => {
  // The home's own script tries what a forged request would: reach the bar's controller, post an grant.
  const HOME = `<!doctype html><title>Accueil</title><p>accueil</p><script>
    addEventListener("message", (e) => {
      if (!e.data || e.data.essai !== "attaque") return;
      const r = [];
      for (const t of [() => typeof parent.webaiosSiteWindow, () => typeof top.webaios, () => typeof top.webaiosSiteWindow]) {
        try { r.push(t()); } catch (err) { r.push("blocked"); }
      }
      window.attaque = r;
      for (const target of [parent, top]) {
        try { target.postMessage({ type: "grant", yes: true, hash: e.data.hash }, "*"); } catch (err) {}
      }
    });
    parent.postMessage({ type: "ready" }, "*");
  </script>`;

  it("a home frame cannot reach the controller nor post an grant (sites.spec.ts:1149)", async () => {
    writeSite(dataDir, "vidola", { declaration: declaration(), files: { ...FILES, "home/index.html": HOME } });
    await openToCard();
    expect(await state().then((s) => s.viewState)).toBe("grant");
    const hash = (await state()).grant!.hash;
    // The home is not mounted while the card shows.
    expect(await inSiteBar(m, "vidola", `return doc.querySelector('[data-testid="site-cadre-accueil"]') ? 1 : 0;`)).toBe(0);
    await click("refuser-site");
    const home = (body: string) =>
      inSiteBar<unknown>(
        m,
        "vidola",
        `const home = doc.querySelector('[data-testid="site-cadre-accueil"]');
         const fw = home?.contentDocument?.defaultView?.wrappedJSObject;
         if (!fw || !String(home.contentDocument.documentURI).startsWith("resource://webaios-site-")) return null;
         ${body}`,
        [hash],
      );
    await expect.poll(() => home("return 1;"), { timeout: 15_000 }).toBe(1);
    // Posted until the home's listener is there.
    await expect
      .poll(async () => (await home(`home.contentWindow.postMessage({ essai: "attaque", empreinte: arguments[0] }, "*"); return fw.attaque ? JSON.parse(JSON.stringify(fw.attaque)) : null;`)) ?? null, { timeout: 15_000 })
      .not.toBeNull();
    const r = (await home("return JSON.parse(JSON.stringify(fw.attaque));")) as string[];
    expect(r.every((x) => x === "undefined" || x === "blocked")).toBe(true);
    await sleep(500);
    expect(grants().vidola).toBeFalsy();
  });

  it("reopening an app whose home has gone: the view goes to the site (sites.spec.ts:1187)", async () => {
    writeSite(dataDir, "vidola", { declaration: { name: "Tube", url: url("/serie/the-bear"), domains: ["vidola-a.localhost"] }, files: { "home/index.html": "<p>accueil</p>" } });
    await openSite();
    await expect.poll(async () => (await state()).viewState, { timeout: 15_000 }).toBe("home");
    rmSync(path.join(dataDir, "workspace", "sites", "vidola", "home"), { recursive: true });
    await openSite();
    await expect.poll(() => viewUrl(), { timeout: 15_000 }).toBe(url("/serie/the-bear"));
    expect((await viewState())?.visible).toBe(true);
    expect((await state()).viewState).toBe("site");
  });
});
