import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanCapture, cleanSource, firefoxViewfinderScript, LARGEUR_PANIER, MARGE, placeBulle, rectCapture, sourceExpression, STOP_SCRIPT } from "../../chrome/store/design-copies";
import { testActor } from "../agent-extensions";
import { armActor, HOOKS_PAGE, stopActor } from "../design";
import { waitReady } from "../firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "../launch";
import type { Marionette } from "../marionette";
import { grantSite, inSiteBar, inSiteView, resolveLocalHosts, siteWindowExpr, startSitesServer, writeSite } from "../sites";

// Spikes S5-S7 of plan 36 (spec 2026-11-06-webaios-firefox-mode-design-design.md §6): the design mode in a site app's
// window, on the current build, with the WebAiOsDesign actor as shipped (`pnpm ui`'s copy, or the packaged one with
// WEBAIOS_E2E_PACKAGED_ACTOR=1). The home's viewfinder (S6) and the overlay (S7) are done from the chrome, as plan 36
// would. Security lines are asserted; the rest is printed as `[spike] <what>: <JSON>`. Rerun with WEBAIOS_SPIKE=1.
// Port 15330 (block 15330-15344).

const ID = "vidola";
const PORT = 15330;
const SITE = siteWindowExpr(ID);
const VIEW = `${SITE}.gBrowser.selectedBrowser`;
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const MOUSE = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu", "dblclick"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const note = (what: string, v: unknown) => console.log(`[spike] ${what}: ${JSON.stringify(v)}`);

/** design.html with the hostile page's hooks (HOOKS_PAGE), plus a password field and a green target. */
const S5_PAGE = HOOKS_PAGE.replace('<button type="submit" id="envoyer">', '<input type="password" id="mdp" name="mdp"> <button type="submit" id="envoyer">').replace(
  "</body>",
  '<div id="cible" style="position:absolute;left:300px;top:200px;width:80px;height:30px;background:rgb(0,200,0)"></div><p class="cache">caché</p></body>',
);

/**
 * The agent's tweak, run in WebAiOsSite's sandbox after the password guard: it listens first (window capture), hooks
 * the prototypes the viewfinder calls (in its own world), fakes the viewfinder's globals, and on « essai » writes
 * what it sees into the DOM. It never calls a hooked function itself.
 */
const RETOUCHE = `
const R = document.documentElement;
const log = { early: [], keys: [], hooked: [], fake: 0 };
for (const t of ${JSON.stringify(MOUSE)}) window.addEventListener(t, (e) => log.early.push(t + ":" + e.isTrusted), true);
document.addEventListener("keydown", (e) => log.keys.push((e.target && e.target.id) + ":" + e.key + ":" + e.isTrusted), true);
const hook = (o, k) => { try { const f = o[k]; o[k] = function (...a) { log.hooked.push(k); return f.apply(this, a); }; } catch {} };
hook(Element.prototype, "attachShadow"); hook(Document.prototype, "createElement"); hook(Element.prototype, "getBoundingClientRect");
hook(window, "getComputedStyle"); hook(Document.prototype, "querySelectorAll"); hook(CSS, "escape");
globalThis.__viseurArret = () => log.fake++; globalThis.__viseurAvaler = () => log.fake++; globalThis.__viseurChoisir = () => log.fake++;
globalThis.__retoucheSecret = "r";
R.dataset.retouche = "oui";
document.addEventListener("essai", () => {
  const hosts = document.getElementsByTagName("webaios-viseur");
  const pw = document.getElementById("mdp");
  R.dataset.sonde = JSON.stringify({ log, hosts: hosts.length, shadow: hosts[0] ? String(hosts[0].shadowRoot) : "none", closed: hosts[0] ? typeof hosts[0].openOrClosedShadowRoot : "none",
    pw: pw.value, pwAttr: String(pw.getAttribute("value")), fakeIsMine: globalThis.__viseurArret.toString().includes("log.fake") });
});`;

/** The agent's home (its own code): listens first on its window, keeps a global, a green target with a data-source. */
const HOME = `<!doctype html><meta charset="utf-8"><title>Accueil</title>
<script>
  window.log = { early: [], reactions: [] };
  for (const t of ${JSON.stringify(MOUSE)}) {
    addEventListener(t, (e) => log.early.push(t + ":" + e.isTrusted), true);
    document.addEventListener(t, (e) => log.reactions.push(t + ":" + (e.target.id || e.target.localName)));
  }
  window.homeSecret = "h";
</script>
<style>body{margin:0;background:#fff;height:900px} #cible{position:absolute;left:40px;top:60px;width:120px;height:40px;background:rgb(0,200,0)}</style>
<div id="cible" data-source="src/Accueil.svelte:7">cible</div>
<p id="nue" style="position:absolute;left:40px;top:160px">nue</p>
<script>parent.postMessage({ type: "pret" }, "*");</script>`;

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const dirs: string[] = [];
const url = (p: string) => server.url("vidola-a.localhost", p);
const vidola = () => ({ nom: "Vidola", adresse: url("/design"), domaines: ["vidola-a.localhost"], retouches: [{ correspond: ["/design"], js: ["sonde.js"], css: ["cacher.css"] }] });

const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
const view = <T = unknown>(expr: string) => inSiteView<T>(m, ID, `return ${expr};`).catch(() => null);
const vue = () => inStore<string | null>(`return store.sites.viewOf(arguments[0]);`, [ID]);

/** A trusted gesture sent by the site window (as a person's mouse): a move, then a click of `button` unless `move`. */
const siteMouse = (p: { x: number; y: number }, o: { button?: number; move?: boolean } = {}) =>
  m.execute(
    `return (async ([x, y, button, move]) => {
       const win = ${SITE};
       win.synthesizeMouseEvent("mousemove", x, y, { button: 0, clickCount: 0 });
       await new Promise((r) => setTimeout(r, 50));
       if (move) return;
       win.synthesizeMouseEvent("mousedown", x, y, { button, clickCount: 1 });
       win.synthesizeMouseEvent("mouseup", x, y, { button, clickCount: 1 });
       if (button === 2) win.synthesizeMouseEvent("contextmenu", x, y, { button: 2, clickCount: 1 });
     })(arguments);`,
    [p.x, p.y, o.button ?? 0, o.move ?? false],
  );

/** The centre of `sel` in the app view, in the site window's coordinates. */
async function viewPoint(sel: string): Promise<{ x: number; y: number }> {
  const c = await inSiteView<{ x: number; y: number }>(m, ID, `const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  const b = await m.execute<{ x: number; y: number; z: number }>(`const r = ${VIEW}.getBoundingClientRect(); return { x: r.left, y: r.top, z: ${VIEW}.fullZoom };`);
  return { x: b.x + c.x * b.z, y: b.y + c.y * b.z };
}

/** The tweak's answer to « essai ». */
async function retouche(): Promise<any> {
  await view(`(document.documentElement.dataset.sonde = "", document.dispatchEvent(new Event("essai")), 1)`);
  return JSON.parse(String(await view("document.documentElement.dataset.sonde")));
}

/** Trusted keys in the site window (nsITextInputProcessor), to its focused element. */
const siteKey = (key: string) =>
  m.execute(
    `const win = ${SITE};
     const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
     tip.beginInputTransactionForTests(win);
     const ev = new win.KeyboardEvent("", { key: arguments[0], code: arguments[0].length === 1 ? "Key" + arguments[0].toUpperCase() : arguments[0] });
     tip.keydown(ev); tip.keyup(ev);`,
    [key],
  );

async function openApp(): Promise<void> {
  if (!(await inStore<boolean>(`return store.sites.openIds().includes(arguments[0]);`, [ID])))
    await inStore(`await store.agent.request("sites.agir", { id: arguments[0], action: "ouvrir", fenetre: store.state.fenetres[0].id });`, [ID]);
  await expect.poll(vue, { timeout: 15_000 }).not.toBeNull();
}

/** The site's page in the view, tweaks run. */
async function toSite(): Promise<void> {
  await openApp();
  if ((await vue()) !== "site") await inStore(`store.sites.controller(arguments[0]).enter();`, [ID]);
  await expect.poll(() => m.execute(`return ${VIEW}.currentURI.spec;`), { timeout: 15_000 }).toBe(url("/design"));
  await expect.poll(() => view("document.documentElement.dataset.retouche ?? null"), { timeout: 10_000 }).toBe("oui");
}

/** The home in the bar, shown and loaded from its served copy. */
async function toHome(): Promise<void> {
  await openApp();
  if ((await vue()) !== "accueil") await inStore(`store.sites.controller(arguments[0]).home();`, [ID]);
  await expect
    .poll(() => inSiteBar<string | null>(m, ID, `const h = doc.querySelector('[data-testid="site-cadre-accueil"]'); const d = h?.contentDocument; return d?.readyState === "complete" && d.getElementById("cible") ? String(d.documentURI) : null;`), { timeout: 15_000 })
    .toMatch(/^resource:\/\/webaios-site-/);
}

/** The PNG pixel at (x, y) of a snapshot (an ImageBitmap) of `size`, as "r,g,b" (chrome code). */
const PIXELS = `const pixels = (bmp, pts) => { const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas"); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext("2d"); g.drawImage(bmp, 0, 0); return pts.map(([x, y]) => [...g.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3).join(",")); };`;

describe.skipIf(!process.env.WEBAIOS_SPIKE)("design mode in site apps, spikes S5-S7 (plan 36)", () => {
  beforeAll(async () => {
    server = await startSitesServer({ port: PORT });
    server.definir("vidola-a.localhost", "/design", S5_PAGE);
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
    dirs.push(dataDir, profile);
    writeSite(dataDir, ID, { declaration: vidola(), fichiers: { "retouches/sonde.js": RETOUCHE, "retouches/cacher.css": ".cache { display: none; }", "accueil/index.html": HOME } });
    await grantSite(dataDir, ID, vidola());
    const a = testActor(profile);
    w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1", ...a.env }, prefs: a.prefs });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    await resolveLocalHosts(m, ["vidola-a.localhost"]);
    note("actor", process.env.WEBAIOS_E2E_PACKAGED_ACTOR === "1" ? "packaged (build:ui)" : "pnpm ui copy (testActor)");
  }, 120_000);
  afterAll(async () => {
    await w?.close();
    await server?.fermer();
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("S5: the viewfinder in the view with tweaks active: two sandboxes apart, password guard holds, page sees nothing, capture is the page's", async () => {
    await toSite();
    await view(`(document.getElementById("mdp").value = "hunter2", 1)`);
    const info = await m.execute(
      `const wg = ${VIEW}.browsingContext.currentWindowGlobal; return { remoteType: wg.domProcess.remoteType, uc: ${VIEW}.getAttribute("usercontextid"), css: ${JSON.stringify("")} };`,
    );
    const css = await view(`getComputedStyle(document.querySelector(".cache")).display`);
    note("S5 info", { ...(info as object), retoucheCss: css });
    expect(css).toBe("none");
    const before = await retouche();
    note("S5 retouche before", before);
    expect(before.pw).toBe("");

    // The viewfinder's sandbox, probed through the shipped actor's arm (its code is the parent's to send).
    const probe = `(() => ({ webaiosSite: typeof webaiosSite, portee: typeof __webaiosPortee, fichier: typeof __webaiosFichier, retoucheSecret: typeof __retoucheSecret,
      pageSecret: typeof pageSecret, arret: typeof __viseurArret, Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services,
      pwLength: document.getElementById("mdp").value.length,
      nativeValue: String(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").get).includes("[native code]"),
      nativeAttach: String(Element.prototype.attachShadow).includes("[native code]"), nativeQsa: String(Document.prototype.querySelectorAll).includes("[native code]") }))()`;
    const sees = await (await armActor(m, VIEW, probe)).result();
    note("S5 viewfinder sandbox sees", sees);
    expect(sees).toMatchObject({ r: { webaiosSite: "undefined", portee: "undefined", fichier: "undefined", retoucheSecret: "undefined", pageSecret: "undefined", arret: "undefined", Components: "undefined", ChromeUtils: "undefined", Services: "undefined", nativeValue: true, nativeAttach: true, nativeQsa: true } });
    await sleep(600);

    // Marionette's content scripts run in the page's world: every point is read first, then the page's log is emptied.
    const [pEmail, pMdp] = [await viewPoint("#email"), await viewPoint("#mdp")];
    const pageKeys0 = await view<string[]>("Object.keys(window)");
    await view("(window.log.hooked.length = 0, 1)");
    const a = await armActor(m, VIEW);
    await expect.poll(() => view("document.getElementsByTagName('webaios-viseur').length"), { timeout: 10_000 }).toBe(1);
    const during = await retouche();
    note("S5 retouche while aiming", during);
    expect(during.pw).toBe("");
    expect(during.shadow).toBe("null");
    expect(during.fakeIsMine).toBe(true);
    // Hover, then the keyboard while aiming: a key on the password field never reaches the tweak, one on #email does.
    await siteMouse(pEmail, { move: true });
    await view(`(document.getElementById("mdp").focus(), 1)`);
    await m.execute(`${SITE}.focus(); ${VIEW}.focus();`);
    await view(`(document.getElementById("mdp").focus(), 1)`);
    await siteKey("x");
    await view(`(document.getElementById("email").focus(), 1)`);
    await siteKey("y");
    const keys = { retouche: (await retouche()).log.keys, page: await view("window.log.keys.slice()"), pwPage: await view(`document.getElementById("mdp").value`) };
    note("S5 keys while aiming", keys);
    expect(keys.retouche.filter((k: string) => k.startsWith("mdp:"))).toEqual([]);
    const pending = await a.result(200);
    expect(pending).toBe("pending");
    // A trusted click on the password field: captured, the value nowhere in the capture.
    await siteMouse(pMdp);
    const r = (await a.result()) as { r?: unknown };
    const c = cleanCapture(r.r);
    note("S5 capture of #mdp", { selecteur: c?.selecteur, etiquette: c?.etiquette, html: c?.html, adresse: c?.adresse, hasValue: JSON.stringify(r.r).includes("hunter2") });
    expect(c?.selecteur).toBe("#mdp");
    expect(JSON.stringify(r.r)).not.toContain("hunter2");
    const after = await retouche();
    const page = await view<any>("JSON.parse(JSON.stringify({ reactions: window.reactions, ...window.log }))");
    const pageKeys1 = await view<string[]>("Object.keys(window)");
    note("S5 after capture", { retouche: after, page, pageKeysAdded: pageKeys1?.filter((k) => !pageKeys0?.includes(k)) });
    expect(after.log.early).toEqual([]);
    expect(after.log.hooked).toEqual([]);
    expect(after.log.fake).toBe(0);
    expect(after.pw).toBe("");
    expect(page.early).toEqual([]);
    expect(page.docEarly).toEqual([]);
    expect(page.reactions).toEqual([]);
    expect(page.hooked).toEqual([]);
    expect(page.fakeStop).toBe(0);
    expect(pageKeys1?.filter((k) => !pageKeys0?.includes(k))).toEqual([]);
    await sleep(600);
    // The tweak's world and the page's world after: no viewfinder global, no host.
    expect(await view("document.getElementsByTagName('webaios-viseur').length")).toBe(0);
    const pageTypeof = await view<string>(
      `(() => { const s = document.createElement("script"); s.textContent = "document.documentElement.dataset.vu = [typeof webaiosSite, typeof __webaiosPortee, typeof __retoucheSecret].join()"; document.documentElement.append(s); s.remove(); return document.documentElement.dataset.vu; })()`,
    );
    note("S5 page world typeof webaiosSite, __webaiosPortee, __retoucheSecret", pageTypeof);
    expect(pageTypeof).toBe("undefined,undefined,undefined");

    // Escape (trusted) while aiming ends it with null; the tweak does not see it.
    const e = await armActor(m, VIEW);
    await expect.poll(() => view("document.getElementsByTagName('webaios-viseur').length"), { timeout: 10_000 }).toBe(1);
    await siteKey("Escape");
    const esc = await e.result(3000);
    note("S5 Escape", { esc, retoucheKeys: (await retouche()).log.keys });
    if (esc === "pending") await stopActor(m, VIEW);

    // The capture: drawn by the view's WindowGlobal only. A magenta chrome cover over #cible, the bar above the view.
    const cible = await inSiteView<{ x: number; y: number; largeur: number; hauteur: number }>(m, ID, `const r = document.getElementById("cible").getBoundingClientRect(); return { x: r.x, y: r.y, largeur: r.width, hauteur: r.height };`);
    const vueDims = await view<{ largeur: number; hauteur: number }>("({ largeur: innerWidth, hauteur: innerHeight })");
    const rc = rectCapture(cible, vueDims!, 1);
    const shot = await m.execute(
      `return (async ([rc]) => {
         const win = ${SITE}; ${PIXELS}
         const b = ${VIEW}.getBoundingClientRect();
         const cover = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
         cover.style.cssText = "position:fixed;z-index:10;background:rgb(255,0,255);left:" + (b.left + rc.x) + "px;top:" + (b.top + rc.y) + "px;width:" + rc.width + "px;height:" + rc.height + "px";
         win.document.documentElement.append(cover);
         await new Promise((r) => win.requestAnimationFrame(() => win.setTimeout(r, 50)));
         const wg = ${VIEW}.browsingContext.currentWindowGlobal;
         const bmp = await wg.drawSnapshot(new win.DOMRect(rc.x, rc.y, rc.width, rc.height), win.devicePixelRatio, "white", { drawView: true });
         const top = await wg.drawSnapshot(new win.DOMRect(0, 0, 200, 20), 1, "white", { drawView: true });
         const whole = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
         const out = { size: [bmp.width, bmp.height], rc, page: pixels(bmp, [[bmp.width / 2, bmp.height / 2], [1, 1]]), viewTop: pixels(top, [[100, 2]]),
           window: pixels(whole, [[b.left + rc.x + rc.width / 2, b.top + rc.y + rc.height / 2], [100, 10]]), barBottom: win.document.getElementById("webaios-site-bar").getBoundingClientRect().bottom, viewTopY: b.top };
         cover.remove();
         return out;
       })(arguments);`,
      [rc],
    );
    note("S5 capture", shot);
    const s = shot as { page: string[]; window: string[]; viewTop: string[] };
    expect(s.page[0]).toBe("0,200,0");
    expect(s.window[0]).toBe("255,0,255");
    expect(s.viewTop[0]).not.toBe(s.window[1]);
  });

  it("S6: the viewfinder on the home (a resource:// frame of the bar, parent process), from the chrome without an actor", async () => {
    await toHome();
    // The chrome's own sandbox on the home's document, its guard on the frame's chrome event handler, filtered to the home.
    const setup = await inSiteBar(
      m,
      ID,
      `const CU = Components.utils;
       const home = doc.querySelector('[data-testid="site-cadre-accueil"]');
       const hdoc = home.contentDocument, hwin = hdoc.defaultView;
       const sb = CU.Sandbox(hdoc.nodePrincipal, { sandboxPrototype: hwin, wantXrays: true, wantComponents: false, sameZoneAs: hwin, sandboxName: "spike S6 viseur" });
       Object.defineProperty(sb, "Components", { value: undefined });
       const handler = hwin.docShell.chromeEventHandler;
       const wg = home.browsingContext.currentWindowGlobal;
       const s = (win.__s6 = { CU, sb, home, hdoc, hwin, handler, seen: [], result: "none", unguard: () => {} });
       const inHome = (e) => { const t = e.composedTarget || e.target; return !!t && (t === hdoc || t.ownerDocument === hdoc); };
       s.guard = () => {
         s.unguard();
         let picked = false;
         const mouse = (e) => {
           s.seen.push(e.type + ":" + (inHome(e) ? "home" : "other") + ":" + e.isTrusted);
           if (!e.isTrusted || !inHome(e)) return;
           e.preventDefault();
           e.stopImmediatePropagation();
           if (e.type === "click" && e.button === 0 && !picked && typeof sb.__viseurChoisir === "function") { picked = true; sb.__viseurChoisir(e.target); }
         };
         const key = (e) => { if (!e.isTrusted || e.key !== "Escape" || !inHome(e)) return; e.preventDefault(); e.stopImmediatePropagation(); if (typeof sb.__viseurArret === "function") sb.__viseurArret(); };
         for (const t of ${JSON.stringify(MOUSE)}) handler.addEventListener(t, mouse, true);
         handler.addEventListener("keydown", key, true);
         let timer;
         s.unguard = () => { win.clearTimeout(timer); for (const t of ${JSON.stringify(MOUSE)}) handler.removeEventListener(t, mouse, true); handler.removeEventListener("keydown", key, true); s.unguard = () => {}; };
         s.later = () => (timer = win.setTimeout(() => s.unguard(), 500));
       };
       s.arm = (code) => {
         s.guard();
         s.result = "pending";
         CU.evalInSandbox(code, sb, "latest", "chrome://browser/content/webaios/webaios-viseur.js", 1).then(
           (r) => { s.result = r ? JSON.parse(JSON.stringify(r)) : null; r ? s.later() : s.unguard(); },
           (e) => { s.result = { e: String(e) }; s.unguard(); },
         );
       };
       s.stop = (code) => { try { CU.evalInSandbox(code, sb, "latest", "chrome://browser/content/webaios/webaios-viseur-arret.js", 1); s.stopped = "ok"; } catch (e) { s.stopped = String(e); } s.unguard(); };
       return { handlerIsFrame: handler === home, handlerIsBar: handler === win.document.getElementById("webaios-site-bar"), handlerIsRoot: handler === win.windowRoot,
         handler: ChromeUtils.getClassName(handler) + (handler.localName ? ":" + handler.localName : ""),
         principal: { isNull: hdoc.nodePrincipal.isNullPrincipal, origin: hdoc.nodePrincipal.origin }, uri: String(hdoc.documentURI).replace(/-[0-9a-f]{32}/, "-<token>"),
         itemType: hwin.docShell.itemType, sandboxFlags: home.browsingContext.sandboxFlags, wgp: ChromeUtils.getClassName(wg), inProcess: wg.isInProcess, processRoot: wg.isProcessRoot, osPid: wg.osPid, sameAsChrome: wg.osPid === win.browsingContext.currentWindowGlobal.osPid };`,
    );
    note("S6 home frame", setup);

    // What the viewfinder's sandbox can reach of the chrome around the frame.
    const reach = await inSiteBar(
      m,
      ID,
      `const s = win.__s6;
       return s.CU.evalInSandbox(\`(() => {
         const t = (f) => { try { const v = f(); return v === null || v === undefined ? String(v) : typeof v === "object" || typeof v === "function" ? typeof v + ":" + Object.prototype.toString.call(v) : String(v); } catch (e) { return "throws:" + String(e).slice(0, 90); } };
         return { Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services, Cu: typeof Cu, docShell: typeof docShell, gBrowser: typeof gBrowser,
           webaiosSiteWindow: typeof webaiosSiteWindow, windowRoot: typeof windowRoot, homeSecret: typeof homeSecret, origin: location.origin,
           parentIsSelf: t(() => parent === window), topIsSelf: t(() => top === window), topIsParent: t(() => top === parent), frameElement: t(() => frameElement),
           parentDocument: t(() => parent.document), topDocument: t(() => top.document), parentHref: t(() => parent.location.href), topHref: t(() => top.location.href),
           parentSiteWindow: t(() => parent.webaiosSiteWindow), topGBrowser: t(() => top.gBrowser), topSiteWindow: t(() => top.webaiosSiteWindow), parentFrames: t(() => parent.frames.length),
           opener: t(() => opener), ownerGlobal: t(() => document.ownerGlobal), defaultViewParent: t(() => document.defaultView.parent.document) };
       })()\`, s.sb, "latest", "chrome://browser/content/webaios/spike-reach.js", 1);`,
    );
    note("S6 viewfinder sandbox reach", reach);
    expect(reach).toMatchObject({ Components: "undefined", ChromeUtils: "undefined", Services: "undefined", Cu: "undefined", docShell: "undefined", gBrowser: "undefined", webaiosSiteWindow: "undefined", windowRoot: "undefined", homeSecret: "undefined" });
    for (const k of ["parentDocument", "topDocument", "parentHref", "topHref", "parentSiteWindow", "topGBrowser", "topSiteWindow", "defaultViewParent"]) expect(String((reach as Record<string, string>)[k])).toMatch(/^throws:|^undefined$/);
    expect((reach as Record<string, string>).frameElement).toBe("null");

    const homeKeys0 = await inSiteBar<string[]>(m, ID, `return Object.keys(win.__s6.hwin.wrappedJSObject);`);
    const homePoint = (sel: string) =>
      inSiteBar<{ x: number; y: number }>(
        m,
        ID,
        `const s = win.__s6; const b = win.document.getElementById("webaios-site-bar").getBoundingClientRect(), h = s.home.getBoundingClientRect(), e = s.hdoc.querySelector(arguments[0]).getBoundingClientRect();
         return { x: b.left + h.left + e.left + e.width / 2, y: b.top + h.top + e.top + e.height / 2 };`,
        [sel],
      );
    const state = () => inSiteBar<any>(m, ID, `const s = win.__s6;
      if (Components.utils.isDeadWrapper(s.hdoc) || !s.hdoc.defaultView) return { dead: true, result: s.result, seen: s.seen.slice(), frameConnected: !Components.utils.isDeadWrapper(s.home) && s.home.isConnected };
      const host = s.hdoc.querySelector("webaios-viseur"); const sh = host?.openOrClosedShadowRoot;
      const st = (el) => el && { display: el.style.display, left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height, text: el.textContent };
      return { result: s.result, hosts: s.hdoc.querySelectorAll("webaios-viseur").length, pageShadow: String(host?.wrappedJSObject?.shadowRoot ?? "none"), cadre: st(sh?.children[0]), etiquette: st(sh?.children[1]),
        log: JSON.parse(JSON.stringify(s.hwin.wrappedJSObject.log)), seen: s.seen.slice(), sbGlobals: typeof s.sb.__viseurArret };`);
    await inSiteBar(m, ID, `win.__s6.arm(arguments[0]); return 1;`, [firefoxViewfinderScript()]);
    await expect.poll(async () => (await state()).hosts, { timeout: 5000 }).toBe(1);
    await siteMouse(await homePoint("#nue"), { move: true });
    const hover = await state();
    note("S6 hover", { cadre: hover.cadre, etiquette: hover.etiquette, pageShadow: hover.pageShadow });
    expect(hover.etiquette?.text).toBe("p#nue");
    // Middle and right clicks, then the primary click on #cible.
    await siteMouse(await homePoint("#nue"), { button: 1 });
    await siteMouse(await homePoint("#nue"), { button: 2 });
    expect((await state()).result).toBe("pending");
    await siteMouse(await homePoint("#cible"));
    await expect.poll(async () => (await state()).result !== "pending", { timeout: 5000 }).toBe(true);
    const done = await state();
    const c = cleanCapture(done.result);
    note("S6 capture", { selecteur: c?.selecteur, etiquette: c?.etiquette, rect: c?.rect, vue: c?.vue, adresse: c?.adresse?.replace(/-[0-9a-f]{32}/, "-<token>"), styles: Object.keys(c?.styles ?? {}).length, log: done.log, seen: done.seen });
    expect(c?.selecteur).toBe("#cible");
    expect(done.log.early).toEqual([]);
    expect(done.log.reactions).toEqual([]);
    const homeKeys1 = await inSiteBar<string[]>(m, ID, `return Object.keys(win.__s6.hwin.wrappedJSObject);`);
    expect(homeKeys1.filter((k) => !homeKeys0.includes(k))).toEqual([]);

    // The source, read in the home's own world (Xrays waived), then sourceSaine.
    const raw = await inSiteBar(
      m,
      ID,
      `const s = win.__s6; const world = s.CU.Sandbox(s.hdoc.nodePrincipal, { sandboxPrototype: s.hwin, wantXrays: false, wantComponents: false, sameZoneAs: s.hwin });
       return [arguments[0], arguments[1]].map((code) => { try { return JSON.parse(JSON.stringify(s.CU.evalInSandbox(code, world, "latest", "chrome://browser/content/webaios/webaios-source.js", 1) ?? null)); } catch (e) { return { e: String(e) }; } });`,
      [sourceExpression("#cible"), sourceExpression("#nue")],
    );
    note("S6 source", { raw, kept: (raw as unknown[]).map(cleanSource) });
    expect(cleanSource((raw as unknown[])[0])).toEqual({ fichier: "src/Accueil.svelte", ligne: 7 });
    expect(cleanSource((raw as unknown[])[1])).toBeNull();

    // The capture through the frame's WindowGlobal, a magenta cover in the bar's document over #cible.
    const rc = rectCapture(c!.rect, c!.vue, 1);
    const shot = await inSiteBar(
      m,
      ID,
      `const s = win.__s6; const rc = arguments[0]; ${PIXELS}
       const h = s.home.getBoundingClientRect(), b = win.document.getElementById("webaios-site-bar").getBoundingClientRect();
       const cover = doc.createElement("div");
       cover.style.cssText = "position:fixed;z-index:10;background:rgb(255,0,255);left:" + (h.left + rc.x) + "px;top:" + (h.top + rc.y) + "px;width:" + rc.width + "px;height:" + rc.height + "px";
       doc.body.append(cover);
       await new Promise((r) => win.requestAnimationFrame(() => win.setTimeout(r, 50)));
       const out = {};
       try {
         const bmp = await s.home.browsingContext.currentWindowGlobal.drawSnapshot(new win.DOMRect(rc.x, rc.y, rc.width, rc.height), win.devicePixelRatio, "white", { drawView: true });
         out.frame = { size: [bmp.width, bmp.height], px: pixels(bmp, [[bmp.width / 2, bmp.height / 2], [1, 1]]) };
       } catch (e) { out.frame = { e: String(e) }; }
       const whole = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
       out.window = pixels(whole, [[b.left + h.left + rc.x + rc.width / 2, b.top + h.top + rc.y + rc.height / 2]]);
       out.expected = [Math.round(rc.width * win.devicePixelRatio), Math.round(rc.height * win.devicePixelRatio)];
       cover.remove();
       return out;`,
      [rc],
    );
    note("S6 frame capture", shot);
    const sh = shot as { frame: { px?: string[] }; window: string[] };
    expect(sh.frame.px?.[0]).toBe("0,200,0");
    expect(sh.frame.px?.[1]).toBe("255,255,255");
    expect(sh.window[0]).toBe("255,0,255");

    // « Entrer dans le site » while aiming: a trusted click in the bar (outside the home) reaches its button, and the
    // view's state change is what plan 36 stops the mode on.
    await sleep(600);
    await inSiteBar(
      m,
      ID,
      `const s = win.__s6, stop = arguments[0]; s.states = []; s.seen.length = 0;
       s.offState = win.webaiosSiteWindow.onState((e) => { s.states.push(e.vue); if (e.vue !== "accueil") s.stop(stop); });
       s.arm(arguments[1]); return 1;`,
      [STOP_SCRIPT, firefoxViewfinderScript()],
    );
    await expect.poll(async () => (await state()).hosts, { timeout: 5000 }).toBe(1);
    const enter = await inSiteBar<{ x: number; y: number }>(m, ID, `const b = win.document.getElementById("webaios-site-bar").getBoundingClientRect(), e = doc.querySelector('[data-testid="site-entrer"]').getBoundingClientRect(); return { x: b.left + e.left + e.width / 2, y: b.top + e.top + e.height / 2 };`);
    await siteMouse(enter);
    await expect.poll(vue, { timeout: 5000 }).toBe("site");
    await sleep(300);
    const stopped = await state();
    const states = await inSiteBar(m, ID, `const s = win.__s6; s.offState(); return { states: s.states, stopped: s.stopped, homeShown: win.document.documentElement.hasAttribute("webaios-site-home"),
      homeFrames: doc.querySelectorAll('[data-testid="site-cadre-accueil"]').length };`);
    note("S6 enter the site", { ...(states as object), ...stopped });
    // The click was the bar's: the guard on the home's frame never saw it.
    expect(stopped.seen.filter((x: string) => x.includes(":home:"))).toEqual([]);
    expect(stopped.dead || stopped.hosts === 0).toBe(true);
  });

  it("S7: the overlay in a site app window: bubble and cart under the bar, the bar clickable", async () => {
    await toSite();
    const dims = await m.execute<{ view: number[]; bar: number[]; inner: number[] }>(
      `const win = ${SITE}; const r = (e) => { const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
       return { view: r(${VIEW}), bar: r(win.document.getElementById("webaios-site-bar")), inner: [win.innerWidth, win.innerHeight] };`,
    );
    const [vx, vy, vw, vh] = dims.view;
    const [l, h] = dims.inner;
    const barBottom = dims.bar[1]! + dims.bar[3]!;
    const bornes = { x: vx!, y: vy!, width: vw!, height: vh! };
    // The bubble of an element at the top of the page, and one of an element below a short window (placeBulle clamps up).
    const top = placeBulle({ x: 10, y: 0, largeur: 50, hauteur: 10 }, 1, bornes, [l!, h!], { hautMin: vy! });
    const clamped = placeBulle({ x: 10, y: 5000, largeur: 50, hauteur: 10 }, 1, bornes, [l!, 180], { hautMin: vy! });
    const unclamped = placeBulle({ x: 10, y: 5000, largeur: 50, hauteur: 10 }, 1, bornes, [l!, 180]);
    const cart = { x: Math.max(0, l! - MARGE - LARGEUR_PANIER), y: barBottom + 12, width: Math.min(LARGEUR_PANIER, l!), height: Math.max(0, h! - barBottom - 12 - MARGE) };
    note("S7 places", { dims, top, clamped, unclamped, cart });
    expect(clamped.y).toBeGreaterThanOrEqual(barBottom);

    // The real overlay page (sidebar.html?calque, DesignApp) in the site window, on an ApiCalque the chrome sets.
    const show = (mode: "bulle" | "panier", place: { x: number; y: number; width: number; height: number }) =>
      m.execute(
        `return (async ([mode, p]) => {
           const win = ${SITE}, doc = win.document;
           doc.getElementById("spike-calque")?.remove();
           const f = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
           f.id = "spike-calque";
           f.style.cssText = "position: fixed; z-index: 3; border: 0; background: transparent; left:" + p.x + "px; top:" + p.y + "px; width:" + p.width + "px; height:" + p.height + "px";
           doc.getElementById("browser").append(f);
           const ctx = { mode, message: null, projet: "site-vidola", etiquette: "input#email.champ", source: null, destination: null, sansDestination: null, avertissement: mode === "bulle" ? "Capture d'un site tiers" : null };
           f.webaiosOverlay = { api: { contexte: async () => ctx, ajouter: async () => ({ ok: true }), annuler: () => {}, panier: async () => [], lots: async () => [], retirer: async () => {}, traite: async () => {}, envoyer: async () => ({ ok: true }), surChange: () => () => {} } };
           f.src = "chrome://browser/content/webaios/sidebar.html?calque";
           for (let i = 0; i < 100 && !(f.contentDocument?.readyState === "complete" && f.contentDocument.body?.textContent.trim()); i++) await new Promise((r) => setTimeout(r, 50));
           return { uri: f.contentDocument?.documentURI, text: f.contentDocument?.body?.textContent.trim().slice(0, 60) };
         })(arguments);`,
        [mode, place],
      );
    /** Hit tests and a trusted click on the bar above the frame; what the bar's document and the page received. */
    const check = (place: { x: number; y: number; width: number; height: number }) =>
      m.execute(
        `return (async ([p]) => {
           const win = ${SITE}, doc = win.document, bar = doc.getElementById("webaios-site-bar"), bdoc = bar.contentDocument;
           const hit = (x, y) => { const e = doc.elementFromPoint(x, y); return e ? e.localName + (e.id ? "#" + e.id : "") : null; };
           const got = [];
           const l = (e) => got.push(e.type + ":" + e.isTrusted + "@" + Math.round(e.clientX) + "," + Math.round(e.clientY));
           bdoc.addEventListener("mousedown", l, true);
           const cx = p.x + p.width / 2, b = bar.getBoundingClientRect(), by = b.top + b.height / 2;
           win.synthesizeMouseEvent("mousedown", cx, by, { button: 0, clickCount: 1 });
           win.synthesizeMouseEvent("mouseup", cx, by, { button: 0, clickCount: 1 });
           await new Promise((r) => setTimeout(r, 50));
           bdoc.removeEventListener("mousedown", l, true);
           const whole = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
           return { frame: doc.getElementById("spike-calque").getBoundingClientRect().toJSON(), barRect: b.toJSON(),
             hits: { frameCentre: hit(cx, p.y + p.height / 2), barAboveFrame: hit(cx, by), barLeft: hit(10, by), barRight: hit(win.innerWidth - 10, by), viewBeside: hit(5, p.y + 20) },
             barGot: got, shot: [whole.width, whole.height] };
         })(arguments);`,
        [place],
      );
    const shotAt = (pts: number[][]) =>
      m.execute<string[]>(`return (async (pts) => { const win = ${SITE}; ${PIXELS} return pixels(await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white"), pts); })(arguments[0]);`, [pts]);
    const by = dims.bar[1]! + dims.bar[3]! / 2;

    const before = await shotAt([[top.x + top.width / 2, top.y + 30], [top.x + top.width / 2, by]]);
    const bubble = await show("bulle", top);
    const bubbleCheck = await check(top);
    const afterBubble = await shotAt([[top.x + top.width / 2, top.y + 30], [top.x + top.width / 2, by]]);
    note("S7 bubble", { loaded: bubble, ...(bubbleCheck as object), paint: { before, after: afterBubble } });
    const bc = bubbleCheck as { frame: { top: number }; hits: Record<string, string>; barGot: string[] };
    expect(bc.frame.top).toBeGreaterThanOrEqual(barBottom);
    expect(bc.hits.frameCentre).toBe("iframe#spike-calque");
    expect(bc.hits.barAboveFrame).toBe("iframe#webaios-site-bar");
    expect(bc.barGot.length).toBe(1);
    expect(afterBubble[1]).toBe(before[1]);

    const panier = await show("panier", cart);
    const cartCheck = await check(cart);
    note("S7 cart", { loaded: panier, ...(cartCheck as object) });
    const cc = cartCheck as typeof bc;
    expect(cc.frame.top).toBeGreaterThanOrEqual(barBottom);
    expect(cc.hits.barAboveFrame).toBe("iframe#webaios-site-bar");
    expect(cc.hits.barRight).toBe("iframe#webaios-site-bar");
    expect(cc.barGot.length).toBe(1);

    // On the home, the bar's document covers the window (position fixed, z-index 3): the overlay must still be on top.
    await inStore(`store.sites.controller(arguments[0]).home();`, [ID]);
    await expect.poll(() => m.execute(`return ${SITE}.document.documentElement.hasAttribute("webaios-site-home");`)).toBe(true);
    const homeRect = await inSiteBar<number[]>(m, ID, `const b = win.document.getElementById("webaios-site-bar").getBoundingClientRect(), h = doc.querySelector('[data-testid="site-cadre-accueil"]').getBoundingClientRect(); return [b.left + h.left, b.top + h.top, h.width, h.height];`);
    const onHome = placeBulle({ x: 40, y: 60, largeur: 120, hauteur: 40 }, 1, { x: homeRect[0]!, y: homeRect[1]!, width: homeRect[2]!, height: homeRect[3]! }, [l!, h!], { hautMin: homeRect[1]! });
    await show("bulle", onHome);
    const homeCheck = await check(onHome);
    note("S7 bubble over the home", { homeRect, onHome, ...(homeCheck as object) });
    const hc = homeCheck as typeof bc;
    expect(hc.hits.frameCentre).toBe("iframe#spike-calque");
    expect(hc.hits.barAboveFrame).toBe("iframe#webaios-site-bar");
    expect(hc.barGot.length).toBe(1);
    await m.execute(`${SITE}.document.getElementById("spike-calque")?.remove();`);
  });
});
