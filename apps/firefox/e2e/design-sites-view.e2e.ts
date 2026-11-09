import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bubbleSlot, rectCapture } from "../chrome/store/design-copies";
import { CAPTURE_WARNING_SITE, UNAVAILABLE_DESIGN_SITE } from "../shared/design-guards";
import { testActor } from "./agent-extensions";
import { armActor, clearLog, CSP, CSP_PAGE, FRAME_PAGE, pageLog, trustedMouse } from "./design";
import {
  OTHER_PAGE,
  WITH_HOME,
  withHomeDeclaration,
  overlayOf,
  LOGIN_PAGE,
  inStore,
  openSite,
  readPng,
  TWEAK,
  S5_PAGE,
  siteKey,
  siteMouse,
  toSite,
  TUNING_PAGE,
  tuningDeclaration,
  viewExpr,
  viewPoint,
  siteExpr,
} from "./design-sites";
import { waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { grantSite, inSiteView, resolveLocalHosts, startSitesServer, writeSite } from "./sites";

// Plan 36 Task 1: the design service's `site` target in a site app's view (spike S5), driven through store.design with
// the real overlays. Apps: tuning, vidola (spike S5's hostile page and tweak),
// avec-accueil (a home). Block 15345-15349: sites on 15345, a frame of another origin on 127.0.0.1:15346.

const PORT = 15345;
const FRAME_PORT = 15346;
const IDS = ["tuning", "vidola", "avec-accueil"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = (id: string) => ({ type: "site", id });

let server: Awaited<ReturnType<typeof startSitesServer>>;
let frames: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const dirs: string[] = [];
const url = (host: string, path = "/") => server.url(host, path);
const vidola = () => ({ nom: "Vidola", adresse: url("vidola-a.localhost", "/design"), domaines: ["vidola-a.localhost"], retouches: [{ correspond: ["/design"], js: ["sonde.js"], css: ["cacher.css"] }] });

beforeAll(async () => {
  server = await startSitesServer({ port: PORT });
  server.definir("tuning-a.localhost", "/", TUNING_PAGE);
  server.definir("tuning-a.localhost", "/autre", OTHER_PAGE);
  server.definir("tuning-a.localhost", "/csp", (_req: unknown, res: ServerResponse) => void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP }).end(CSP_PAGE));
  server.definir("tuning-a.localhost", "/oop", TUNING_PAGE.replace("<script>", `<iframe id="cadre" src="http://127.0.0.1:${FRAME_PORT}/frame" style="width:300px;height:120px;border:0"></iframe><script>`));
  server.definir("compte-tuning.localhost", "/connexion", LOGIN_PAGE);
  server.definir("vidola-a.localhost", "/design", S5_PAGE);
  frames = await startServer({ port: FRAME_PORT, routes: { "/frame": (_req, res) => void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(FRAME_PAGE) } });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  writeSite(dataDir, "tuning", { declaration: tuningDeclaration(url), fichiers: { "retouches/tuning.css": "/* rien */" } });
  writeSite(dataDir, "avec-accueil", { declaration: withHomeDeclaration(url), fichiers: { "accueil/index.html": WITH_HOME } });
  writeSite(dataDir, "vidola", { declaration: vidola(), fichiers: { "retouches/sonde.js": TWEAK, "retouches/cacher.css": ".cache { display: none; }" } });
  await grantSite(dataDir, "tuning", tuningDeclaration(url));
  await grantSite(dataDir, "vidola", vidola());
  const a = testActor(profile);
  // An element's fullscreen without a gesture: the test's gestures would be the viewfinder's while it aims.
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1", ...a.env }, prefs: { ...a.prefs, "full-screen-api.allow-trusted-requests-only": false } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, ["tuning-a.localhost", "compte-tuning.localhost", "vidola-a.localhost"]);
}, 120_000);
afterAll(async () => {
  await w?.close();
  await server?.fermer();
  await frames?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
afterEach(async () => {
  await inStore(m, `for (const id of arguments[0]) { await store.design.stop({ type: "site", id }); store.design.closeOverlay({ type: "site", id }, "panier"); } return 1;`, [IDS]);
});

const state = (id: string) => inStore<{ actif: boolean; projet: { projet: string } | null; indisponible: string | null; panier: number }>(m, "return await store.design.etat(arguments[0]);", [T(id)]);
const toggle = (id: string) => inStore(m, "await store.design.toggle(arguments[0]); return 1;", [T(id)]);
const add = (id: string, text: string) => inStore<{ ok: boolean }>(m, "return await store.design.add(arguments[0], arguments[1]);", [T(id), text]);
const bubble = (id: string) =>
  inStore<{ etiquette: string; source: string | null; avertissement: string | null; projet: string } | null>(m, 'return store.design.overlayContext(arguments[0], ["bulle"]);', [T(id)]);
const cart = (id: string) => inStore<number>(m, `return (await store.agent.request("design.suivi", { projet: "site-" + arguments[0] })).panier;`, [id]);
const hosts = (id: string) => inSiteView<number>(m, id, `return document.getElementsByTagName("webaios-viseur").length;`).catch(() => -1);
const overlayRect = (id: string) => overlayOf<{ x: number; y: number; width: number; height: number }>(m, id, "const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };");
const notice = (id: string) => inStore<{ genre: string; texte?: string } | null>(m, "return store.sites.controller(arguments[0]).state().avis;", [id]);
const view = <T = unknown>(id: string, expr: string) => inSiteView<T>(m, id, `return ${expr};`).catch(() => null);
const geometry = (id: string) =>
  m.execute<{ x: number; y: number; width: number; height: number; w: number; h: number; z: number }>(
    `const b = ${viewExpr(id)}, r = b.getBoundingClientRect(), win = ${siteExpr(id)}; return { x: r.x, y: r.y, width: r.width, height: r.height, w: win.innerWidth, h: win.innerHeight, z: b.fullZoom };`,
  );
const cssRect = (id: string, sel: string) =>
  inSiteView<{ x: number; y: number; largeur: number; hauteur: number }>(m, id, `const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x, y: r.y, largeur: r.width, hauteur: r.height };`);

/** Toggles the mode on (the viewfinder in the page), then a trusted click at `p` (read before): the bubble. */
async function aimAt(id: string, p: { x: number; y: number }) {
  await toggle(id);
  await expect.poll(() => hosts(id), { timeout: 10_000 }).toBe(1);
  await siteMouse(m, id, p);
  await expect.poll(() => bubble(id), { timeout: 10_000 }).not.toBeNull();
  return (await bubble(id))!;
}

/** The files of the app's project on disk (its cart, its captures). */
const projectFiles = (id: string) =>
  (readdirSync(w.dataDir, { recursive: true }) as string[]).filter((f) => f.includes(`site-${id}`) && !f.includes(".git")).map((f) => path.join(w.dataDir, f)).filter((f) => statSync(f).isFile());
const pngs = (id: string) => projectFiles(id).filter((f) => f.endsWith(".png"));

/** The tweak's answer to « essai ». */
async function tweak(): Promise<any> {
  await view("vidola", `(document.documentElement.dataset.sonde = "", document.dispatchEvent(new Event("essai")), 1)`);
  return JSON.parse(String(await view("vidola", "document.documentElement.dataset.sonde")));
}

describe("design mode, site target, the view", () => {
  it("two sandboxes in one page: the viewfinder and a tweak never see each other", async () => {
    await toSite(m, "vidola", "/design");
    expect(await view("vidola", `getComputedStyle(document.querySelector(".cache")).display`)).toBe("none");
    await expect.poll(() => view("vidola", "document.documentElement.dataset.retouche ?? null"), { timeout: 10_000 }).toBe("oui");
    // The viewfinder's sandbox, probed through the shipped actor (the one the service arms).
    const probe = `(() => ({ webaiosSite: typeof webaiosSite, portee: typeof __webaiosPortee, fichier: typeof __webaiosFichier, retoucheSecret: typeof __retoucheSecret,
      Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services }))()`;
    const sees = await (await armActor(m, viewExpr("vidola"), probe)).result();
    expect(sees).toEqual({ r: { webaiosSite: "undefined", portee: "undefined", fichier: "undefined", retoucheSecret: "undefined", Components: "undefined", ChromeUtils: "undefined", Services: "undefined" } });
    await sleep(600);
    const p = await viewPoint(m, "vidola", "#cible");
    await toggle("vidola");
    await expect.poll(() => hosts("vidola"), { timeout: 10_000 }).toBe(1);
    const during = await tweak();
    expect(during.fakeIsMine).toBe(true);
    expect(during.shadow).toBe("null");
    await siteMouse(m, "vidola", p);
    await expect.poll(() => bubble("vidola"), { timeout: 10_000 }).toMatchObject({ etiquette: "div#cible" });
    const after = await tweak();
    expect(after.fakeIsMine).toBe(true);
    expect(after.log.fake).toBe(0);
    expect(after.log.hooked).toEqual([]);
    expect(after.log.early).toEqual([]);
  });

  it("the password guard holds while aiming", async () => {
    await toSite(m, "vidola", "/design");
    await expect.poll(() => view("vidola", "document.documentElement.dataset.retouche ?? null"), { timeout: 10_000 }).toBe("oui");
    await view("vidola", `(document.getElementById("mdp").value = "hunter2", 1)`);
    expect((await tweak()).pw).toBe("");
    const pPassword = await viewPoint(m, "vidola", "#mdp");
    await toggle("vidola");
    await expect.poll(() => hosts("vidola"), { timeout: 10_000 }).toBe(1);
    expect((await tweak()).pw).toBe("");
    // A key on the password field while aiming reaches the field, never the tweak; one on #email does.
    await view("vidola", `(document.getElementById("mdp").focus(), 1)`);
    await m.execute(`${siteExpr("vidola")}.focus(); ${viewExpr("vidola")}.focus();`);
    await view("vidola", `(document.getElementById("mdp").focus(), 1)`);
    await siteKey(m, "vidola", "x");
    await view("vidola", `(document.getElementById("email").focus(), 1)`);
    await siteKey(m, "vidola", "y");
    await expect.poll(() => view("vidola", `document.getElementById("mdp").value`), { timeout: 10_000 }).toBe("hunter2x");
    const keys: string[] = (await tweak()).log.keys;
    expect(keys.filter((k) => k.startsWith("mdp:"))).toEqual([]);
    expect(keys).toContain("email:y:true");
    // The bubble on #mdp: added to the cart, its value nowhere in what is kept.
    await siteMouse(m, "vidola", pPassword);
    await expect.poll(() => bubble("vidola"), { timeout: 10_000 }).toMatchObject({ etiquette: "input#mdp" });
    expect(JSON.stringify(await bubble("vidola"))).not.toContain("hunter2");
    expect(await add("vidola", "mot de passe")).toEqual({ ok: true });
    const files = projectFiles("vidola");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, "latin1")).not.toContain("hunter2");
    expect((await tweak()).pw).toBe("");
  });

  it("the page sees neither the viewfinder's clicks nor a new global", async () => {
    await toSite(m, "vidola", "/design");
    // Marionette's content scripts run in the page's world: every point is read first, then the page's log emptied.
    const p = await viewPoint(m, "vidola", "#nue");
    const keys0 = await view<string[]>("vidola", "Object.keys(window)");
    await clearLog(m, viewExpr("vidola"));
    await toggle("vidola");
    await expect.poll(() => hosts("vidola"), { timeout: 10_000 }).toBe(1);
    await siteMouse(m, "vidola", p, { button: 1 });
    await siteMouse(m, "vidola", p, { button: 2 });
    await siteMouse(m, "vidola", p);
    await expect.poll(() => bubble("vidola"), { timeout: 10_000 }).toMatchObject({ etiquette: "p#nue" });
    const log = await pageLog(m, viewExpr("vidola"));
    expect(log).toMatchObject({ reactions: [], early: [], docEarly: [], hooked: [], fakeStop: 0 });
    const keys1 = await view<string[]>("vidola", "Object.keys(window)");
    expect(keys1?.filter((k) => !keys0?.includes(k))).toEqual([]);
    const pageTypeof = await view<string>(
      "vidola",
      `(() => { const s = document.createElement("script"); s.textContent = "document.documentElement.dataset.vu = [typeof webaiosSite, typeof __webaiosPortee, typeof __retoucheSecret].join()"; document.documentElement.append(s); s.remove(); return document.documentElement.dataset.vu; })()`,
    );
    expect(pageTypeof).toBe("undefined,undefined,undefined");
  });

  it("the capture shows the page only", async () => {
    await toSite(m, "vidola", "/design");
    const rc = rectCapture(await cssRect("vidola", "#cible"), (await view<{ largeur: number; hauteur: number }>("vidola", "({ largeur: innerWidth, hauteur: innerHeight })"))!, 1);
    // A magenta chrome cover over #cible (clicks pass through it).
    await m.execute(
      `const win = ${siteExpr("vidola")}, b = ${viewExpr("vidola")}.getBoundingClientRect(), [rc] = arguments;
       const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
       c.id = "test-cover";
       c.style.cssText = "position:fixed;z-index:10;pointer-events:none;background:rgb(255,0,255);left:" + (b.left + rc.x) + "px;top:" + (b.top + rc.y) + "px;width:" + rc.width + "px;height:" + rc.height + "px";
       win.document.documentElement.append(c);`,
      [rc],
    );
    await sleep(300);
    try {
      const [pTarget, pForm] = [await viewPoint(m, "vidola", "#cible"), await viewPoint(m, "vidola", "#inscription")];
      const before = new Set(pngs("vidola"));
      await aimAt("vidola", pTarget);
      expect(await add("vidola", "cible")).toEqual({ ok: true });
      const file = pngs("vidola").find((f) => !before.has(f))!;
      const png = await readPng(m, file, [[Math.floor(rc.width / 2), Math.floor(rc.height / 2)]]);
      expect(png.at[0]).toEqual([0, 200, 0]);
      expect(png.colours).not.toContain("255,0,255");
      // The form starts at the view's top: its capture's first row is the page's white, not the bar.
      await expect.poll(() => hosts("vidola"), { timeout: 10_000 }).toBe(1);
      const before2 = new Set(pngs("vidola"));
      await siteMouse(m, "vidola", { x: pForm.x, y: (await geometry("vidola")).y + 3 });
      await expect.poll(() => bubble("vidola"), { timeout: 10_000 }).toMatchObject({ etiquette: "form#inscription" });
      expect(await add("vidola", "haut")).toEqual({ ok: true });
      const top = pngs("vidola").find((f) => !before2.has(f))!;
      const t = await readPng(m, top, [[1, 0], [50, 0], [100, 0]]);
      expect(t.at).toEqual([[255, 255, 255], [255, 255, 255], [255, 255, 255]]);
    } finally {
      await m.execute(`${siteExpr("vidola")}.document.getElementById("test-cover")?.remove();`);
    }
  });

  // design-sites.spec.ts:149 (the service's part)
  it("toggle on tuning, a trusted click on #lien: no navigation, reactions empty; the bubble names a#lien, has the site warning, sits at bubbleSlot with hautMin 36 and height 190; no source even on a data-source element", async () => {
    const start = await toSite(m, "tuning");
    const r = await cssRect("tuning", "#lien");
    const p = await viewPoint(m, "tuning", "#lien");
    const b = await aimAt("tuning", p);
    expect(b).toMatchObject({ etiquette: "a#lien", avertissement: CAPTURE_WARNING_SITE, source: null, projet: "site-tuning" });
    await sleep(300);
    expect(await view("tuning", "location.href")).toBe(start);
    expect(await view("tuning", "window.reactions")).toEqual([]);
    const g = await geometry("tuning");
    expect(g.y).toBe(36);
    const expected = bubbleSlot(r, 1, g, [g.w, g.h], { hautMin: 36, hauteur: 190 });
    await expect.poll(() => overlayRect("tuning"), { timeout: 10_000 }).toEqual(expected);
    await expect
      .poll(() => overlayOf(m, "tuning", `return doc.querySelector('[data-testid="avertissement-bulle"]')?.textContent ?? null;`), { timeout: 10_000 })
      .toBe(CAPTURE_WARNING_SITE);
    // A page's data-source is never read in a site app.
    await toSite(m, "vidola", "/design");
    const ps = await viewPoint(m, "vidola", "p[data-source]");
    expect(await aimAt("vidola", ps)).toMatchObject({ etiquette: "p", source: null });
  });

  it("openCart of a site: the cart at y 48, 340 wide, 12 px from the right and the bottom", async () => {
    await toSite(m, "tuning");
    await inStore(m, "await store.design.openCart(arguments[0]); return 1;", [T("tuning")]);
    await expect.poll(() => overlayOf(m, "tuning", `return !!doc.querySelector('[data-testid="panier-design"]');`), { timeout: 10_000 }).toBe(true);
    const g = await geometry("tuning");
    expect(await overlayRect("tuning")).toEqual({ x: g.w - 12 - 340, y: 48, width: 340, height: g.h - 48 - 12 });
  });

  // design-sites.spec.ts:187
  it("history.pushState during the mode: it stays; location.href to /autre: it stops, the cart stays", async () => {
    await toSite(m, "tuning");
    const n = await cart("tuning");
    await aimAt("tuning", await viewPoint(m, "tuning", "#banniere"));
    expect((await bubble("tuning"))?.etiquette).toBe("div#banniere.cookies");
    expect(await add("tuning", "Cacher la bannière")).toEqual({ ok: true });
    expect(await cart("tuning")).toBe(n + 1);
    await expect.poll(() => hosts("tuning"), { timeout: 10_000 }).toBe(1);
    await view("tuning", "(history.pushState({}, '', '/meme-document'), 1)");
    await sleep(500);
    expect((await state("tuning")).actif).toBe(true);
    await expect.poll(() => hosts("tuning"), { timeout: 10_000 }).toBe(1);
    await view("tuning", "(location.href = '/autre', 1)");
    await expect.poll(() => view("tuning", "document.title"), { timeout: 10_000 }).toBe("Autre");
    await expect.poll(async () => (await state("tuning")).actif, { timeout: 10_000 }).toBe(false);
    expect(await hosts("tuning")).toBe(0);
    expect(await cart("tuning")).toBe(n + 1);
  });

  // design-sites.spec.ts:473
  it("/csp page (strict CSP and Trusted Types): the viewfinder arms, a click on #b gives button#b", async () => {
    await toSite(m, "tuning", "/csp");
    expect(await aimAt("tuning", await viewPoint(m, "tuning", "#b"))).toMatchObject({ etiquette: "button#b" });
  });

  it("the site's stops: ⌂ (an app with a home), element fullscreen, the window closing: the mode stops, nothing left in the page, the cart stays", async () => {
    // ⌂ on avec-accueil.
    await openSite(m, "avec-accueil");
    await toSite(m, "avec-accueil");
    const n = await cart("avec-accueil");
    await aimAt("avec-accueil", await viewPoint(m, "avec-accueil", "#lien"));
    expect(await add("avec-accueil", "lien")).toEqual({ ok: true });
    await expect.poll(() => hosts("avec-accueil"), { timeout: 10_000 }).toBe(1);
    await inStore(m, "store.sites.controller(arguments[0]).home(); return 1;", ["avec-accueil"]);
    await expect.poll(async () => (await state("avec-accueil")).actif, { timeout: 10_000 }).toBe(false);
    await expect.poll(() => hosts("avec-accueil"), { timeout: 10_000 }).toBe(0);
    expect(await cart("avec-accueil")).toBe(n + 1);

    // An element's fullscreen on tuning: the mode stops; toggled there, it is unavailable.
    await toSite(m, "tuning");
    await toggle("tuning");
    await expect.poll(() => hosts("tuning"), { timeout: 10_000 }).toBe(1);
    await view("tuning", "(void document.getElementById('films').requestFullscreen(), 1)");
    await waitFor(m, `return ${siteExpr("tuning")}.document.documentElement.hasAttribute("inDOMFullscreen");`, (v) => v === true);
    await expect.poll(async () => (await state("tuning")).actif, { timeout: 10_000 }).toBe(false);
    await expect.poll(() => hosts("tuning"), { timeout: 10_000 }).toBe(0);
    expect((await state("tuning")).indisponible).toBe(UNAVAILABLE_DESIGN_SITE);
    await toggle("tuning");
    await sleep(300);
    expect(await hosts("tuning")).toBe(0);
    expect(await notice("tuning")).toEqual({ genre: "info", texte: UNAVAILABLE_DESIGN_SITE });
    await view("tuning", "(void document.exitFullscreen(), 1)");
    await waitFor(m, `return ${siteExpr("tuning")}.document.documentElement.hasAttribute("inDOMFullscreen");`, (v) => v === false);
    await expect.poll(async () => (await state("tuning")).indisponible, { timeout: 10_000 }).toBeNull();

    // The window closing during the bubble: the mode and its overlay context are forgotten, the cart stays.
    const k = await cart("tuning");
    const link = await viewPoint(m, "tuning", "#lien");
    await aimAt("tuning", link);
    expect(await add("tuning", "lien")).toEqual({ ok: true });
    await expect.poll(() => hosts("tuning"), { timeout: 10_000 }).toBe(1);
    await siteMouse(m, "tuning", link);
    await expect.poll(() => overlayRect("tuning"), { timeout: 10_000 }).not.toBeNull();
    await inStore(m, "await store.sites.close(arguments[0]); return 1;", ["tuning"]);
    await expect.poll(async () => (await state("tuning")).actif, { timeout: 10_000 }).toBe(false);
    expect(await state("tuning")).toMatchObject({ projet: null, indisponible: UNAVAILABLE_DESIGN_SITE });
    expect(await inStore(m, "return store.design.overlayContext(arguments[0]);", [T("tuning")])).toBeNull();
    expect(await cart("tuning")).toBe(k + 1);
  });

  it("toggle where unavailable (the login page): nothing injected, the bar's avis is the info SITE_DESIGN_UNAVAILABLE, gone after 5 s; a blocked link's avis is never replaced", async () => {
    await toSite(m, "tuning");
    await view("tuning", `(location.href = ${JSON.stringify(url("compte-tuning.localhost", "/connexion"))}, 1)`);
    await expect.poll(() => view("tuning", "document.title"), { timeout: 10_000 }).toBe("Connexion");
    await expect.poll(async () => (await state("tuning")).indisponible, { timeout: 10_000 }).toBe(UNAVAILABLE_DESIGN_SITE);
    const t0 = Date.now();
    await toggle("tuning");
    expect(await notice("tuning")).toEqual({ genre: "info", texte: UNAVAILABLE_DESIGN_SITE });
    await sleep(300);
    expect(await hosts("tuning")).toBe(0);
    expect((await state("tuning")).actif).toBe(false);
    await expect.poll(() => notice("tuning"), { timeout: 10_000 }).toBeNull();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4500);
    // A blocked link's mention carries « Ouvrir dans un onglet »: the info never replaces it.
    await inStore(m, "store.sites.controller(arguments[0]).blocked(arguments[1]); return 1;", ["tuning", "http://ailleurs.localhost/"]);
    expect((await notice("tuning"))?.genre).toBe("lien-bloque");
    await toggle("tuning");
    await sleep(300);
    expect((await notice("tuning"))?.genre).toBe("lien-bloque");
    expect(await hosts("tuning")).toBe(0);
  });

  // Review Focus 2
  it("zoomed view: the bubble sits under the element and under the bar, the PNG is rectCapture's size", async () => {
    await toSite(m, "vidola", "/design");
    await m.execute(`${viewExpr("vidola")}.fullZoom = 1.5;`);
    await sleep(300);
    try {
      const r = await cssRect("vidola", "#cible");
      const viewOf = (await view<{ largeur: number; hauteur: number }>("vidola", "({ largeur: innerWidth, hauteur: innerHeight })"))!;
      const p = await viewPoint(m, "vidola", "#cible");
      const g = await geometry("vidola");
      expect(g.z).toBe(1.5);
      const before = new Set(pngs("vidola"));
      await aimAt("vidola", p);
      const expected = bubbleSlot(r, 1.5, g, [g.w, g.h], { hautMin: 36, hauteur: 190 });
      await expect.poll(() => overlayRect("vidola"), { timeout: 10_000 }).toEqual(expected);
      expect(expected.y).toBeGreaterThan(g.y + (r.y + r.hauteur) * 1.5);
      expect(await add("vidola", "zoom")).toEqual({ ok: true });
      const file = pngs("vidola").find((f) => !before.has(f))!;
      const dpr = await m.execute<number>(`return ${siteExpr("vidola")}.devicePixelRatio;`);
      const dip = rectCapture(r, viewOf, 1.5);
      const png = await readPng(m, file, [[Math.floor((dip.width * dpr) / 2), Math.floor((dip.height * dpr) / 2)]]);
      expect({ width: png.width, height: png.height }).toEqual({ width: Math.round(dip.width * dpr), height: Math.round(dip.height * dpr) });
      expect(png.at[0]).toEqual([0, 200, 0]);
    } finally {
      await m.execute(`${viewExpr("vidola")}.fullZoom = 1;`);
    }
  });

  // Review Focus 3
  it("an OOP frame in the site page: guarded while aiming, free after stop", async () => {
    await toSite(m, "tuning", "/oop");
    const V = viewExpr("tuning");
    await waitFor(m, `const c = ${V}.browsingContext.children[0]?.currentWindowGlobal; return !!c && c.documentURI.spec.startsWith("http://127.0.0.1:${FRAME_PORT}/") && !${V}.webProgress.isLoadingDocument;`, (v) => v === true);
    expect(await m.execute(`return ${V}.browsingContext.children[0].currentWindowGlobal.isProcessRoot;`)).toBe(true);
    await toggle("tuning");
    await expect.poll(() => hosts("tuning"), { timeout: 10_000 }).toBe(1);
    await sleep(300);
    await clearLog(m, V, 0);
    await trustedMouse(m, V, "#dans", { frame: 0 });
    await trustedMouse(m, V, "#dans", { frame: 0, button: 1 });
    await sleep(300);
    expect((await pageLog(m, V, 0)).early).toEqual([]);
    // Still aiming: the frame's click picked nothing.
    expect(await hosts("tuning")).toBe(1);
    await inStore(m, "await store.design.stop(arguments[0]); return 1;", [T("tuning")]);
    await trustedMouse(m, V, "#dans", { frame: 0 });
    await expect.poll(async () => (await pageLog(m, V, 0)).early, { timeout: 10_000 }).toContain("click:true");
  });
});
