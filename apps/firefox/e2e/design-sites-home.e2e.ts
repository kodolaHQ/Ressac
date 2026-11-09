import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { rectCapture } from "../chrome/store/design-copies";
import { testActor } from "./agent-extensions";
import {
  WITH_HOME,
  withHomeDeclaration,
  overlayOf,
  homePoint,
  inStore,
  readPng,
  siteExpr,
  siteKey,
  siteMouse,
  STORE,
  toHome,
  toSite,
  TUNING_PAGE,
  tuningDeclaration,
  viewExpr,
  viewPoint,
} from "./design-sites";
import { waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { grantSite, inSiteBar, inSiteView, resolveLocalHosts, startSitesServer, writeSite } from "./sites";

// Plan 36 Task 3: the design mode on a site app's home (spike S6), done by the chrome on the home's frame
// (chrome/store/design-home.ts). Apps avec-accueil and sonde (spike S6's home, for the
// measures), tuning for the view at density 2. Block 15355-15359: sites on 15355.

const PORT = 15355;
const IDS = ["avec-accueil", "sonde", "tuning"];
const MOUSE = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu", "dblclick"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = (id: string) => ({ type: "site", id });
const tid = (t: string) => `[data-testid="${t}"]`;
const CADRE = tid("site-cadre-accueil");

/** Spike S6's home (the agent's code): listens first on its window, keeps a global, a green target with a data-source; `fabricate` makes untrusted events. */
const HOME = `<!doctype html><meta charset="utf-8"><title>Accueil</title>
<script>
  window.log = { early: [], reactions: [], keys: [] };
  for (const t of ${JSON.stringify(MOUSE)}) {
    addEventListener(t, (e) => log.early.push(t + ":" + e.isTrusted), true);
    document.addEventListener(t, (e) => log.reactions.push(t + ":" + (e.target.id || e.target.localName)));
  }
  addEventListener("keydown", (e) => log.keys.push(e.key + ":" + e.isTrusted), true);
  window.homeSecret = "h";
  window.fabricate = () => {
    document.getElementById("cible").click();
    document.getElementById("cible").dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  };
</script>
<style>body{margin:0;background:#fff;height:900px} #cible{position:absolute;left:40px;top:60px;width:120px;height:40px;background:rgb(0,200,0)}</style>
<div id="cible" data-source="src/Accueil.svelte:7">cible</div>
<p id="nue" style="position:absolute;left:40px;top:160px">nue</p>`;

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const dirs: string[] = [];
const url = (host: string, path = "/") => server.url(host, path);
const declarationProbe = () => ({ ...withHomeDeclaration(url), nom: "Sonde" });

async function launch(prefs: Record<string, string | number | boolean> = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  writeSite(dataDir, "avec-accueil", { declaration: withHomeDeclaration(url), fichiers: { "accueil/index.html": WITH_HOME } });
  writeSite(dataDir, "sonde", { declaration: declarationProbe(), fichiers: { "accueil/index.html": HOME } });
  writeSite(dataDir, "tuning", { declaration: tuningDeclaration(url), fichiers: { "retouches/tuning.css": "/* rien */" } });
  await grantSite(dataDir, "tuning", tuningDeclaration(url));
  const a = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1", ...a.env }, prefs: { ...a.prefs, ...prefs } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, ["tuning-a.localhost", "compte-tuning.localhost"]);
}
async function close() {
  await w?.close();
}

beforeAll(async () => {
  server = await startSitesServer({ port: PORT });
  server.definir("tuning-a.localhost", "/", TUNING_PAGE);
});
afterAll(async () => {
  await server?.fermer();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
afterEach(async () => {
  await inStore(m, `for (const id of arguments[0]) { await store.design.stop({ type: "site", id }); store.design.closeOverlay({ type: "site", id }, "panier"); } return 1;`, [IDS]);
});

const state = (id: string) => inStore<{ actif: boolean; panier: number }>(m, "return await store.design.etat(arguments[0]);", [T(id)]);
const toggle = (id: string) => inStore(m, "await store.design.toggle(arguments[0]); return 1;", [T(id)]);
const add = (id: string, text: string) => inStore<{ ok: boolean }>(m, "return await store.design.add(arguments[0], arguments[1]);", [T(id), text]);
const bubble = (id: string) => inStore<{ etiquette: string; source: string | null; avertissement: string | null } | null>(m, 'return store.design.overlayContext(arguments[0], ["bulle"]);', [T(id)]);
const view = (id: string) => inStore<string | null>(m, "return store.sites.viewOf(arguments[0]);", [id]);
/** `body` with `f` the home's frame, `hdoc` its document and `hwin` its window (chrome access). */
const inHome = <T = unknown>(id: string, body: string, args: unknown[] = []) =>
  inSiteBar<T>(m, id, `const f = doc.querySelector('${CADRE}'), hdoc = f?.contentDocument, hwin = hdoc?.defaultView; ${body}`, args);
const homeHosts = (id: string) => inHome<number>(id, `return hdoc ? hdoc.getElementsByTagName("webaios-viseur").length : -1;`).catch(() => -1);
const viewHosts = (id: string) => inSiteView<number>(m, id, `return document.getElementsByTagName("webaios-viseur").length;`).catch(() => 0);
const homeLog = (id: string) => inHome<{ early: string[]; reactions: string[]; keys: string[] }>(id, "return JSON.parse(JSON.stringify(hwin.wrappedJSObject.log));");
const homeKeys = (id: string) => inHome<string[]>(id, "return Object.keys(hwin.wrappedJSObject);");
/** Code run in the home's own world (its principal, Xrays waived): what the agent's home could do itself. */
const asHome = (id: string, code: string) =>
  inHome(id, `const sb = Components.utils.Sandbox(hdoc.nodePrincipal, { sandboxPrototype: hwin, wantXrays: false, wantComponents: false, sameZoneAs: hwin });
    Components.utils.evalInSandbox(arguments[0], sb, "latest", "chrome://browser/content/webaios/e2e-home.js", 1); return 1;`, [code]);
const bar = (id: string) =>
  inSiteBar<{ pressed: string | null; count: string | null }>(
    m,
    id,
    `return { pressed: doc.querySelector('${tid("site-bouton-design")}')?.getAttribute("aria-pressed") ?? null, count: doc.querySelector('${tid("site-compteur-panier")}')?.textContent ?? null };`,
  );
const barPoint = (id: string, t: string) =>
  inSiteBar<{ x: number; y: number }>(
    m,
    id,
    `const b = win.document.getElementById("webaios-site-bar").getBoundingClientRect(), r = doc.querySelector('${tid(t)}').getBoundingClientRect();
     return { x: b.left + r.left + r.width / 2, y: b.top + r.top + r.height / 2 };`,
  );
const overlayTop = (id: string) => overlayOf<number>(m, id, "return f.getBoundingClientRect().y;");
const bubbleText = (id: string) => overlayOf<string | null>(m, id, `return doc.querySelector('${tid("bulle-design")}')?.textContent ?? null;`);
/** The home element's rectangle, in its frame's CSS pixels (as the viewfinder's capture). */
const homeRect = (id: string, sel: string) =>
  inHome<{ x: number; y: number; largeur: number; hauteur: number; vue: { largeur: number; hauteur: number } }>(
    id,
    `const r = hdoc.querySelector(arguments[0]).getBoundingClientRect(); return { x: r.x, y: r.y, largeur: r.width, hauteur: r.height, vue: { largeur: hwin.innerWidth, hauteur: hwin.innerHeight } };`,
    [sel],
  );
const projectFiles = (id: string) =>
  (readdirSync(w.dataDir, { recursive: true }) as string[]).filter((f) => f.includes(`site-${id}`) && !f.includes(".git")).map((f) => path.join(w.dataDir, f)).filter((f) => statSync(f).isFile());
const pngs = (id: string) => projectFiles(id).filter((f) => f.endsWith(".png"));
const agentInput = () => {
  const f = path.join(w.dataDir, "espace", "faux-agent-entree.txt");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};

/** The mode on, on the home of `id` (through the service): one viewfinder in the home's document, none in the view. */
async function homeOn(id: string) {
  await toHome(m, id);
  await toggle(id);
  await expect.poll(() => homeHosts(id), { timeout: 10_000 }).toBe(1);
  expect(await viewHosts(id)).toBe(0);
}
/** A trusted click on `sel` in the home: the bubble. */
async function aimHome(id: string, sel: string) {
  await siteMouse(m, id, await homePoint(m, id, sel));
  await expect.poll(() => bubble(id), { timeout: 10_000 }).not.toBeNull();
  return (await bubble(id))!;
}

describe("design mode on a site app's home", () => {
  beforeAll(() => launch(), 120_000);
  afterAll(close);

  // design-sites.spec.ts:253
  it("home: ⇧⌘D aims in its frame, bubble without warning, « Entrer dans le site » stops the mode; the send marks the remark [accueil]", async () => {
    await toHome(m, "avec-accueil");
    await siteKey(m, "avec-accueil", "d", ["Meta", "Shift"]);
    await expect.poll(async () => (await bar("avec-accueil")).pressed, { timeout: 10_000 }).toBe("true");
    await expect.poll(() => homeHosts("avec-accueil"), { timeout: 10_000 }).toBe(1);
    // Nothing injected into the site's view, hidden below.
    expect(await viewHosts("avec-accueil")).toBe(0);
    await siteMouse(m, "avec-accueil", await homePoint(m, "avec-accueil", "#titre"));
    await expect.poll(() => bubbleText("avec-accueil"), { timeout: 10_000 }).toContain("h1#titre");
    expect(await overlayOf(m, "avec-accueil", `return doc.querySelectorAll('${tid("avertissement-bulle")}').length;`)).toBe(0);
    expect(await overlayTop("avec-accueil")).toBeGreaterThanOrEqual(36);
    await expect.poll(() => overlayOf(m, "avec-accueil", "return doc.activeElement?.localName ?? null;"), { timeout: 10_000 }).toBe("textarea");
    await overlayOf(m, "avec-accueil", `const t = doc.querySelector("textarea"); t.value = "Titre plus gros"; t.dispatchEvent(new f.contentWindow.Event("input", { bubbles: true })); return 1;`);
    await siteKey(m, "avec-accueil", "Enter", ["Meta"]);
    await expect.poll(async () => (await bar("avec-accueil")).count, { timeout: 10_000 }).toBe("1");
    await expect.poll(() => homeHosts("avec-accueil"), { timeout: 10_000 }).toBe(1);
    // « Entrer dans le site »: the view changes, the mode stops.
    await siteMouse(m, "avec-accueil", await barPoint("avec-accueil", "site-entrer"));
    await expect.poll(async () => (await bar("avec-accueil")).pressed, { timeout: 10_000 }).toBe("false");
    await expect.poll(() => m.execute(`return ${viewExpr("avec-accueil")}.currentURI.spec;`), { timeout: 10_000 }).toBe(url("tuning-a.localhost", "/"));
    // The send: the pre-filled text points at accueil/ and tags the remark.
    await inSiteBar(m, "avec-accueil", `doc.querySelector('${tid("site-menu-design")}').click(); return 1;`);
    await expect.poll(() => inSiteBar(m, "avec-accueil", `return !!doc.querySelector('${tid("site-menu-design-panier")}');`), { timeout: 10_000 }).toBe(true);
    await inSiteBar(m, "avec-accueil", `doc.querySelector('${tid("site-menu-design-panier")}').click(); return 1;`);
    await expect.poll(() => overlayOf(m, "avec-accueil", `return !!doc.querySelector('${tid("envoyer-remarques")}');`), { timeout: 10_000 }).toBe(true);
    await overlayOf(m, "avec-accueil", `doc.querySelector('${tid("envoyer-remarques")}').click(); return 1;`);
    await expect.poll(agentInput, { timeout: 20_000 }).toContain("les remarques [accueil] visent son écran d'accueil, à changer dans accueil/");
    expect(agentInput()).toContain('1) [accueil] "h1#titre" : « Titre plus gros »');
    const dir = path.join(w.dataDir, "espace", ".webaios", "remarques", "site-avec-accueil");
    const [lot] = readdirSync(dir).filter((n) => /^\d{8}T\d{6}Z-[0-9a-f]{4}$/.test(n));
    const content = JSON.parse(readFileSync(path.join(dir, lot!, "lot.json"), "utf8"));
    expect(content.elements[0].contexte.adresse).toBe("webaios-site://avec-accueil/index.html");
    expect(readdirSync(path.join(dir, lot!)).filter((n) => n.endsWith(".png"))).toHaveLength(1);
  });

  it("the home viewfinder's sandbox reaches nothing of the chrome nor the home's globals", async () => {
    await toHome(m, "sonde");
    // The service's own sandbox (homeViewfinder's arm), with S6's reach list as its code.
    const reach = await inHome<Record<string, string>>(
      "sonde",
      `const { homeViewfinder } = ChromeUtils.importESModule("${STORE}");
       return await homeViewfinder(f).query("arm", { code: arguments[0] });`,
      [
        `(() => {
         const t = (f) => { try { const v = f(); return v === null || v === undefined ? String(v) : typeof v === "object" || typeof v === "function" ? typeof v + ":" + Object.prototype.toString.call(v) : String(v); } catch (e) { return "throws:" + String(e).slice(0, 90); } };
         return { Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services, Cu: typeof Cu, docShell: typeof docShell, gBrowser: typeof gBrowser,
           webaiosSiteWindow: typeof webaiosSiteWindow, windowRoot: typeof windowRoot, homeSecret: typeof homeSecret, origin: location.origin,
           frameElement: t(() => frameElement), parentDocument: t(() => parent.document), topDocument: t(() => top.document), parentHref: t(() => parent.location.href), topHref: t(() => top.location.href),
           parentSiteWindow: t(() => parent.webaiosSiteWindow), topGBrowser: t(() => top.gBrowser), topSiteWindow: t(() => top.webaiosSiteWindow), parentFrames: t(() => parent.frames.length),
           opener: t(() => opener), ownerGlobal: t(() => document.ownerGlobal), defaultViewParent: t(() => document.defaultView.parent.document) };
       })()`,
      ],
    );
    expect(reach).toMatchObject({ Components: "undefined", ChromeUtils: "undefined", Services: "undefined", Cu: "undefined", docShell: "undefined", gBrowser: "undefined", webaiosSiteWindow: "undefined", windowRoot: "undefined", homeSecret: "undefined" });
    for (const k of ["parentDocument", "topDocument", "parentHref", "topHref", "parentSiteWindow", "topGBrowser", "topSiteWindow", "defaultViewParent"]) expect(String(reach[k])).toMatch(/^throws:|^undefined$/);
    expect(reach.frameElement).toBe("null");
    expect(reach.opener).toBe("null");
    // The home's own principal: the served copy's origin.
    expect(reach.origin).toMatch(/^resource:\/\/webaios-site-sonde-/);
  });

  it("the home viewfinder arms only on the served home: a system about:blank frame or a sandboxed about:blank gives null, nothing set", async () => {
    await toHome(m, "sonde");
    // Two frames of the bar's document, each its own chrome event handler: a system-principal about:blank, and a
    // sandboxed (null principal) about:blank, as the home frame's own initial document.
    const r = await inHome<{ answers: unknown[]; marks: (string | null)[] }>(
      "sonde",
      `const { homeViewfinder } = ChromeUtils.importESModule("${STORE}");
       const frames = [false, true].map((sandboxed) => { const x = doc.createElement("iframe"); if (sandboxed) x.setAttribute("sandbox", "allow-scripts"); doc.body.append(x); return x; });
       try {
         await new Promise((ok) => win.setTimeout(ok, 200));
         const answers = [];
         for (const x of frames) answers.push(await homeViewfinder(x).query("arm", { code: arguments[0] }));
         return { answers, marks: frames.map((x) => x.contentDocument?.documentElement?.getAttribute("data-armed") ?? null), system: frames.map((x) => x.contentDocument.nodePrincipal.isSystemPrincipal) };
       } finally { for (const x of frames) x.remove(); }`,
      [`(document.documentElement.setAttribute("data-armed", "1"), { ok: 1 })`],
    );
    expect(r.answers).toEqual([null, null]);
    expect(r.marks).toEqual([null, null]);
    expect((r as any).system).toEqual([true, false]);
  });

  // Review Focus 4.
  it("the home viewfinder's sandbox cannot navigate the bar or the window", async () => {
    await toHome(m, "sonde");
    const before = await inHome<{ bar: string; win: string; home: string }>("sonde", "return { bar: doc.documentURI, win: win.document.documentURI, home: hdoc.documentURI };");
    const sorted = await inHome<Record<string, string>>(
      "sonde",
      `const { homeViewfinder } = ChromeUtils.importESModule("${STORE}");
       return await homeViewfinder(f).query("arm", { code: arguments[0] });`,
      [
        `(() => {
         const t = (f) => { try { f(); return "ran"; } catch (e) { return "throws:" + String(e).slice(0, 90); } };
         return { parentLocation: t(() => { parent.location = "about:blank"; }), topHref: t(() => { top.location.href = "about:blank"; }), parentHref: t(() => { parent.location.href = "about:blank"; }),
           topReplace: t(() => top.location.replace("about:blank")), postMessage: t(() => parent.postMessage({ type: "ouvrir", url: "about:blank" }, "*")) };
       })()`,
      ],
    );
    await sleep(1000);
    for (const k of ["parentLocation", "topHref", "parentHref", "topReplace"]) expect(sorted[k]).toMatch(/^throws:/);
    expect(await inHome("sonde", "return { bar: doc.documentURI, win: win.document.documentURI, home: hdoc.documentURI };")).toEqual(before);
    expect(await view("sonde")).toBe("accueil");
  });

  it("hover frames p#nue; middle and right clicks pick nothing; the primary click captures #cible; the home saw nothing, no global added", async () => {
    await toHome(m, "sonde");
    await inHome("sonde", "hwin.wrappedJSObject.log.early.length = 0; hwin.wrappedJSObject.log.reactions.length = 0; return 1;");
    const keys0 = await homeKeys("sonde");
    await toggle("sonde");
    await expect.poll(() => homeHosts("sonde"), { timeout: 10_000 }).toBe(1);
    await siteMouse(m, "sonde", await homePoint(m, "sonde", "#nue"), { move: true });
    await expect
      .poll(() => inHome<string | null>("sonde", `const sh = hdoc.querySelector("webaios-viseur")?.openOrClosedShadowRoot; return sh?.children[1]?.textContent ?? null;`), { timeout: 10_000 })
      .toBe("p#nue");
    expect(await inHome("sonde", `return String(hdoc.querySelector("webaios-viseur").wrappedJSObject.shadowRoot);`)).toBe("null");
    await siteMouse(m, "sonde", await homePoint(m, "sonde", "#nue"), { button: 1 });
    await siteMouse(m, "sonde", await homePoint(m, "sonde", "#nue"), { button: 2 });
    await sleep(500);
    expect(await bubble("sonde")).toBeNull();
    const b = await aimHome("sonde", "#cible");
    expect(b.etiquette).toBe("div#cible");
    expect(b.avertissement).toBeNull();
    expect(await homeLog("sonde")).toMatchObject({ early: [], reactions: [] });
    expect((await homeKeys("sonde")).filter((k) => !keys0.includes(k))).toEqual([]);
  });

  it("the source of a home element is read (src/Accueil.svelte:7), none gives null", async () => {
    await homeOn("sonde");
    expect((await aimHome("sonde", "#cible")).source).toBe("src/Accueil.svelte:7");
    await inStore(m, "store.design.cancel(arguments[0]); return 1;", [T("sonde")]);
    await expect.poll(() => homeHosts("sonde"), { timeout: 10_000 }).toBe(1);
    await sleep(600);
    const b = await aimHome("sonde", "#nue");
    expect(b.etiquette).toBe("p#nue");
    expect(b.source).toBeNull();
  });

  it("the home's PNG is the frame's only", async () => {
    await homeOn("sonde");
    const r = await homeRect("sonde", "#cible");
    const rc = rectCapture({ x: r.x, y: r.y, largeur: r.largeur, hauteur: r.hauteur }, r.vue, 1);
    // A magenta cover in the bar's document over #cible: the window shows it, the capture must not.
    await inHome("sonde", `const h = f.getBoundingClientRect(), rc = arguments[0], cover = doc.createElement("div"); cover.id = "e2e-cover";
      cover.style.cssText = "position:fixed;z-index:10;pointer-events:none;background:rgb(255,0,255);left:" + (h.left + rc.x) + "px;top:" + (h.top + rc.y) + "px;width:" + rc.width + "px;height:" + rc.height + "px";
      doc.body.append(cover); return 1;`, [rc]);
    try {
      const before = pngs("sonde");
      await aimHome("sonde", "#cible");
      expect((await add("sonde", "Cible plus grande")).ok).toBe(true);
      await expect.poll(() => pngs("sonde").length, { timeout: 10_000 }).toBe(before.length + 1);
      const file = pngs("sonde").find((f) => !before.includes(f))!;
      const png = await readPng(m, file, [[Math.round(rc.width / 2), Math.round(rc.height / 2)], [1, 1]]);
      expect([png.width, png.height]).toEqual([Math.round(rc.width), Math.round(rc.height)]);
      expect(png.at[0]).toEqual([0, 200, 0]);
      expect(png.at[1]).toEqual([255, 255, 255]);
      expect(png.colours).not.toContain("255,0,255");
    } finally {
      await inHome("sonde", `doc.getElementById("e2e-cover")?.remove(); return 1;`);
    }
  });

  // Review Focus 1.
  it("Escape in the home stops the mode; a click and an Escape made by the home do nothing", async () => {
    await homeOn("sonde");
    await inHome("sonde", "hwin.wrappedJSObject.log.keys.length = 0; return 1;");
    await asHome("sonde", "fabricate()");
    await sleep(500);
    expect(await bubble("sonde")).toBeNull();
    expect((await state("sonde")).actif).toBe(true);
    expect(await homeHosts("sonde")).toBe(1);
    // The home's own events reached it (untrusted): the guard let them through, untouched.
    expect((await homeLog("sonde")).keys).toEqual(["Escape:false"]);
    // A real Escape, the keyboard in the home's frame.
    await expect.poll(() => inHome("sonde", "return Services.focus.focusedWindow === hwin;"), { timeout: 10_000 }).toBe(true);
    await siteKey(m, "sonde", "Escape");
    await expect.poll(async () => (await bar("sonde")).pressed, { timeout: 10_000 }).toBe("false");
    await expect.poll(() => homeHosts("sonde"), { timeout: 10_000 }).toBe(0);
    expect((await homeLog("sonde")).keys).toEqual(["Escape:false"]);
  });

  // Review Focus 5.
  it("the home re-served while aiming: the mode stops", async () => {
    await homeOn("sonde");
    const errors0 = await m.execute<number>(`return Services.console.getMessageArray().filter((x) => /dead object/.test(String(x.message ?? x))).length;`);
    writeFileSync(path.join(w.dataDir, "espace", "sites", "sonde", "accueil", "index.html"), HOME.replace("<title>Accueil</title>", "<title>Accueil 2</title>"));
    await expect.poll(async () => (await bar("sonde")).pressed, { timeout: 10_000 }).toBe("false");
    expect((await state("sonde")).actif).toBe(false);
    await expect.poll(() => inHome("sonde", "return hdoc?.readyState === 'complete' ? hdoc.title : null;"), { timeout: 15_000 }).toBe("Accueil 2");
    expect(await m.execute<number>(`return Services.console.getMessageArray().filter((x) => /dead object/.test(String(x.message ?? x))).length;`)).toBe(errors0);
    // A new arm works on the new document.
    await toggle("sonde");
    await expect.poll(() => homeHosts("sonde"), { timeout: 10_000 }).toBe(1);
    expect((await aimHome("sonde", "#cible")).etiquette).toBe("div#cible");
  });

  it("⌂ while aiming in the site view, then ⇧⌘D on the home: the home is aimed, the view is not", async () => {
    await toSite(m, "avec-accueil");
    await toggle("avec-accueil");
    await expect.poll(() => viewHosts("avec-accueil"), { timeout: 10_000 }).toBe(1);
    await inSiteBar(m, "avec-accueil", `doc.querySelector('${tid("site-accueil")}').click(); return 1;`);
    await expect.poll(async () => (await bar("avec-accueil")).pressed, { timeout: 10_000 }).toBe("false");
    await expect.poll(() => viewHosts("avec-accueil"), { timeout: 10_000 }).toBe(0);
    await toHome(m, "avec-accueil");
    await siteKey(m, "avec-accueil", "d", ["Meta", "Shift"]);
    await expect.poll(() => homeHosts("avec-accueil"), { timeout: 10_000 }).toBe(1);
    await sleep(300);
    expect(await viewHosts("avec-accueil")).toBe(0);
    expect((await aimHome("avec-accueil", "#titre")).etiquette).toBe("h1#titre");
  });
});

// Review Focus 2.
describe("design mode in a site app at density 2", () => {
  beforeAll(() => launch({ "layout.css.devPixelsPerPx": "2.0" }), 120_000);
  afterAll(close);

  it("at density 2: the view's and the home's PNG are twice rectCapture", async () => {
    expect(await m.execute(`return ${siteExpr("tuning")}?.devicePixelRatio ?? window.devicePixelRatio;`)).toBe(2);
    // The view (tuning).
    await toSite(m, "tuning");
    const r = await inSiteView<{ x: number; y: number; largeur: number; hauteur: number; vue: { largeur: number; hauteur: number } }>(
      m,
      "tuning",
      `const r = document.querySelector("#banniere").getBoundingClientRect(); return { x: r.x, y: r.y, largeur: r.width, hauteur: r.height, vue: { largeur: innerWidth, hauteur: innerHeight } };`,
    );
    const zoom = await m.execute<number>(`return ${viewExpr("tuning")}.fullZoom;`);
    const rv = rectCapture({ x: r.x, y: r.y, largeur: r.largeur, hauteur: r.hauteur }, r.vue, zoom);
    let before = pngs("tuning");
    await toggle("tuning");
    await expect.poll(() => viewHosts("tuning"), { timeout: 10_000 }).toBe(1);
    await siteMouse(m, "tuning", await viewPoint(m, "tuning", "#banniere"));
    await expect.poll(() => bubble("tuning"), { timeout: 10_000 }).not.toBeNull();
    expect((await bubble("tuning"))!.etiquette).toBe("div#banniere.cookies");
    expect((await add("tuning", "Liste")).ok).toBe(true);
    await expect.poll(() => pngs("tuning").length, { timeout: 10_000 }).toBe(before.length + 1);
    let png = await readPng(m, pngs("tuning").find((f) => !before.includes(f))!, []);
    expect([png.width, png.height]).toEqual([Math.round(rv.width * 2), Math.round(rv.height * 2)]);
    await inStore(m, `await store.design.stop(arguments[0]); return 1;`, [T("tuning")]);
    // The home (sonde).
    await homeOn("sonde");
    const h = await homeRect("sonde", "#cible");
    const rh = rectCapture({ x: h.x, y: h.y, largeur: h.largeur, hauteur: h.hauteur }, h.vue, 1);
    before = pngs("sonde");
    await aimHome("sonde", "#cible");
    expect((await add("sonde", "Cible")).ok).toBe(true);
    await expect.poll(() => pngs("sonde").length, { timeout: 10_000 }).toBe(before.length + 1);
    png = await readPng(m, pngs("sonde").find((f) => !before.includes(f))!, [[Math.round(rh.width), Math.round(rh.height)]]);
    expect([png.width, png.height]).toEqual([Math.round(rh.width * 2), Math.round(rh.height * 2)]);
    expect(png.at[0]).toEqual([0, 200, 0]);
  });
});
