import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { rectCapture } from "../chrome/store/design-copies";
import { testActor } from "./actors";
import {
  WITH_HOME,
  withHomeDeclaration,
  overlayOf,
  inStore,
  readPng,
  siteExpr,
  siteKey,
  siteMouse,
  toHome,
  toSite,
  TUNING_PAGE,
  tuningDeclaration,
  viewExpr,
  viewPoint,
} from "./design-sites";
import { waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { grantSite, HOME_COPY, homePoint, inHomeFrame, inSiteBar, inSiteView, resolveLocalHosts, siteHomeBrowser, startSitesServer, writeSite } from "./sites";
import { killFrames } from "./ui";

// Plan 36 Task 3: the design mode on a site app's home (spike S6), a remote frame of the bar aimed by the
// RessacDesignFrames actor (chrome/agent/design-actor.ts). Apps avec-accueil and sonde (spike S6's home, for the
// measures), tuning for the view at density 2. Block 15355-15359: sites on 15355.

const PORT = 15355;
const IDS = ["avec-accueil", "sonde", "tuning"];
const MOUSE = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu", "dblclick"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = (id: string) => ({ type: "site", id });
const tid = (t: string) => `[data-testid="${t}"]`;
const FRAME = tid("site-home-frame");

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
let w: LaunchedRessac;
let m: Marionette;
const dirs: string[] = [];
const url = (host: string, path = "/") => server.url(host, path);
const declarationProbe = () => ({ ...withHomeDeclaration(url), name: "Sonde" });

async function launch(prefs: Record<string, string | number | boolean> = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
  dirs.push(dataDir, profile);
  writeSite(dataDir, "avec-accueil", { declaration: withHomeDeclaration(url), files: { "home/index.html": WITH_HOME } });
  writeSite(dataDir, "sonde", { declaration: declarationProbe(), files: { "home/index.html": HOME } });
  writeSite(dataDir, "tuning", { declaration: tuningDeclaration(url), files: { "tweaks/tuning.css": "/* rien */" } });
  await grantSite(dataDir, "tuning", tuningDeclaration(url));
  const a = testActor(profile);
  w = await launchRessac({ dataDir, profile, env: { RESSAC_TEST_LOCAL_ADDRESSES: "1", ...a.env }, prefs: { ...a.prefs, ...prefs } });
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
  server.define("tuning-a.localhost", "/", TUNING_PAGE);
});
afterAll(async () => {
  await server?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
afterEach(async () => {
  await inStore(m, `for (const id of arguments[0]) { await store.design.stop({ type: "site", id }); store.design.closeOverlay({ type: "site", id }, "basket"); } return 1;`, [IDS]);
});

const state = (id: string) => inStore<{ active: boolean; basket: number }>(m, "return await store.design.state(arguments[0]);", [T(id)]);
const toggle = (id: string) => inStore(m, "await store.design.toggle(arguments[0]); return 1;", [T(id)]);
const add = (id: string, text: string) => inStore<{ ok: boolean }>(m, "return await store.design.add(arguments[0], arguments[1]);", [T(id), text]);
const bubble = (id: string) => inStore<{ label: string; source: string | null; warning: string | null } | null>(m, 'return store.design.overlayContext(arguments[0], ["bubble"]);', [T(id)]);
const view = (id: string) => inStore<string | null>(m, "return store.sites.viewOf(arguments[0]);", [id]);
/** `body` in the home's page (test hook): `document`/`window` through Xrays, `fw` the page's window, `args`. */
const inHome = <T = unknown>(id: string, body: string, args: unknown[] = [], chrome = false) => inHomeFrame<T>(m, siteHomeBrowser(id), body, args, chrome) as Promise<T>;
const homeHosts = (id: string) => inHome<number | null>(id, `return document.getElementsByTagName("ressac-viewfinder").length;`).then((n) => n ?? -1, () => -1);
/** A query to the home's RessacDesignFrames actor, as the service sends it; `home` defaults to the served copies' prefix. */
const askHome = <T = unknown>(id: string, name: string, code: string, home?: string) =>
  m.execute<T>(
    `const g = ${siteHomeBrowser(id)}.browsingContext.currentWindowGlobal;
     const home = arguments[2] ?? g.documentURI.spec.match(/^resource:\\/\\/[^/]+/)[0] + "/sites/";
     return g.getActor("RessacDesignFrames").sendQuery(arguments[0], { code: arguments[1], home });`,
    [name, code, home ?? null],
  );
const viewHosts = (id: string) => inSiteView<number>(m, id, `return document.getElementsByTagName("ressac-viewfinder").length;`).catch(() => 0);
const homeLog = (id: string) => inHome<{ early: string[]; reactions: string[]; keys: string[] }>(id, "return JSON.parse(JSON.stringify(fw.log));");
const homeKeys = (id: string) => inHome<string[]>(id, "return Object.keys(fw);");
const bar = (id: string) =>
  inSiteBar<{ pressed: string | null; count: string | null }>(
    m,
    id,
    `return { pressed: doc.querySelector('${tid("site-design-button")}')?.getAttribute("aria-pressed") ?? null, count: doc.querySelector('${tid("site-basket-counter")}')?.textContent ?? null };`,
  );
const barPoint = (id: string, t: string) =>
  inSiteBar<{ x: number; y: number }>(
    m,
    id,
    `const b = win.document.getElementById("ressac-site-bar").getBoundingClientRect(), r = doc.querySelector('${tid(t)}').getBoundingClientRect();
     return { x: b.left + r.left + r.width / 2, y: b.top + r.top + r.height / 2 };`,
  );
const overlayTop = (id: string) => overlayOf<number>(m, id, "return f.getBoundingClientRect().y;");
const bubbleText = (id: string) => overlayOf<string | null>(m, id, `return doc.querySelector('${tid("design-bubble")}')?.textContent ?? null;`);
/** The home element's rectangle, in its frame's CSS pixels (as the viewfinder's capture). */
const homeRect = (id: string, sel: string) =>
  inHome<{ x: number; y: number; width: number; height: number; view: { width: number; height: number } }>(
    id,
    `const r = document.querySelector(args[0]).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, view: { width: window.innerWidth, height: window.innerHeight } };`,
    [sel],
  );
const projectFiles = (id: string) =>
  (readdirSync(w.dataDir, { recursive: true }) as string[]).filter((f) => f.includes(`site-${id}`) && !f.includes(".git")).map((f) => path.join(w.dataDir, f)).filter((f) => statSync(f).isFile());
const pngs = (id: string) => projectFiles(id).filter((f) => f.endsWith(".png"));
const agentInput = () => {
  const f = path.join(w.dataDir, "workspace", "fake-agent-input.txt");
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
  await siteMouse(m, id, await homePoint(m, siteHomeBrowser(id), sel));
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
    await siteMouse(m, "avec-accueil", await homePoint(m, siteHomeBrowser("avec-accueil"), "#titre"));
    await expect.poll(() => bubbleText("avec-accueil"), { timeout: 10_000 }).toContain("h1#titre");
    expect(await overlayOf(m, "avec-accueil", `return doc.querySelectorAll('${tid("bubble-warning")}').length;`)).toBe(0);
    expect(await overlayTop("avec-accueil")).toBeGreaterThanOrEqual(36);
    await expect.poll(() => overlayOf(m, "avec-accueil", "return doc.activeElement?.localName ?? null;"), { timeout: 10_000 }).toBe("textarea");
    await overlayOf(m, "avec-accueil", `const t = doc.querySelector("textarea"); t.value = "Titre plus gros"; t.dispatchEvent(new f.contentWindow.Event("input", { bubbles: true })); return 1;`);
    await siteKey(m, "avec-accueil", "Enter", ["Meta"]);
    await expect.poll(async () => (await bar("avec-accueil")).count, { timeout: 10_000 }).toBe("1");
    await expect.poll(() => homeHosts("avec-accueil"), { timeout: 10_000 }).toBe(1);
    // « Entrer dans le site »: the view changes, the mode stops.
    await siteMouse(m, "avec-accueil", await barPoint("avec-accueil", "site-enter"));
    await expect.poll(async () => (await bar("avec-accueil")).pressed, { timeout: 10_000 }).toBe("false");
    await expect.poll(() => m.execute(`return ${viewExpr("avec-accueil")}.currentURI.spec;`), { timeout: 10_000 }).toBe(url("tuning-a.localhost", "/"));
    // The send: the pre-filled text points at accueil/ and tags the remark.
    await inSiteBar(m, "avec-accueil", `doc.querySelector('${tid("site-menu-design")}').click(); return 1;`);
    await expect.poll(() => inSiteBar(m, "avec-accueil", `return !!doc.querySelector('${tid("site-menu-design-basket")}');`), { timeout: 10_000 }).toBe(true);
    await inSiteBar(m, "avec-accueil", `doc.querySelector('${tid("site-menu-design-basket")}').click(); return 1;`);
    // Enabled once the basket is read (through the confined child).
    await expect.poll(() => overlayOf(m, "avec-accueil", `return doc.querySelector('${tid("send-remarks")}')?.disabled === false;`), { timeout: 10_000 }).toBe(true);
    await overlayOf(m, "avec-accueil", `doc.querySelector('${tid("send-remarks")}').click(); return 1;`);
    await expect.poll(agentInput, { timeout: 20_000 }).toContain("les remarques [accueil] visent son écran d'accueil, à changer dans home/");
    expect(agentInput()).toContain('1) [accueil] "h1#titre" : « Titre plus gros »');
    const dir = path.join(w.dataDir, "workspace", ".ressac", "remarks", "site-avec-accueil");
    const [batch] = readdirSync(dir).filter((n) => /^\d{8}T\d{6}Z-[0-9a-f]{4}$/.test(n));
    const content = JSON.parse(readFileSync(path.join(dir, batch!, "batch.json"), "utf8"));
    expect(content.items[0].context.url).toBe("ressac-site://avec-accueil/index.html");
    expect(readdirSync(path.join(dir, batch!)).filter((n) => n.endsWith(".png"))).toHaveLength(1);
  });

  it("the home viewfinder's sandbox reaches nothing of the chrome nor the home's globals", async () => {
    await toHome(m, "sonde");
    // The actor's own sandbox (its arm), with S6's reach list as its code.
    const reach = await askHome<Record<string, string>>(
      "sonde",
      "arm",
        `(() => {
         const t = (f) => { try { const v = f(); return v === null || v === undefined ? String(v) : typeof v === "object" || typeof v === "function" ? typeof v + ":" + Object.prototype.toString.call(v) : String(v); } catch (e) { return "throws:" + String(e).slice(0, 90); } };
         return { Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services, Cu: typeof Cu, docShell: typeof docShell, gBrowser: typeof gBrowser,
           ressacSiteWindow: typeof ressacSiteWindow, windowRoot: typeof windowRoot, homeSecret: typeof homeSecret, origin: location.origin, href: location.href,
           frameElement: t(() => frameElement), topIsSelf: t(() => top.document === document && parent.document === document),
           parentSiteWindow: t(() => parent.ressacSiteWindow), topGBrowser: t(() => top.gBrowser), topSiteWindow: t(() => top.ressacSiteWindow),
           opener: t(() => opener), ownerGlobal: t(() => document.ownerGlobal) };
       })()`,
    );
    expect(reach).toMatchObject({ Components: "undefined", ChromeUtils: "undefined", Services: "undefined", Cu: "undefined", docShell: "undefined", gBrowser: "undefined", ressacSiteWindow: "undefined", windowRoot: "undefined", homeSecret: "undefined" });
    for (const k of ["parentSiteWindow", "topGBrowser", "topSiteWindow"]) expect(String(reach[k])).toMatch(/^throws:|^undefined$/);
    // The home is the top of its own remote frame: no parent to reach, the bar is in another process.
    expect(reach.topIsSelf).toBe("true");
    expect(reach.frameElement).toBe("null");
    expect(reach.opener).toBe("null");
    // The served copy (a null principal from the sandbox flags; location keeps the copy's address).
    expect(reach.href).toMatch(HOME_COPY);
  });

  it("the home viewfinder arms only on the served home: no prefix, another token's or the widgets' gives null, nothing set", async () => {
    await toHome(m, "sonde");
    const code = `(document.documentElement.setAttribute("data-armed", "1"), { ok: 1 })`;
    const origin = (await inHome<string>("sonde", "return document.documentURI;"))!.match(/^resource:\/\/[^/]+/)![0];
    const answers = [];
    for (const home of ["", "resource://ressac-frames-0000000000000000/sites/", `${origin}/widgets/`, `${origin}/sites/x`]) answers.push(await askHome("sonde", "arm", code, home));
    answers.push(await askHome("sonde", "source", "document.title", ""));
    expect(answers).toEqual([null, null, null, null, null]);
    expect(await inHome("sonde", `return document.documentElement.getAttribute("data-armed");`)).toBeNull();
    // The served prefix arms (the code ran, its answer comes back).
    expect(await askHome("sonde", "source", "document.title")).toBe("Accueil");
  });

  // Review Focus 4.
  it("the home viewfinder's sandbox cannot navigate the bar or the window", async () => {
    await toHome(m, "sonde");
    const uris = () => inSiteBar<{ bar: string; win: string }>(m, "sonde", "return { bar: doc.documentURI, win: win.document.documentURI };");
    const before = await uris();
    const sorted = await askHome<Record<string, string>>(
      "sonde",
      "arm",
        `(() => {
         const t = (f) => { try { f(); return "ran"; } catch (e) { return "throws:" + String(e).slice(0, 90); } };
         return { parentLocation: t(() => { parent.location = "about:blank"; }), topHref: t(() => { top.location.href = "about:blank"; }), parentHref: t(() => { parent.location.href = "about:blank"; }),
           topReplace: t(() => top.location.replace("about:blank")), postMessage: t(() => parent.postMessage({ type: "open", url: "about:blank" }, "*")) };
       })()`,
    );
    expect(Object.values(sorted)).toHaveLength(5);
    for (const r of Object.values(sorted)) expect(r).toMatch(/^(ran|throws:)/);
    await sleep(1000);
    // parent and top are the home itself: at most the home leaves its copy, and is sent back to it.
    expect(await uris()).toEqual(before);
    expect(await view("sonde")).toBe("home");
    await expect.poll(() => inHome<string | null>("sonde", `return document.readyState === "complete" ? document.documentURI : null;`), { timeout: 15_000 }).toMatch(/\/sites\/sonde-/);
  });

  it("hover frames p#nue; middle and right clicks pick nothing; the primary click captures #cible; the home saw nothing, no global added", async () => {
    await toHome(m, "sonde");
    await inHome("sonde", "fw.log.early.length = 0; fw.log.reactions.length = 0; return 1;");
    const keys0 = await homeKeys("sonde");
    await toggle("sonde");
    await expect.poll(() => homeHosts("sonde"), { timeout: 10_000 }).toBe(1);
    await siteMouse(m, "sonde", await homePoint(m, siteHomeBrowser("sonde"), "#nue"), { move: true });
    await expect
      .poll(() => inHome<string | null>("sonde", `const sh = document.querySelector("ressac-viewfinder")?.openOrClosedShadowRoot; return sh?.children[1]?.textContent ?? null;`, [], true), { timeout: 10_000 })
      .toBe("p#nue");
    expect(await inHome("sonde", `return String(fw.document.querySelector("ressac-viewfinder").shadowRoot);`)).toBe("null");
    await siteMouse(m, "sonde", await homePoint(m, siteHomeBrowser("sonde"), "#nue"), { button: 1 });
    await siteMouse(m, "sonde", await homePoint(m, siteHomeBrowser("sonde"), "#nue"), { button: 2 });
    await sleep(500);
    expect(await bubble("sonde")).toBeNull();
    const b = await aimHome("sonde", "#cible");
    expect(b.label).toBe("div#cible");
    expect(b.warning).toBeNull();
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
    expect(b.label).toBe("p#nue");
    expect(b.source).toBeNull();
  });

  it("the home's PNG is the frame's only", async () => {
    await homeOn("sonde");
    const r = await homeRect("sonde", "#cible");
    const rc = rectCapture({ x: r.x, y: r.y, width: r.width, height: r.height }, r.view, 1);
    // A magenta cover in the bar's document over #cible: the window shows it, the capture must not.
    await inSiteBar(m, "sonde", `const h = doc.querySelector('${FRAME} browser').getBoundingClientRect(), rc = arguments[0], cover = doc.createElement("div"); cover.id = "e2e-cover";
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
      await inSiteBar(m, "sonde", `doc.getElementById("e2e-cover")?.remove(); return 1;`);
    }
  });

  // Review Focus 1.
  it("Escape in the home stops the mode; a click and an Escape made by the home do nothing", async () => {
    await homeOn("sonde");
    await inHome("sonde", "fw.log.keys.length = 0; return 1;");
    // The home's own untrusted click and Escape.
    await inHome("sonde", "fw.fabricate(); return 1;");
    await sleep(500);
    expect(await bubble("sonde")).toBeNull();
    expect((await state("sonde")).active).toBe(true);
    expect(await homeHosts("sonde")).toBe(1);
    // The home's own events reached it (untrusted): the guard let them through, untouched.
    expect((await homeLog("sonde")).keys).toEqual(["Escape:false"]);
    // A real Escape, the keyboard in the home's frame.
    await expect.poll(() => inHome("sonde", "return document.hasFocus();"), { timeout: 10_000 }).toBe(true);
    await siteKey(m, "sonde", "Escape");
    await expect.poll(async () => (await bar("sonde")).pressed, { timeout: 10_000 }).toBe("false");
    await expect.poll(() => homeHosts("sonde"), { timeout: 10_000 }).toBe(0);
    expect((await homeLog("sonde")).keys).toEqual(["Escape:false"]);
  });

  // Review Focus 5.
  it("the home re-served while aiming: the mode stops", async () => {
    await homeOn("sonde");
    const errors0 = await m.execute<number>(`return Services.console.getMessageArray().filter((x) => /dead object/.test(String(x.message ?? x))).length;`);
    writeFileSync(path.join(w.dataDir, "workspace", "sites", "sonde", "home", "index.html"), HOME.replace("<title>Accueil</title>", "<title>Accueil 2</title>"));
    await expect.poll(async () => (await bar("sonde")).pressed, { timeout: 10_000 }).toBe("false");
    await expect.poll(async () => (await state("sonde")).active, { timeout: 10_000 }).toBe(false);
    await expect.poll(() => inHome("sonde", "return document.readyState === 'complete' ? document.title : null;"), { timeout: 15_000 }).toBe("Accueil 2");
    expect(await m.execute<number>(`return Services.console.getMessageArray().filter((x) => /dead object/.test(String(x.message ?? x))).length;`)).toBe(errors0);
    // A new arm works on the new document.
    await toggle("sonde");
    await expect.poll(() => homeHosts("sonde"), { timeout: 10_000 }).toBe(1);
    expect((await aimHome("sonde", "#cible")).label).toBe("div#cible");
  });

  // Measured: design.ts's capture listener on the site window gets the home frame's crash before remote-frame.ts stops it there.
  it("the frames' process killed while aiming at the home: the mode stops, nothing left on the dead page; a new arm aims the revived home", async () => {
    await homeOn("sonde");
    await killFrames(m);
    await expect.poll(async () => (await state("sonde")).active, { timeout: 10_000 }).toBe(false);
    expect((await bar("sonde")).pressed).toBe("false");
    expect(await overlayOf(m, "sonde", "return 1;")).toBeNull();
    await expect.poll(() => inHome("sonde", "return document.readyState === 'complete' && !!document.getElementById('cible');").catch(() => null), { timeout: 20_000 }).toBe(true);
    expect(await homeHosts("sonde")).toBe(0);
    await toggle("sonde");
    await expect.poll(() => homeHosts("sonde"), { timeout: 10_000 }).toBe(1);
    expect((await aimHome("sonde", "#cible")).label).toBe("div#cible");
  }, 60_000);

  it("⌂ while aiming in the site view, then ⇧⌘D on the home: the home is aimed, the view is not", async () => {
    await toSite(m, "avec-accueil");
    await toggle("avec-accueil");
    await expect.poll(() => viewHosts("avec-accueil"), { timeout: 10_000 }).toBe(1);
    await inSiteBar(m, "avec-accueil", `doc.querySelector('${tid("site-home")}').click(); return 1;`);
    await expect.poll(async () => (await bar("avec-accueil")).pressed, { timeout: 10_000 }).toBe("false");
    await expect.poll(() => viewHosts("avec-accueil"), { timeout: 10_000 }).toBe(0);
    await toHome(m, "avec-accueil");
    await siteKey(m, "avec-accueil", "d", ["Meta", "Shift"]);
    await expect.poll(() => homeHosts("avec-accueil"), { timeout: 10_000 }).toBe(1);
    await sleep(300);
    expect(await viewHosts("avec-accueil")).toBe(0);
    expect((await aimHome("avec-accueil", "#titre")).label).toBe("h1#titre");
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
    const r = await inSiteView<{ x: number; y: number; width: number; height: number; view: { width: number; height: number } }>(
      m,
      "tuning",
      `const r = document.querySelector("#banniere").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, view: { width: innerWidth, height: innerHeight } };`,
    );
    const zoom = await m.execute<number>(`return ${viewExpr("tuning")}.fullZoom;`);
    const rv = rectCapture({ x: r.x, y: r.y, width: r.width, height: r.height }, r.view, zoom);
    let before = pngs("tuning");
    await toggle("tuning");
    await expect.poll(() => viewHosts("tuning"), { timeout: 10_000 }).toBe(1);
    await siteMouse(m, "tuning", await viewPoint(m, "tuning", "#banniere"));
    await expect.poll(() => bubble("tuning"), { timeout: 10_000 }).not.toBeNull();
    expect((await bubble("tuning"))!.label).toBe("div#banniere.cookies");
    expect((await add("tuning", "Liste")).ok).toBe(true);
    await expect.poll(() => pngs("tuning").length, { timeout: 10_000 }).toBe(before.length + 1);
    let png = await readPng(m, pngs("tuning").find((f) => !before.includes(f))!, []);
    expect([png.width, png.height]).toEqual([Math.round(rv.width * 2), Math.round(rv.height * 2)]);
    await inStore(m, `await store.design.stop(arguments[0]); return 1;`, [T("tuning")]);
    // The home (sonde).
    await homeOn("sonde");
    const h = await homeRect("sonde", "#cible");
    const rh = rectCapture({ x: h.x, y: h.y, width: h.width, height: h.height }, h.view, 1);
    before = pngs("sonde");
    await aimHome("sonde", "#cible");
    expect((await add("sonde", "Cible")).ok).toBe(true);
    await expect.poll(() => pngs("sonde").length, { timeout: 10_000 }).toBe(before.length + 1);
    png = await readPng(m, pngs("sonde").find((f) => !before.includes(f))!, [[Math.round(rh.width), Math.round(rh.height)]]);
    expect([png.width, png.height]).toEqual([Math.round(rh.width * 2), Math.round(rh.height * 2)]);
    expect(png.at[0]).toEqual([0, 200, 0]);
  });
});
