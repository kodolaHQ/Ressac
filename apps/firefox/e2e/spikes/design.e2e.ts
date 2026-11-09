import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rectCapture, viewfinderScript } from "../../core/design/viewfinder";
import { dispatch, state, waitFor, waitReady } from "../firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "../launch";
import type { Marionette } from "../marionette";
import { pressKeys } from "../ui";

// Plan 35's spikes S1–S4 (docs/superpowers/notes/2026-11-06-mode-design-firefox-spikes.md): the viewfinder in an
// Xray sandbox of a runtime-registered actor, drawSnapshot, a chrome overlay frame, the source read. No build:ui: the
// actor and the overlay page are served from resource://webaios-spike-design/ (this folder). Security lines are
// asserted; the rest is printed as `[spike] <what>: <JSON>`. Rerun with WEBAIOS_SPIKE=1 after a Firefox version change.

const note = (what: string, v: unknown) => console.log(`[spike] ${what}: ${JSON.stringify(v)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chrome = <T = any>(m: Marionette, body: string, args: unknown[] = []) => m.execute<T>(`return (async () => { ${body} })();`, args);

const DESIGN = readFileSync(path.resolve(import.meta.dirname, "../pages/design.html"), "utf8");
const html = (body: string, head = "") => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

/** design.html, with a page that listens first (window, capture), hooks the prototypes and fakes the viewfinder's stop. */
const HOOKS = DESIGN.replace(
  "<head>",
  `<head><script>
  window.early = []; window.hooked = []; window.fakeStop = 0;
  for (const t of ["pointerdown", "mousedown", "mouseup", "click", "auxclick", "contextmenu", "dblclick"])
    window.addEventListener(t, (e) => early.push(t + ":" + e.isTrusted), true);
  window.docEarly = []; window.moves = { pointermove: 0, mousemove: 0 }; window.keysEarly = [];
  for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "contextmenu", "dblclick"]) {
    document.addEventListener(t, (e) => docEarly.push(t + ":capture:" + e.isTrusted), true);
    document.addEventListener(t, (e) => docEarly.push(t + ":bubble:" + e.isTrusted));
  }
  for (const t of ["pointermove", "mousemove"]) window.addEventListener(t, (e) => e.isTrusted && moves[t]++, true);
  window.addEventListener("keydown", (e) => keysEarly.push(e.key + ":" + e.isTrusted), true);
  const hook = (o, k) => { const f = o[k]; o[k] = function (...a) { hooked.push(k); return f.apply(this, a); }; };
  hook(Element.prototype, "attachShadow"); hook(Document.prototype, "createElement"); hook(EventTarget.prototype, "addEventListener");
  hook(window, "getComputedStyle"); hook(Element.prototype, "getBoundingClientRect"); hook(CSS, "escape"); hook(Document.prototype, "querySelectorAll");
  const then = Promise.prototype.then; Promise.prototype.then = function (...a) { hooked.push("then"); return then.apply(this, a); };
  window.__viseurArret = () => fakeStop++; window.__viseurAvaler = () => fakeStop++;
  addEventListener("load", () => (hooked.length = 0));
</script>`,
);
/** 20 × 40 cells of 100 px: the colour of a pixel gives its cell, rgb(col × 10, row × 5, 77). */
const GRID = html(
  Array.from({ length: 40 }, (_, row) => `<div style="display:flex">${Array.from({ length: 20 }, (_, col) => `<div style="flex:none;width:100px;height:100px;background:rgb(${col * 10},${row * 5},77)"></div>`).join("")}</div>`).join(""),
  "<style>body{margin:0;width:2000px}</style>",
);
/** A green 80 × 30 target at (300, 900) on a white page 3000 px high. */
const TARGET = html('<div id="cible" style="position:absolute;left:300px;top:900px;width:80px;height:30px;background:rgb(0,200,0)"></div>', "<style>body{margin:0;height:3000px;background:#fff}</style>");
/** The overlay's document (S3): transparent, one opaque box (the "bubble", 200 × 56) with a textarea. */
const OVERLAY = '<head><style>html, body { margin: 0; background: transparent; } #bulle { width: 200px; height: 56px; background: rgb(109, 94, 252); } textarea { width: 180px; height: 30px; }</style></head><body><div id="bulle"><textarea id="t"></textarea></div></body>';
/** design.html with a same-origin frame holding a button (S1 fix, (b)). */
const FRAMED = DESIGN.replace("</body>", '<iframe id="cadre" style="width:300px;height:100px" srcdoc="<button id=dans>dans</button><script>window.vu = []; for (const t of [\'mousedown\', \'click\']) addEventListener(t, (e) => vu.push(t + \':\' + e.isTrusted), true)</script>"></iframe></body>');
/**
 * The viewfinder script with the S1 fix: no click listener of its own; the actor's guard hands it the clicked element
 * (`__viseurChoisir`). Everything else (hover, Escape, swallowing, stop) is unchanged.
 */
function guardedScript(): string {
  let s = viewfinderScript();
  const edits: [string, string][] = [
    ['      window.removeEventListener("click", surClic, true);\n', ""],
    ["if (globalThis.__viseurArret === arret) delete globalThis.__viseurArret;", "if (globalThis.__viseurArret === arret) { delete globalThis.__viseurArret; delete globalThis.__viseurChoisir; }"],
    ["const surClic = (e) => {\n      if (!e.isTrusted) return;\n      bloque(e);\n      const el = e.target;", "const choisir = (el) => {"],
    ['window.addEventListener("click", surClic, true);', "globalThis.__viseurChoisir = choisir;"],
  ];
  for (const [a, b] of edits) {
    if (!s.includes(a)) throw new Error(`scriptViseur changed: ${a}`);
    s = s.replace(a, b);
  }
  return s;
}
const CSP = "default-src 'none'; script-src 'nonce-essai'; style-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'";

/** A Svelte 5 component compiled in dev mode (what a demo of the agent serves through Vite), built with this repo's Vite. */
async function buildSvelte(dir: string): Promise<string> {
  const { build } = await import("vite");
  const { svelte } = await import("@sveltejs/vite-plugin-svelte");
  const root = path.join(dir, "svelte-src");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "index.html"), '<!doctype html><meta charset="utf-8"><title>svelte</title><div id="app"></div><script type="module" src="/src/main.js"></script>');
  await writeFile(path.join(root, "src/main.js"), 'import { mount } from "svelte"; import Essai from "./Essai.svelte"; mount(Essai, { target: document.getElementById("app") });');
  await writeFile(path.join(root, "src/Essai.svelte"), '<script>\n  let n = $state(0);\n</script>\n\n<section>\n  <button id="plus" onclick={() => n++}>{n}</button>\n</section>\n');
  const out = path.join(dir, "svelte-out");
  await build({ root, configFile: false, mode: "development", base: "/svelte/", logLevel: "silent", plugins: [svelte({ configFile: false, compilerOptions: { dev: true } })], build: { outDir: out, minify: false } });
  return out;
}

describe.skipIf(!process.env.WEBAIOS_SPIKE)("design mode spikes (plan 35)", () => {
  let server: Server;
  let base: string;
  let svelteOut: string;
  let tmp: string;
  let w: LaunchedWebAiOs;
  let m: Marionette;

  beforeAll(async () => {
    // Under node_modules (ignored by git): the component's `svelte` import resolves to this package's Svelte.
    const cache = path.resolve(import.meta.dirname, "../../node_modules/.cache");
    await mkdir(cache, { recursive: true });
    tmp = await mkdtemp(path.join(cache, "webaios-design-spike-"));
    svelteOut = await buildSvelte(tmp);
    server = createServer(async (req, res) => {
      const route = new URL(req.url ?? "/", "http://x").pathname;
      const send = (body: string, headers: Record<string, string> = {}) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers }).end(body);
      if (route === "/" || route === "/x") return send(DESIGN);
      if (route === "/autre") return send("<title>Autre</title>autre");
      if (route === "/hooks") return send(HOOKS);
      if (route === "/cadre") return send(FRAMED);
      if (route === "/csp") return send('<title>CSP</title><button id="b">ok</button>', { "Content-Security-Policy": CSP });
      if (route === "/grille") return send(GRID);
      if (route === "/cible") return send(TARGET);
      if (route.startsWith("/svelte/")) {
        const file = path.join(svelteOut, route.slice("/svelte/".length) || "index.html");
        if (!file.startsWith(svelteOut)) return res.writeHead(404).end();
        const body = await readFile(file).catch(() => null);
        if (!body) return res.writeHead(404).end();
        return res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" }).end(body);
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The content sandbox reads this folder only (test pref, as agent-extensions.ts testActor): the actor's module.
    w = await launchWebAiOs({
      prefs: {
        "security.sandbox.content.mac.testing_read_path1": realpathSync(import.meta.dirname) + "/",
        // WEBAIOS_SPIKE_DPR=2: a Retina-like density for S2 (headless is 1 otherwise).
        ...(process.env.WEBAIOS_SPIKE_DPR ? { "layout.css.devPixelsPerPx": process.env.WEBAIOS_SPIKE_DPR } : {}),
      },
    });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    const registered = await chrome(
      m,
      `const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
       const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
       res.setSubstitution("webaios-spike-design", Services.io.newFileURI(new FileUtils.File(arguments[0])));
       const uri = "resource://webaios-spike-design/design-actor.sys.mjs";
       ChromeUtils.registerWindowActor("WebAiOsSpikeDesign", { parent: { esModuleURI: uri }, child: { esModuleURI: uri }, matches: ["http://*/*"], messageManagerGroups: ["browsers"], safeForUntrustedWebProcess: true });
       return "ok";`,
      [import.meta.dirname],
    );
    note("register", registered);
  }, 120_000);
  afterAll(async () => {
    await w?.close();
    if (server) await new Promise((ok) => (server.closeAllConnections(), server.close(ok)));
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  const ACTOR = `gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor("WebAiOsSpikeDesign")`;
  const ask = <T = any>(name: string, data: unknown = {}) => chrome<T>(m, `return ${ACTOR}.sendQuery(arguments[0], arguments[1]);`, [name, data]);
  const inPage = <T = any>(code: string) => ask<T>("page", { code });
  const probe = <T = any>(code: string) => ask<T>("probe", { code });
  /** Arms the viewfinder; `result()` waits for its answer ({ r } or { e } when the query is rejected). */
  const arm = () => chrome(m, `window.__spikeArm = ${ACTOR}.sendQuery("arm", { code: arguments[0] }).then((r) => ({ r }), (e) => ({ e: String(e) })); return true;`, [viewfinderScript()]);
  const result = () => chrome<{ r?: any; e?: string }>(m, "return window.__spikeArm;");
  /** The S1 fix: armed with the guard on the chrome event handler. */
  const armG = () => chrome(m, `window.__spikeArm = ${ACTOR}.sendQuery("armGuarded", { code: arguments[0] }).then((r) => ({ r }), (e) => ({ e: String(e) })); return true;`, [guardedScript()]);
  const resultIn = (ms: number) => Promise.race([result(), sleep(ms).then(() => "pending" as const)]);

  async function open(url: string) {
    await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url });
    await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`, (v) => v === true);
    await chrome(m, "gBrowser.selectedBrowser.focus();");
  }

  /** A trusted mouse gesture sent from the parent's window over the page (as a person's): chrome coordinates. */
  async function mouse(selector: string, o: { button?: 0 | 1 | 2; count?: number; move?: boolean } = {}) {
    const c = await probe<{ x: number; y: number }>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await chrome(
      m,
      `const [c, button, count, move] = arguments;
       const b = gBrowser.selectedBrowser, br = b.getBoundingClientRect(), z = b.fullZoom;
       const x = br.left + c.x * z, y = br.top + c.y * z, u = window.windowUtils;
       window.synthesizeMouseEvent("mousemove", x, y, { button: 0, clickCount: 0 });
       await new Promise((r) => setTimeout(r, 50));
       if (move) return;
       for (let i = 1; i <= count; i++) { window.synthesizeMouseEvent("mousedown", x, y, { button, clickCount: i }); window.synthesizeMouseEvent("mouseup", x, y, { button, clickCount: i }); }
       if (button === 2) window.synthesizeMouseEvent("contextmenu", x, y, { button: 2, clickCount: 1 });`,
      [c, o.button ?? 0, o.count ?? 1, o.move ?? false],
    );
  }

  // --- S1, the viewfinder ---------------------------------------------------------------------------------------

  it("S1: process, hover frame, click captured and swallowed", async () => {
    await open(`${base}/`);
    const info = await ask("info");
    note("S1 info", info);
    expect(info.remoteType).toMatch(/^webIsolated=/);
    const keys = await inPage<string[]>("Object.keys(window).sort()");
    await arm();
    await sleep(100);
    expect(await ask("hosts")).toBe(1);
    await mouse("#email", { move: true });
    const frame = await ask("frame");
    note("S1 hover frame", frame);
    expect(frame.cadre.display).toBe("block");
    expect(frame.etiquette.text).toBe("input#email.champ");
    // What the page sees of the host: no shadow root.
    expect(await inPage("document.querySelector('webaios-viseur').shadowRoot")).toBeNull();
    await mouse("#envoyer");
    const c = await result();
    note("S1 capture #envoyer", { ...c.r, html: c.r?.html?.slice(0, 60), styles: Object.keys(c.r?.styles ?? {}).length });
    expect(c.r?.selecteur).toBe("#envoyer");
    expect(c.r?.html.startsWith("<button")).toBe(true);
    expect(c.r?.adresse).toBe(`${base}/`);
    expect(await inPage("window.reactions")).toEqual([]);
    expect(await ask("hosts")).toBe(0);
    expect(await inPage("Object.keys(window).sort()")).toEqual(keys);
    // The link: the tab stays.
    await sleep(600);
    await arm();
    await sleep(100);
    await mouse("#lien");
    expect((await result()).r?.selecteur).toBe("#lien");
    await sleep(500);
    expect(await inPage("location.href")).toBe(`${base}/`);
    expect(await inPage("window.reactions")).toEqual([]);
    // No id: a selector that designates the clicked element only.
    await sleep(600);
    await arm();
    await sleep(100);
    await mouse("li:nth-child(2)");
    const li = (await result()).r;
    note("S1 li", { selecteur: li?.selecteur, freres: li?.voisinage?.freres });
    expect(await inPage(`(() => { const l = document.querySelectorAll(${JSON.stringify(li?.selecteur)}); return l.length === 1 && l[0].textContent === "deux"; })()`)).toBe(true);
  });

  it("S1: middle click, right click and double click never reach the page", async () => {
    await open(`${base}/`);
    const tabs = await chrome(m, "return gBrowser.tabs.length;");
    await arm();
    await sleep(100);
    await mouse("#lien", { button: 1 });
    await mouse("#lien", { button: 2 });
    await sleep(300);
    const after = { reactions: await inPage("window.reactions"), href: await inPage("location.href"), tabs: (await chrome(m, "return gBrowser.tabs.length;")) - tabs };
    note("S1 middle+right", after);
    expect(after.reactions).toEqual([]);
    expect(after.href).toBe(`${base}/`);
    expect(after.tabs).toBe(0);
    await mouse("#envoyer", { count: 2 });
    expect((await result()).r?.selecteur).toBe("#envoyer");
    await sleep(300);
    expect(await inPage("window.reactions")).toEqual([]);
  });

  it("S1: a click or an Escape made by the page does not count", async () => {
    await open(`${base}/`);
    await arm();
    await sleep(100);
    await inPage(`document.querySelector("li").click(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); document.dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await sleep(300);
    expect(await ask("hosts")).toBe(1);
    await mouse("#email");
    expect((await result()).r?.selecteur).toBe("#email");
  });

  it("S1: Escape (trusted key) ends with null, nothing left in the DOM nor in the page's globals", async () => {
    await open(`${base}/`);
    const keys = await inPage<string[]>("Object.keys(window).sort()");
    await arm();
    await sleep(100);
    await pressKeys(m, "Escape");
    const r = await Promise.race([result(), sleep(3000).then(() => "no answer in 3 s")]);
    note("S1 Escape", r);
    expect(r).toEqual({ r: null });
    expect(await ask("hosts")).toBe(0);
    expect(await inPage("Object.keys(window).sort()")).toEqual(keys);
    expect(await inPage("[typeof window.__viseurArret, typeof window.__viseurAvaler]")).toEqual(["undefined", "undefined"]);
    // The parent's stop (ARRET) also ends it with null.
    await arm();
    await sleep(100);
    await ask("stop");
    expect(await result()).toEqual({ r: null });
    expect(await ask("hosts")).toBe(0);
    expect(await inPage("Object.keys(window).sort()")).toEqual(keys);
  });

  it("S1: what the viewfinder's sandbox sees (no chrome)", async () => {
    await open(`${base}/`);
    const seen = await probe(`({ Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services, Cu: typeof Cu,
      docShell: typeof window.docShell, browsingContext: typeof window.browsingContext, gBrowser: typeof gBrowser, windowUtils: typeof window.windowUtils,
      top: window.top === window, parent: window.parent === window, frameElement: window.frameElement, origin: location.origin,
      pageGlobal: typeof window.reactions, wrapped: typeof window.wrappedJSObject })`);
    note("S1 sandbox sees", seen);
    for (const k of ["Components", "ChromeUtils", "Services", "Cu", "docShell", "browsingContext", "gBrowser", "windowUtils"]) expect(seen[k]).toBe("undefined");
    expect(seen.top).toBe(true);
    expect(seen.pageGlobal).toBe("undefined");
  });

  it("S1 (unguarded): a hostile page sees no hook nor fake stop, but its early window listener sees the click", async () => {
    await open(`${base}/hooks`);
    await sleep(200);
    await inPage("window.hooked.length = 0; window.early.length = 0");
    await chrome(m, `${ACTOR}.sendQuery("front");`);
    await arm();
    await sleep(100);
    await mouse("#email", { move: true });
    await mouse("#envoyer");
    const c = await result();
    const seen = { selecteur: c.r?.selecteur, hooked: await inPage("window.hooked"), early: await inPage("window.early"), reactions: await inPage("window.reactions"), fakeStop: await inPage("window.fakeStop"), front: await ask("front") };
    note("S1 hostile page", seen);
    expect(seen.selecteur).toBe("#envoyer");
    expect(seen.hooked).toEqual([]);
    expect(seen.fakeStop).toBe(0);
    expect(seen.reactions).toEqual([]);
    // The hole of the script as is: a page listener on window (capture) registered before the viewfinder's sees
    // the person's click. Asserted as measured, so a change shows; the "S1 fix" probes below close it.
    note("S1 early window-capture listener saw", seen.early);
    expect(seen.early).toEqual(["pointerdown:true", "click:true"]);
  });

  it("S1: same-document navigation stops (and the parent re-arms); a reload answers null", async () => {
    await open(`${base}/`);
    await chrome(
      m,
      `window.__spikeLoc = [];
       gBrowser.addProgressListener(window.__spikeListener = { QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
         onLocationChange(wp, req, loc, flags) { if (wp.isTopLevel) window.__spikeLoc.push({ spec: loc.spec, same: !!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT), reload: !!(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_RELOAD) }); } });`,
    );
    await arm();
    await sleep(100);
    await inPage(`history.pushState({}, "", "/x")`);
    const loc = await waitFor<any[]>(m, "return window.__spikeLoc;", (v) => v.length > 0);
    note("S1 pushState onLocationChange", loc);
    expect(loc[0].same).toBe(true);
    // The parent's reaction: stop (null), then re-arm on the same document.
    await ask("stop");
    expect(await result()).toEqual({ r: null });
    await arm();
    await sleep(100);
    await mouse("#email");
    expect((await result()).r?.selecteur).toBe("#email");
    // After the capture's 500 ms swallow, clicks reach the page again.
    await sleep(600);
    await mouse("#email");
    await sleep(200);
    expect(await inPage("window.reactions")).toContain("click:email");
    // Reload while armed: the query is rejected when the window global goes.
    await chrome(m, "window.__spikeLoc.length = 0;");
    await arm();
    await sleep(100);
    const t0 = Date.now();
    await chrome(m, "gBrowser.selectedBrowser.reload();");
    const r = await result();
    note("S1 reload", { r, ms: Date.now() - t0, loc: await chrome(m, "return window.__spikeLoc;") });
    expect(r.r ?? null).toBeNull();
    await chrome(m, "gBrowser.removeProgressListener(window.__spikeListener);");
  });

  it("S1: the /csp page (strict CSP, Trusted Types)", async () => {
    await open(`${base}/csp`);
    await arm();
    await sleep(100);
    expect(await ask("hosts")).toBe(1);
    await mouse("#b", { move: true });
    const frame = await ask("frame");
    await mouse("#b");
    const c = await result();
    note("S1 csp", { frame, selecteur: c.r?.selecteur, e: c.e, styles: Object.keys(c.r?.styles ?? {}).length });
    expect(frame?.cadre.display).toBe("block");
    expect(c.r?.selecteur).toBe("#b");
    expect(await ask("hosts")).toBe(0);
  });

  // --- S1 fix, the chromeEventHandler guard --------------------------------------------------------------------

  const PAGE_SAW = "({ early: window.early.slice(), docEarly: window.docEarly.slice(), reactions: window.reactions.slice(), moves: { ...window.moves }, keysEarly: window.keysEarly.slice() })";
  const clearPage = () => inPage("early.length = 0; docEarly.length = 0; reactions.length = 0; keysEarly.length = 0; moves.pointermove = 0; moves.mousemove = 0;");

  it("S1 fix (a, c): the hostile page sees no click of any kind, in any phase; hover still frames", async () => {
    await open(`${base}/hooks`);
    await sleep(200);
    const listeners0 = await ask("listeners");
    await clearPage();
    await armG();
    await sleep(100);
    const armedListeners = await ask("listeners");
    await mouse("#email", { move: true });
    const frame = await ask("frame");
    const tabs = await chrome(m, "return gBrowser.tabs.length;");
    await mouse("#lien", { button: 1 });
    await mouse("#lien", { button: 2 });
    await sleep(200);
    const midRight = await inPage(PAGE_SAW);
    await mouse("#envoyer", { count: 2 });
    const c = await result();
    await sleep(300);
    const seen = { selecteur: c.r?.selecteur, frame: frame?.cadre.display, label: frame?.etiquette.text, page: await inPage(PAGE_SAW), midRight, newTabs: (await chrome(m, "return gBrowser.tabs.length;")) - tabs, href: await inPage("location.href"), guard: await ask("guardSeen"), hooked: await inPage("window.hooked"), listeners0, armedListeners };
    note("S1 fix hostile page", seen);
    expect(seen.selecteur).toBe("#envoyer");
    expect(seen.frame).toBe("block");
    expect(seen.label).toBe("input#email.champ");
    for (const p of [seen.midRight, seen.page]) {
      expect(p.early).toEqual([]);
      expect(p.docEarly).toEqual([]);
      expect(p.reactions).toEqual([]);
    }
    expect(seen.newTabs).toBe(0);
    expect(seen.href).toBe(`${base}/hooks`);
    expect(seen.hooked).toEqual([]);
  });

  it("S1 fix (d, g): page-made events ignored; keys reach the page except Escape, which stops", async () => {
    await open(`${base}/hooks`);
    await sleep(200);
    await clearPage();
    await armG();
    await sleep(100);
    await inPage(`document.querySelector("li").click(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); document.querySelector("#envoyer").dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await sleep(200);
    const untrusted = { hosts: await ask("hosts"), pending: await resultIn(100), page: await inPage(PAGE_SAW) };
    note("S1 fix untrusted", untrusted);
    expect(untrusted.hosts).toBe(1);
    expect(untrusted.pending).toBe("pending");
    // The page's own untrusted events reach its own listeners (nothing to hide from it).
    expect(untrusted.page.early).toEqual(["click:false", "click:false"]);
    await pressKeys(m, "a");
    await sleep(100);
    await pressKeys(m, "Escape");
    const r = await resultIn(3000);
    const keys = { r, page: await inPage("window.keysEarly.slice()"), hosts: await ask("hosts") };
    note("S1 fix keyboard", keys);
    // surTouche only takes a trusted Escape; other keys go to the page.
    expect(keys.page).toEqual(["Escape:false", "a:true"]);
    expect(r).toEqual({ r: null });
    expect(keys.hosts).toBe(0);
  });

  it("S1 fix (e): after a capture, a stop or a reload the page gets clicks again and no guard listener is left", async () => {
    await open(`${base}/hooks`);
    await sleep(200);
    const before = await ask("listeners");
    const out: Record<string, unknown> = { before };
    // After a capture: guard kept 500 ms (rest of a double click), then gone.
    await armG();
    await sleep(100);
    await mouse("#email");
    expect((await result()).r?.selecteur).toBe("#email");
    out.just = await ask("listeners");
    await sleep(600);
    out.afterCapture = await ask("listeners");
    await clearPage();
    await mouse("#email");
    await sleep(200);
    out.pageAfterCapture = await inPage(PAGE_SAW);
    // After the parent's stop.
    await armG();
    await sleep(100);
    await ask("stop");
    expect(await result()).toEqual({ r: null });
    out.afterStop = await ask("listeners");
    // A reload while armed: the old actor goes (didDestroy), the new page gets its clicks.
    await armG();
    await sleep(100);
    await chrome(m, "gBrowser.selectedBrowser.reload();");
    out.reload = await result();
    await waitFor(m, "return !gBrowser.selectedBrowser.webProgress.isLoadingDocument", (v) => v === true);
    await sleep(300);
    out.afterReload = await ask("listeners");
    await mouse("#email");
    await sleep(200);
    out.pageAfterReload = await inPage(PAGE_SAW);
    note("S1 fix cleanup", out);
    for (const k of ["afterCapture", "afterStop", "afterReload"]) expect(out[k]).toEqual(before);
    expect((out.just as any).guarded).toBe((before as any).guarded + 9);
    for (const k of ["pageAfterCapture", "pageAfterReload"]) {
      expect((out[k] as any).early).toContain("click:true");
      expect((out[k] as any).reactions).toContain("click:email");
    }
  });

  it("S1 fix (f): arming in one tab leaves another tab alone", async () => {
    await open(`${base}/hooks`);
    await sleep(200);
    const tabA = await chrome(m, "window.__spikeTabA = gBrowser.selectedTab; return gBrowser.tabs.indexOf(gBrowser.selectedTab);");
    await armG();
    await sleep(100);
    await open(`${base}/hooks`);
    await sleep(200);
    await clearPage();
    await mouse("#email");
    await sleep(200);
    const b = { page: await inPage(PAGE_SAW), hosts: await ask("hosts"), listeners: await ask("listeners"), process: (await ask("info")).remoteType };
    await chrome(m, "gBrowser.selectedTab = window.__spikeTabA;");
    await waitFor(m, "return gBrowser.selectedTab === window.__spikeTabA;", (v) => v === true);
    await sleep(200);
    const a = { hosts: await ask("hosts"), process: (await ask("info")).remoteType };
    await mouse("#envoyer");
    const r = await result();
    note("S1 fix two tabs", { tabA, b, a, selecteur: r.r?.selecteur });
    expect(b.page.reactions).toContain("click:email");
    expect(b.hosts).toBe(0);
    expect(a.hosts).toBe(1);
    expect(r.r?.selecteur).toBe("#envoyer");
  });

  it("S1 fix (b): a click in a same-origin frame", async () => {
    await open(`${base}/cadre`);
    await waitFor(m, `return ${ACTOR}.sendQuery("probe", { code: "!!document.querySelector('#cadre').contentDocument?.querySelector('#dans')" });`, (v) => v === true);
    await armG();
    await sleep(100);
    const c = await chrome(
      m,
      `const b = gBrowser.selectedBrowser, br = b.getBoundingClientRect();
       const r = await b.browsingContext.currentWindowGlobal.getActor("WebAiOsSpikeDesign").sendQuery("probe", { code: "(() => { const f = document.querySelector('#cadre').getBoundingClientRect(), d = document.querySelector('#cadre').contentDocument.querySelector('#dans').getBoundingClientRect(); return { x: f.x + d.x + d.width / 2, y: f.y + d.y + d.height / 2 }; })()" });
       const x = br.left + r.x, y = br.top + r.y;
       for (const t of ["mousedown", "mouseup"]) window.synthesizeMouseEvent(t, x, y, { button: 0, clickCount: 1 });
       return r;`,
    );
    await sleep(300);
    const seen = { at: c, result: await resultIn(300), guard: await ask("guardSeen"), frame: await inPage("document.querySelector('#cadre').contentWindow.vu"), sameProcess: await inPage("!!document.querySelector('#cadre').contentDocument") };
    note("S1 fix same-origin frame", seen);
    await ask("stop");
  });

  // --- S2, the capture -------------------------------------------------------------------------------------------

  /** drawSnapshot of the selected tab's top window, encoded as a PNG by a chrome canvas; samples pixels of the bitmap. */
  const snapshot = (rect: { x: number; y: number; width: number; height: number }, scale: number, o: { drawView?: boolean; samples?: [number, number][] } = {}) =>
    chrome<{ width: number; height: number; png: { width: number; height: number; bytes: number }; samples: number[][] }>(
      m,
      `const [r, scale, opts, samples] = arguments;
       const wg = gBrowser.selectedBrowser.browsingContext.currentWindowGlobal;
       const bmp = await wg.drawSnapshot(new DOMRect(r.x, r.y, r.width, r.height), scale, "white", opts);
       const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
       canvas.width = bmp.width; canvas.height = bmp.height;
       const ctx = canvas.getContext("2d");
       ctx.drawImage(bmp, 0, 0);
       const url = canvas.toDataURL("image/png");
       const bin = atob(url.slice(url.indexOf(",") + 1));
       const be = (i) => ((bin.charCodeAt(i) << 24) | (bin.charCodeAt(i + 1) << 16) | (bin.charCodeAt(i + 2) << 8) | bin.charCodeAt(i + 3)) >>> 0;
       return { width: bmp.width, height: bmp.height, png: { width: be(16), height: be(20), bytes: bin.length },
         samples: samples.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3)) };`,
      [rect, scale, { drawView: o.drawView ?? false }, o.samples ?? [[0, 0]]],
    );
  const cell = (rgb: number[]) => ({ col: Math.round(rgb[0]! / 10), row: Math.round(rgb[1]! / 5) });

  it("S2: rect origin (page or view), scroll and zoom", async () => {
    await open(`${base}/grille`);
    const dpr = await chrome<number>(m, "return window.devicePixelRatio;");
    await inPage("scrollTo(250, 330)");
    await sleep(200);
    const page = await snapshot({ x: 0, y: 0, width: 100, height: 100 }, 1);
    const view = await snapshot({ x: 0, y: 0, width: 100, height: 100 }, 1, { drawView: true });
    note("S2 scrolled 250,330: rect (0,0) gives cell", { dpr, page: cell(page.samples[0]!), view: cell(view.samples[0]!) });
    const scaled = await snapshot({ x: 0, y: 0, width: 100, height: 50 }, 2);
    note("S2 scale 2", { bitmap: [scaled.width, scaled.height], png: scaled.png });
    await chrome(m, "gBrowser.selectedBrowser.fullZoom = 1.5;");
    await sleep(300);
    await inPage("scrollTo(0, 0)");
    await sleep(200);
    const z = await snapshot({ x: 250, y: 0, width: 100, height: 100 }, 1, { samples: [[0, 0], [99, 99]] });
    const zView = await snapshot({ x: 250, y: 0, width: 100, height: 100 }, 1, { drawView: true, samples: [[0, 0]] });
    const zInfo = await inPage("({ innerWidth, dpr: devicePixelRatio })");
    note("S2 zoom 1.5, rect x=250", { page: { size: [z.width, z.height], first: cell(z.samples[0]!), last: cell(z.samples[1]!) }, view: { size: [zView.width, zView.height], first: cell(zView.samples[0]!) }, zInfo });
    await chrome(m, "gBrowser.selectedBrowser.fullZoom = 1;");
  });

  it("S2: the viewfinder's rect through rectCapture: PNG size and content, scrolled and zoomed; overlay and other tabs not in it", async () => {
    await open(`${base}/cible`);
    const dpr = await chrome<number>(m, "return window.devicePixelRatio;");
    const out: unknown[] = [];
    for (const zoom of [1, 1.5]) {
      await chrome(m, "gBrowser.selectedBrowser.fullZoom = arguments[0];", [zoom]);
      await sleep(300);
      await inPage("scrollTo(0, 700)");
      await sleep(200);
      await arm();
      await sleep(100);
      await mouse("#cible");
      const c = (await result()).r;
      expect(c?.selecteur).toBe("#cible");
      // rectCapture works in view pixels (× zoom); drawSnapshot takes page CSS pixels: back to CSS, the
      // scale gives the device pixels (zoom × dpr), as capturePage does.
      const dip = rectCapture(c.rect, c.vue, zoom);
      const css = { x: dip.x / zoom, y: dip.y / zoom, width: dip.width / zoom, height: dip.height / zoom };
      const scrollY = await inPage<number>("scrollY");
      const viewSnap = await snapshot(css, zoom * dpr, { drawView: true, samples: [[Math.floor((dip.width * dpr) / 2), Math.floor((dip.height * dpr) / 2)], [2, 2]] });
      const pageSnap = await snapshot({ ...css, y: css.y + scrollY }, zoom * dpr, { samples: [[Math.floor((dip.width * dpr) / 2), Math.floor((dip.height * dpr) / 2)], [2, 2]] });
      const expected = { width: Math.round(dip.width * dpr), height: Math.round(dip.height * dpr) };
      out.push({ zoom, dpr, rect: c.rect, vue: c.vue, dip, scrollY, expected, view: { png: viewSnap.png, centre: viewSnap.samples[0], corner: viewSnap.samples[1] }, page: { png: pageSnap.png, centre: pageSnap.samples[0], corner: pageSnap.samples[1] } });
    }
    note("S2 rectCapture", out);
    for (const o of out as any[]) {
      // Gecko rounds the CSS rect out to whole CSS pixels, then scales: up to one CSS pixel (zoom × dpr device pixels)
      // more than the exact size (measured 153 for 152 at 1.5 × 1, 306 for 304 at 1.5 × 2).
      const slack = Math.ceil(o.zoom * o.dpr);
      expect(o.view.png.width - o.expected.width).toBeGreaterThanOrEqual(0);
      expect(o.view.png.width - o.expected.width).toBeLessThanOrEqual(slack);
      expect(o.view.png.height - o.expected.height).toBeLessThanOrEqual(slack);
      expect(o.view.centre).toEqual([0, 200, 0]);
    }
    await chrome(m, "gBrowser.selectedBrowser.fullZoom = 1;");
    // A chrome frame over the target, and another tab: neither is in the page's snapshot.
    await inPage("scrollTo(0, 700)");
    await sleep(200);
    const leak = await chrome(
      m,
      `const b = gBrowser.selectedBrowser, br = b.getBoundingClientRect();
       const f = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
       f.id = "spike-cover";
       f.style.cssText = "position:fixed;z-index:5;background:rgb(255,0,255);left:" + (br.left + 280) + "px;top:" + (br.top + 180) + "px;width:140px;height:80px";
       document.getElementById("browser").append(f);
       const other = gBrowser.addTab("data:text/html,<body style='background:rgb(0,0,255)'>", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
       await new Promise((r) => setTimeout(r, 500));
       const wg = b.browsingContext.currentWindowGlobal;
       const bmp = await wg.drawSnapshot(new DOMRect(290, 190, 100, 50), 1, "white", { drawView: true });
       const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
       canvas.width = bmp.width; canvas.height = bmp.height;
       const ctx = canvas.getContext("2d"); ctx.drawImage(bmp, 0, 0);
       const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
       const colours = new Set();
       for (let i = 0; i < d.length; i += 4) colours.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
       f.remove(); gBrowser.removeTab(other);
       return [...colours];`,
    );
    note("S2 colours under a chrome cover (magenta), other tab blue", leak);
    expect(leak).not.toContain("255,0,255");
    expect(leak).not.toContain("0,0,255");
  });

  // --- S3, the overlay ------------------------------------------------------------------------------------------

  it("S3: a chrome frame over the remote browser: paint, mouse and wheel outside it, keyboard in and back, the cart column", async () => {
    await open(`${base}/grille`);
    // The message rect: 360 × 56, 12 px from the top and right of the page's view.
    const placed = await chrome(
      m,
      `const b = gBrowser.selectedBrowser, br = b.getBoundingClientRect();
       const f = document.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
       f.id = "spike-calque";
       f.style.cssText = "position:fixed;z-index:3;border:none;background:transparent;left:" + (br.right - 12 - 360) + "px;top:" + (br.top + 12) + "px;width:360px;height:56px";
       document.getElementById("browser").append(f);
       // A resource:// page does not load in a chrome iframe (measured: stays about:blank); the overlay's document is
       // built in its about:blank instead (the product's would be a chrome:// page of the jar).
       await new Promise((r) => setTimeout(r, 100));
       const d = f.contentDocument, fw = f.contentWindow;
       d.documentElement.innerHTML = arguments[0];
       fw.keys = []; fw.clicks = 0; fw.wheels = 0;
       d.addEventListener("keydown", (e) => fw.keys.push((e.metaKey ? "Meta+" : "") + e.key));
       d.addEventListener("mousedown", () => fw.clicks++);
       d.addEventListener("wheel", () => fw.wheels++);
       const r = f.getBoundingClientRect();
       return { browser: [br.left, br.top, br.width, br.height], frame: [r.left, r.top, r.width, r.height], type: f.contentWindow.docShell.itemType, principal: f.contentDocument.nodePrincipal.isSystemPrincipal, isRemote: b.isRemoteBrowser };`,
      [OVERLAY],
    );
    note("S3 placed", placed);
    await sleep(300);
    const [fx, fy] = placed.frame as number[];
    // Paint: the opaque box at its left, the page (transparent part) at its right.
    const shot = await chrome<{ box: number[]; clear: number[]; dpr: number }>(
      m,
      `const [x, y] = arguments;
       const shot = await window.browsingContext.currentWindowGlobal.drawSnapshot(null, window.devicePixelRatio, "white");
       const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
       canvas.width = shot.width; canvas.height = shot.height;
       const ctx = canvas.getContext("2d"); ctx.drawImage(shot, 0, 0);
       const at = (px, py) => [...ctx.getImageData(Math.round(px * devicePixelRatio), Math.round(py * devicePixelRatio), 1, 1).data].slice(0, 3);
       return { box: at(x + 5, y + 50), clear: at(x + 300, y + 30), dpr: devicePixelRatio };`,
      [fx, fy],
    );
    note("S3 paint (box should be 109,94,252; clear part = the page's cell colour)", shot);
    // Mouse and wheel: on the frame they go to the frame; outside it, to the page.
    await inPage("window.got = []; for (const t of ['mousedown', 'click', 'wheel']) addEventListener(t, (e) => got.push(t + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY)), true);");
    const before = await inPage("scrollY");
    const routed = await chrome(
      m,
      `const [fx, fy] = arguments;
       const u = window.windowUtils, f = document.getElementById("spike-calque").contentWindow;
       const b = gBrowser.selectedBrowser.getBoundingClientRect();
       const hit = (x, y) => { const e = document.elementFromPoint(x, y); return e ? e.localName + (e.id ? "#" + e.id : "") : null; };
       const hits = { onFrame: hit(fx + 20, fy + 20), outside: hit(b.left + 100, b.top + 300) };
       window.synthesizeMouseEvent("mousedown", fx + 20, fy + 20, { button: 0, clickCount: 1 }); window.synthesizeMouseEvent("mouseup", fx + 20, fy + 20, { button: 0, clickCount: 1 });
       u.sendWheelEvent(fx + 20, fy + 20, 0, 100, 0, 0, 0, 0, 0, 0);
       window.synthesizeMouseEvent("mousedown", b.left + 100, b.top + 300, { button: 0, clickCount: 1 }); window.synthesizeMouseEvent("mouseup", b.left + 100, b.top + 300, { button: 0, clickCount: 1 });
       u.sendWheelEvent(b.left + 100, b.top + 300, 0, 120, 0, 0, 0, 0, 0, 0);
       await new Promise((r) => setTimeout(r, 600));
       return { hits, frameClicks: f.clicks, frameWheels: f.wheels };`,
      [fx, fy],
    );
    const page = { got: await inPage("window.got"), scrolled: (await inPage<number>("scrollY")) - before };
    note("S3 mouse and wheel", { routed, page });
    // Keyboard: the frame takes it (Escape and ⌘Enter reach it), then the page gets it back.
    await inPage("window.typed = []; addEventListener('keydown', (e) => typed.push(e.key), true);");
    await chrome(m, `const f = document.getElementById("spike-calque"); f.focus(); f.contentDocument.getElementById("t").focus();`);
    await pressKeys(m, "a");
    await pressKeys(m, "Escape");
    await pressKeys(m, "Meta+Enter");
    const inFrame = await chrome(m, `const f = document.getElementById("spike-calque").contentWindow; return { keys: [...f.keys], value: f.document.getElementById("t").value, focused: document.activeElement?.id };`);
    const pageDuring = await inPage("window.typed.slice()");
    await chrome(m, "gBrowser.selectedBrowser.focus();");
    await pressKeys(m, "b");
    await sleep(200);
    const back = { pageTyped: await inPage("window.typed"), hasFocus: await inPage("document.hasFocus()"), chromeActive: await chrome(m, "return document.activeElement?.localName;") };
    note("S3 keyboard", { inFrame, pageDuring, back });
    // The cart column: 300 px on the right; the page shrinks by it (as --webaios-agent does).
    const column = await chrome(
      m,
      `const b = gBrowser.selectedBrowser;
       const w0 = b.getBoundingClientRect().width;
       const v = document.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
       v.id = "spike-volet";
       v.style.cssText = "position:fixed;z-index:3;border:none;top:0;height:100%;width:300px;right:var(--webaios-agent, 0px);background:rgb(30,30,30)";
       document.getElementById("browser").append(v);
       document.getElementById("tabbrowser-tabbox").style.marginInlineEnd = "calc(var(--webaios-agent, 0px) + 300px)";
       await new Promise((r) => setTimeout(r, 300));
       const br = b.getBoundingClientRect(), vr = v.getBoundingClientRect();
       const out = { before: w0, after: br.width, browserRight: br.right, voletLeft: vr.left, atVolet: document.elementFromPoint(vr.left + 10, 100)?.id };
       v.remove(); document.getElementById("tabbrowser-tabbox").style.marginInlineEnd = ""; document.getElementById("spike-calque").remove();
       return out;`,
    );
    const inner = await inPage("innerWidth");
    note("S3 cart column", { ...column, pageInnerWidthAfterRemoval: inner });
    expect(shot.box).toEqual([109, 94, 252]);
    expect(routed.hits).toEqual({ onFrame: "iframe#spike-calque", outside: "browser" });
    expect(page.got).toEqual(["mousedown@100,300", "click@100,300", "wheel@100,300"]);
    expect(inFrame.keys).toEqual(expect.arrayContaining(["Escape", "Meta+Enter"]));
    expect(pageDuring).toEqual([]);
    expect(back.pageTyped).toEqual(["b"]);
    expect(column.after).toBe(column.before - 300);
  });

  // --- S4, the source -------------------------------------------------------------------------------------------

  /** The lireSource expression, as is. */
  const SOURCE_CODE = (selector: string) => `(() => {
    try {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const ds = el.getAttribute("data-source");
      if (ds) { const m = /^(.*?):(\\d+)(?::(\\d+))?$/.exec(ds); return m ? { fichier: m[1], ligne: Number(m[2]), ...(m[3] ? { colonne: Number(m[3]) } : {}) } : { fichier: ds }; }
      const ch = el.getAttribute("data-inspector-relative-path"), li = el.getAttribute("data-inspector-line");
      if (ch && li) return { fichier: ch, ligne: Number(li) };
      const loc = el.__svelte_meta && el.__svelte_meta.loc;
      if (loc && loc.file) return { fichier: loc.file, ligne: loc.line, colonne: loc.column };
      const vue = el.__vueParentComponent && el.__vueParentComponent.type && el.__vueParentComponent.type.__file;
      if (vue) return { fichier: vue };
      const cle = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
      if (cle) {
        let f = el[cle];
        for (let i = 0; f && i < 50; i++, f = f.return)
          if (f._debugSource && f._debugSource.fileName) return { fichier: f._debugSource.fileName, ligne: f._debugSource.lineNumber };
      }
      return null;
    } catch { return null; }
  })()`;
  // sourceSaine: what the parent keeps.
  const healthySource = (r: any) => {
    const ok = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0;
    if (!r || typeof r !== "object" || typeof r.fichier !== "string" || r.fichier.length > 1024 || r.fichier === "") return null;
    return { fichier: r.fichier, ...(ok(r.ligne) ? { ligne: r.ligne } : {}), ...(ok(r.colonne) ? { colonne: r.colonne } : {}) };
  };
  const source = async (sel: string) => {
    const raw = await ask("source", { code: SOURCE_CODE(sel) });
    return { raw, kept: healthySource(raw) };
  };

  it("S4: data-source read, none without, malformed values dropped; nothing left in the page", async () => {
    await open(`${base}/`);
    const keys = await inPage<string[]>("Object.keys(window).sort()");
    const ds = await source("p[data-source]");
    const none = await source("#nue");
    await inPage(`document.querySelector("#nue").__svelte_meta = { loc: { file: {}, line: "x" } }`);
    const bad1 = await source("#nue");
    await inPage(`document.querySelector("#nue").__svelte_meta = { loc: { file: "a.svelte", line: -3, column: 1.5 } }`);
    const bad2 = await source("#nue");
    // A page getter runs (as in the page's main world), and a throwing one gives null.
    await inPage(`window.getterRuns = 0; Object.defineProperty(document.querySelector("#nue"), "__svelte_meta", { get() { getterRuns++; throw new Error("x"); } })`);
    const throwing = await source("#nue");
    note("S4 data-source", { ds, none, bad1, bad2, throwing, getterRuns: await inPage("window.getterRuns") });
    expect(ds.kept).toEqual({ fichier: "src/Inscription.svelte", ligne: 12 });
    expect(none.kept).toBeNull();
    expect(bad1.kept).toBeNull();
    expect(bad2.kept).toEqual({ fichier: "a.svelte" });
    expect(throwing.kept).toBeNull();
    const after = await inPage<string[]>("Object.keys(window).sort()");
    expect(after.filter((k) => /viseur|webaios/i.test(k))).toEqual([]);
    note("S4 page globals added (the test's own getterRuns only)", after.filter((k) => !keys.includes(k)));
  });

  it("S4: __svelte_meta on a Svelte 5 dev-mode page", async () => {
    await open(`${base}/svelte/index.html`);
    await waitFor(m, `return ${ACTOR}.sendQuery("hosts").then(() => ${ACTOR}.sendQuery("probe", { code: "!!document.querySelector('#plus')" }));`, (v) => v === true);
    const button = await source("#plus");
    const section = await source("section");
    note("S4 svelte", { button, section });
    expect(button.kept?.fichier).toMatch(/Essai\.svelte$/);
    expect(button.kept?.ligne).toBeGreaterThan(0);
  });
});
