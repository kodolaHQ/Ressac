import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bubbleSlot, rectCapture } from "../chrome/store/design-copies";
import { UNAVAILABLE_DESIGN } from "../shared/design-guards";
import { openTab, testActor } from "./agent-extensions";
import { pageLog, clearLog, startDesignServers, stopActor, trustedMouse } from "./design";
import { pressClosing, waitFor, waitReady, waitWindowCount } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { inBrowser, resolveLocalHosts } from "./sites";

// Plan 35b Task 2: the chrome's design service (chrome/store/design.ts) driven through store.design, the overlays
// replaced by a recorder (they come with Task 3). The demo is 127.0.0.1:15303, in this file's block 15300-15304.

const PORT = 15303;
const B = "gBrowser.selectedBrowser";
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let servers: Awaited<ReturnType<typeof startDesignServers>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const dirs: string[] = [];
const launched: LaunchedWebAiOs[] = [];

/** A WebAiOs on the demo's port block, its overlays recorded in `window.__overlay`, its host answering. */
async function boot(prefs: Record<string, string | number | boolean> = {}): Promise<LaunchedWebAiOs> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  const a = testActor(profile);
  const l = await launchWebAiOs({ dataDir, profile, env: { ...a.env, WEBAIOS_PORTS_APPS: "15300-15304" }, prefs: { ...a.prefs, ...prefs } });
  launched.push(l);
  const mm = l.marionette;
  await mm.setContext("chrome");
  await waitFor(mm, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await resolveLocalHosts(mm, ["localhost"]);
  await mm.execute(`return (async () => {
    const d = (await ChromeUtils.importESModule("${STORE}").ready).design;
    window.__overlay = [];
    d.overlays = {
      show: (key, win, place, ctx) => window.__overlay.push({ op: "show", key, place, ctx: JSON.parse(JSON.stringify(ctx)) }),
      hide: (key, mode) => window.__overlay.push({ op: "hide", key, mode }),
      forget: (key) => window.__overlay.push({ op: "forget", key }),
    };
    return 1;
  })();`);
  // The host answers design.suivi (not "projet" for a parking tab: null, or a rejection while it starts).
  await waitFor(mm, `return (async () => { const d = (await ChromeUtils.importESModule("${STORE}").ready).design; return d.etat({ type: "fenetre", fenetreId: window.webaiosWindow.fenetreId }).then(() => true, () => false); })();`, (v) => v === true, 30_000);
  return l;
}

beforeAll(async () => {
  servers = await startDesignServers({ port: PORT });
  w = await boot();
  m = w.marionette;
}, 120_000);
afterAll(async () => {
  for (const l of launched) await l.close();
  await servers?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Runs `body` with `d` the design service and `t` this window's target; `args` are `args`. */
const svc = <R = unknown>(body: string, args: unknown[] = []) =>
  m.execute<R>(
    `return (async (args) => { const d = (await ChromeUtils.importESModule("${STORE}").ready).design; const t = { type: "fenetre", fenetreId: window.webaiosWindow.fenetreId }; ${body} })([...arguments]);`,
    args,
  );
const etat = () => svc<{ actif: boolean; panier: number; indisponible: string | null; projet: { projet: string } | null }>("return await d.etat(t);");
const toggle = () => svc("await d.toggle(t); return 1;");
const stopMode = () => svc("await d.stop(t); return 1;");
const add = (texte: string) => svc<{ ok: boolean; erreur?: string }>("return await d.add(t, args[0]);", [texte]);

async function open(p: string, base = servers.page): Promise<void> {
  await openTab(m, `${base}${p}`);
  await m.execute(`${B}.focus();`);
}
const inPage = <T = unknown>(script: string) => inBrowser<T>(m, B, script);
const hosts = () => inPage<number>(`return document.querySelectorAll("webaios-viseur").length;`);
const bubbles = () => m.execute<{ place: { x: number; y: number; width: number; height: number }; ctx: { etiquette: string; source: string | null; projet: string; mode: string } }[]>(
  `return window.__overlay.filter((e) => e.op === "show" && e.ctx.mode === "bulle");`,
);

/** Toggles the mode on, waits for the viewfinder, clicks `sel` as a person: the bubble shown. */
async function aim(sel: string) {
  const n = (await bubbles()).length;
  await toggle();
  await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
  await trustedMouse(m, B, sel);
  await expect.poll(async () => (await bubbles()).length, { timeout: 10_000 }).toBe(n + 1);
  return (await bubbles()).at(-1)!;
}

/**
 * The parent actor of the selected tab's page, its queries recorded in `window.__queries`; `arm` answers that JSON
 * instead, `stop` hangs or throws (the actor's own limits, simulated).
 */
const record = (o: { arm?: string; stop?: "hang" | "throw" } = {}) =>
  m.execute(
    `const a = ${B}.browsingContext.currentWindowGlobal.getActor("WebAiOsDesign"), [o] = arguments;
     const real = (a.__real ??= a.sendQuery);
     window.__queries = [];
     a.sendQuery = (n, data) => {
       window.__queries.push(n);
       if (n === "arm" && o.arm) return Promise.resolve(JSON.parse(o.arm));
       if (n === "stop" && o.stop === "hang") return new Promise(() => {});
       if (n === "stop" && o.stop === "throw") return Promise.reject(new Error("eval"));
       return real.call(a, n, data);
     };
     return 1;`,
    [o],
  );
const queries = () => m.execute<string[]>("return window.__queries;");
const unrecord = () => m.execute(`const a = ${B}.browsingContext.currentWindowGlobal.getActor("WebAiOsDesign"); if (a.__real) a.sendQuery = a.__real; return 1;`);

/** The PNGs of the demo's cart on disk. */
const pngs = (l: LaunchedWebAiOs) =>
  (readdirSync(l.dataDir, { recursive: true }) as string[]).filter((f) => f.endsWith(".png") && f.includes(`demo-${PORT}`)).map((f) => path.join(l.dataDir, f));

/** The PNG's size (IHDR), the colours at `at` and every colour in it, decoded by the chrome. */
async function readPng(file: string, at: [number, number][]) {
  const buf = readFileSync(file);
  const decoded = await m.execute<{ at: number[][]; colours: string[] }>(
    `return (async ([b64, at]) => {
       const img = document.createElementNS("http://www.w3.org/1999/xhtml", "img");
       img.src = "data:image/png;base64," + b64;
       await img.decode();
       const c = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
       c.width = img.naturalWidth; c.height = img.naturalHeight;
       const x = c.getContext("2d");
       x.drawImage(img, 0, 0);
       const d = x.getImageData(0, 0, c.width, c.height).data, colours = new Set();
       for (let i = 0; i < d.length; i += 4) colours.add(d[i] + "," + d[i + 1] + "," + d[i + 2]);
       return { at: at.map(([px, py]) => [...x.getImageData(px, py, 1, 1).data].slice(0, 3)), colours: [...colours] };
     })(arguments);`,
    [buf.toString("base64"), at],
  );
  return { signature: buf.subarray(1, 4).toString("latin1"), width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ...decoded };
}

/** /cible at `zoom`, scrolled 700 px; the target aimed and added: the new PNG and the size rectCapture expects. */
async function captureTarget(zoom: number) {
  await open("/cible");
  await m.execute(`${B}.fullZoom = arguments[0];`, [zoom]);
  await inPage("scrollTo(0, 700); return 1;");
  await sleep(300);
  const before = new Set(pngs(launched.at(-1)!));
  await aim("#cible");
  expect(await add("capture")).toEqual({ ok: true });
  const file = pngs(launched.at(-1)!).find((f) => !before.has(f))!;
  expect(file).toBeTruthy();
  const page = await inPage<{ x: number; y: number; w: number; h: number; vw: number; vh: number }>(
    `const r = document.querySelector("#cible").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };`,
  );
  const dpr = await m.execute<number>("return window.devicePixelRatio;");
  const dip = rectCapture({ x: page.x, y: page.y, largeur: page.w, hauteur: page.h }, { largeur: page.vw, hauteur: page.vh }, zoom);
  const expected = { width: Math.round(dip.width * dpr), height: Math.round(dip.height * dpr) };
  const png = await readPng(file, [[Math.floor(expected.width / 2), Math.floor(expected.height / 2)], [2, 2]]);
  await stopMode();
  await m.execute(`${B}.fullZoom = 1;`);
  return { png, expected };
}

describe("design service", () => {
  // design.spec.ts:152
  it("captureElement gives a PNG of rectCapture's size, at zoom 1 and 1.5, the page scrolled 700 px", async () => {
    for (const zoom of [1, 1.5]) {
      const { png, expected } = await captureTarget(zoom);
      expect(png.signature).toBe("PNG");
      expect({ width: png.width, height: png.height }).toEqual(expected);
      expect(png.at[0]).toEqual([0, 200, 0]);
      expect(png.at[1]).toEqual([255, 255, 255]);
    }
  });

  it("the capture never shows the chrome nor another tab", async () => {
    await open("/cible");
    await inPage("scrollTo(0, 700); return 1;");
    await sleep(200);
    // A magenta chrome div over the target (clicks pass through it), a blue tab behind.
    await m.execute(
      `const b = ${B}, br = b.getBoundingClientRect();
       const f = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
       f.id = "test-cover";
       f.style.cssText = "position:fixed;z-index:5;pointer-events:none;background:rgb(255,0,255);left:" + (br.left + 280) + "px;top:" + (br.top + 180) + "px;width:140px;height:80px";
       document.getElementById("browser").append(f);
       window.__blue = gBrowser.addTab("data:text/html,<body style='background:rgb(0,0,255)'>", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true });
       return 1;`,
    );
    await sleep(500);
    const before = new Set(pngs(w));
    await aim("#cible");
    expect(await add("sans calque")).toEqual({ ok: true });
    const file = pngs(w).find((f) => !before.has(f))!;
    const png = await readPng(file, [[50, 30]]);
    await stopMode();
    await m.execute(`document.getElementById("test-cover").remove(); gBrowser.removeTab(window.__blue); return 1;`);
    expect(png.colours).toContain("0,200,0");
    expect(png.colours).not.toContain("255,0,255");
    expect(png.colours).not.toContain("0,0,255");
  });

  it("toggle on the demo, a trusted click on #email: the bubble context names input#email.champ, its place is placeBulle's", async () => {
    await open("/");
    const b = await aim("#email");
    expect(b.ctx).toMatchObject({ mode: "bulle", etiquette: "input#email.champ", projet: `demo-${PORT}` });
    const r = await inPage<{ x: number; y: number; largeur: number; hauteur: number }>(`const r = document.querySelector("#email").getBoundingClientRect(); return { x: r.x, y: r.y, largeur: r.width, hauteur: r.height };`);
    const g = await m.execute<{ z: number; x: number; y: number; width: number; height: number; w: number; h: number }>(
      `const r = ${B}.getBoundingClientRect(); return { z: ${B}.fullZoom, x: r.x, y: r.y, width: r.width, height: r.height, w: window.innerWidth, h: window.innerHeight };`,
    );
    expect(b.place).toEqual(bubbleSlot(r, g.z, g, [g.w, g.h]));
    expect(await svc("return d.overlayContext(t);")).toEqual(b.ctx);
    // The bubble is open: the viewfinder waits; Annuler arms it again.
    expect(await hosts()).toBe(0);
    expect((await etat()).actif).toBe(true);
    await svc("d.cancel(t); return 1;");
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    // Only the bubble: the UI's cart column (Task 3) shows while the mode is on.
    expect(await svc('return d.overlayContext(t, ["bulle", "message"]);')).toBeNull();
    await stopMode();
    expect(await hosts()).toBe(0);
    expect((await etat()).actif).toBe(false);
  });

  it("a data-source element: the bubble's source is src/Inscription.svelte:12", async () => {
    await open("/");
    expect((await aim("p[data-source]")).ctx.source).toBe("src/Inscription.svelte:12");
    await stopMode();
  });

  // design.spec.ts:186 (the service's part)
  it("pushState while armed: the viewfinder is armed again, the next click captures", async () => {
    await open("/");
    await record();
    await toggle();
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    await inPage(`history.pushState({}, "", "/x"); return 1;`);
    await expect.poll(queries, { timeout: 10_000 }).toEqual(["arm", "stop", "arm"]);
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    expect((await etat()).actif).toBe(true);
    const n = (await bubbles()).length;
    await trustedMouse(m, B, "#email");
    await expect.poll(async () => (await bubbles()).length, { timeout: 10_000 }).toBe(n + 1);
    expect((await bubbles()).at(-1)!.ctx.etiquette).toBe("input#email.champ");
    await stopMode();
  });

  it("reload while armed: the mode stops, the cart stays", async () => {
    await open("/");
    await aim("#email");
    expect(await add("reste")).toEqual({ ok: true });
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    const cart = (await etat()).panier;
    expect(cart).toBeGreaterThan(0);
    await m.execute(`${B}.reload();`);
    await expect.poll(async () => (await etat()).actif, { timeout: 10_000 }).toBe(false);
    await waitFor(m, `return !${B}.webProgress.isLoadingDocument;`, (v) => v === true);
    expect(await hosts()).toBe(0);
    expect((await etat()).panier).toBe(cart);
  });

  it("another tab, the tab closed: the mode stops", async () => {
    await open("/");
    await m.execute("window.__designTabA = gBrowser.selectedTab;");
    await toggle();
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    await open("/");
    await m.execute("gBrowser.selectedTab = window.__designTabA;");
    await waitFor(m, "return gBrowser.selectedTab === window.__designTabA;", (v) => v === true);
    expect((await etat()).actif).toBe(false);
    expect(await hosts()).toBe(0);
    await toggle();
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    await m.execute("gBrowser.removeTab(window.__designTabA);");
    await expect.poll(async () => (await etat()).actif, { timeout: 10_000 }).toBe(false);
    // The session is gone: toggling the tab shown now starts a new one, never stops an old one.
    await toggle();
    await expect.poll(async () => (await etat()).actif, { timeout: 10_000 }).toBe(true);
    await stopMode();
  });

  it("the parent arms only the target's selected <browser>", async () => {
    await open("/");
    await m.execute("window.__designTabA = gBrowser.selectedTab;");
    await open("/");
    await toggle();
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    expect(await inBrowser<number>(m, "window.__designTabA.linkedBrowser", `return document.querySelectorAll("webaios-viseur").length;`)).toBe(0);
    await stopMode();
  });

  it("OOP frame of the demo page: guarded while armed, free after stop", async () => {
    await open("/oop");
    await waitFor(m, `const c = ${B}.browsingContext.children[0]?.currentWindowGlobal; return !!c && c.documentURI.spec.startsWith(${JSON.stringify(servers.frame)}) && c.isProcessRoot && !${B}.webProgress.isLoadingDocument;`, (v) => v === true);
    await toggle();
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    await sleep(300);
    await clearLog(m, B, 0);
    await trustedMouse(m, B, "#dans", { frame: 0 });
    await trustedMouse(m, B, "#dans", { frame: 0, button: 1 });
    await sleep(300);
    expect((await pageLog(m, B, 0)).early).toEqual([]);
    await stopMode();
    await trustedMouse(m, B, "#dans", { frame: 0 });
    await expect.poll(async () => (await pageLog(m, B, 0)).early, { timeout: 10_000 }).toContain("click:true");
  });

  it("a cross-origin frame added after arming is guarded too, and free after stop", async () => {
    await open("/");
    await toggle();
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    await inPage(`const f = document.createElement("iframe"); f.src = ${JSON.stringify(`${servers.frame}/frame`)}; f.style.cssText = "width:300px;height:120px;border:0"; document.body.append(f); return 1;`);
    await waitFor(m, `const c = ${B}.browsingContext.children[0]?.currentWindowGlobal; return !!c && c.documentURI.spec.startsWith(${JSON.stringify(servers.frame)}) && c.isProcessRoot;`, (v) => v === true);
    await sleep(300);
    await clearLog(m, B, 0);
    await trustedMouse(m, B, "#dans", { frame: 0 });
    await sleep(300);
    expect((await pageLog(m, B, 0)).early).toEqual([]);
    // Still aiming: the frame's click picked nothing.
    expect(await hosts()).toBe(1);
    await stopMode();
    await trustedMouse(m, B, "#dans", { frame: 0 });
    await expect.poll(async () => (await pageLog(m, B, 0)).early, { timeout: 10_000 }).toContain("click:true");
  });

  it("a tab outside any project: toggle arms nothing", async () => {
    await open("/", servers.frame);
    await record();
    await toggle();
    await sleep(500);
    expect(await hosts()).toBe(0);
    expect(await queries()).toEqual([]);
    expect(await etat()).toMatchObject({ actif: false, projet: null, indisponible: UNAVAILABLE_DESIGN });
  });

  it("an answer of the wrong shape stops the mode, no bubble", async () => {
    await open("/");
    const n = (await bubbles()).length;
    await record({ arm: JSON.stringify({ selecteur: 1, rect: {} }) });
    await toggle();
    await expect.poll(async () => (await etat()).actif, { timeout: 10_000 }).toBe(false);
    expect((await bubbles()).length).toBe(n);
    expect(await queries()).toEqual(expect.arrayContaining(["arm", "stop"]));
  });

  it("never armed twice: concurrent toggles make one session; off then on stops before arming again", async () => {
    await open("/");
    await record();
    await svc("await Promise.all([d.toggle(t), d.toggle(t), d.toggle(t)]); return 1;");
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    expect(await queries()).toEqual(["arm"]);
    await svc("await d.toggle(t); await d.toggle(t); return 1;");
    await expect.poll(queries, { timeout: 10_000 }).toEqual(["arm", "stop", "arm"]);
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    const n = (await bubbles()).length;
    await trustedMouse(m, B, "#envoyer", { count: 2 });
    await expect.poll(async () => (await bubbles()).length, { timeout: 10_000 }).toBe(n + 1);
    await sleep(300);
    expect((await bubbles()).length).toBe(n + 1);
    await stopMode();
  });

  it("a stop that throws or never answers: the mode ends, the top window is unguarded", async () => {
    for (const how of ["throw", "hang"] as const) {
      await open("/");
      await toggle();
      await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
      await record({ stop: how });
      const t0 = Date.now();
      await stopMode();
      expect(Date.now() - t0).toBeLessThan(how === "hang" ? 2500 : 1000);
      expect(await queries()).toEqual(["stop", "unguard"]);
      expect((await etat()).actif).toBe(false);
      // The guard is gone: a trusted click reaches the page (the viewfinder's own listeners never take a click).
      await clearLog(m, B);
      await trustedMouse(m, B, "#email");
      await expect.poll(async () => (await pageLog(m, B)).reactions, { timeout: 10_000 }).toContain("click:email");
      await unrecord();
      await stopActor(m, B);
    }
  });

  it("its process crashed: the mode stops", async () => {
    await open("/");
    await toggle();
    await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
    await m.execute(`Cc["@mozilla.org/processtools-service;1"].getService(Ci.nsIProcessToolsService).crash(${B}.browsingContext.currentWindowGlobal.domProcess.osPid);`);
    await expect.poll(async () => (await etat()).actif, { timeout: 10_000 }).toBe(false);
  });

  // Review minor 3: the project comes from the armed document's own address, never from the <browser>'s.
  it("a <browser> whose address says demo over a page outside any project: toggle arms nothing", async () => {
    await open("/", servers.frame);
    await record();
    await m.execute(`Object.defineProperty(${B}, "currentURI", { configurable: true, get: () => Services.io.newURI("${servers.page}/") }); return 1;`);
    try {
      await toggle();
      await sleep(500);
      expect(await hosts()).toBe(0);
      expect(await queries()).toEqual([]);
      expect((await etat()).projet).toBeNull();
    } finally {
      await m.execute(`delete ${B}.currentURI; return 1;`);
      await stopMode();
    }
  });

  // Review minor 5: a throw after the arm stops the session.
  it("a throw while showing the bubble stops the mode, no bubble", async () => {
    await open("/");
    const n = (await bubbles()).length;
    // The click's own gesture reads it once; the service's next read (the bubble's place) throws.
    await m.execute(`const b = ${B}, real = b.getBoundingClientRect; let n = 0; b.getBoundingClientRect = function () { if (n++ >= 1) throw new Error("test"); return real.call(this); }; return 1;`);
    try {
      await toggle();
      await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
      await trustedMouse(m, B, { x: 60, y: 20 });
      await expect.poll(async () => (await etat()).actif, { timeout: 10_000 }).toBe(false);
      expect((await bubbles()).length).toBe(n);
    } finally {
      await m.execute(`delete ${B}.getBoundingClientRect; return 1;`);
    }
  });

  // Review minor 4: the last window's id is reused when it reopens (windows.ts kept).
  it("closing the last window forgets its overlay context: reopened, the context is fresh", async () => {
    await open("/");
    await svc("await d.openCart(t); return 1;");
    expect(await svc("return d.overlayContext(t)?.mode ?? null;")).toBe("panier");
    const id = await m.execute<string>("return window.webaiosWindow.fenetreId;");
    // A module timer outlives the window: once it is gone, it reopens one as the Dock would.
    await m.execute(
      `const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
       const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
       const reopen = () => [...Services.wm.getEnumerator("navigator:browser")].length ? setTimeout(reopen, 100) : setTimeout(() => BrowserWindowTracker.openWindow(), 500);
       setTimeout(reopen, 100);`,
    );
    const old = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    await pressClosing(m, "Meta+Shift+w");
    const reopened = (await waitWindowCount(m, 1, 20_000)).find((h) => h !== old)!;
    await m.command("WebDriver:SwitchToWindow", { handle: reopened, focus: false });
    await waitReady(m);
    await waitFor(m, "return !!window.webaiosWindow;", (v) => v === true);
    expect(await m.execute("return window.webaiosWindow.fenetreId;")).toBe(id);
    expect(await svc("return d.overlayContext(t);")).toBeNull();
    // The recorder lived in the closed window: set again for the tests after.
    await m.execute(`return (async () => { const d = (await ChromeUtils.importESModule("${STORE}").ready).design;
      window.__overlay = [];
      d.overlays = { show: (key, win, place, ctx) => window.__overlay.push({ op: "show", key, place, ctx: JSON.parse(JSON.stringify(ctx)) }), hide: (key, mode) => window.__overlay.push({ op: "hide", key, mode }), forget: (key) => window.__overlay.push({ op: "forget", key }) };
      return 1; })();`);
  });

  it("the host stopped: toggle does nothing, etat rejects", async () => {
    await open("/");
    await m.execute(`return (async () => { await (await ChromeUtils.importESModule("${STORE}").ready).agent.stop(); return 1; })();`);
    expect(await svc("return await d.etat(t).then(() => 'resolved', (e) => 'rejected');")).toBe("rejected");
    await toggle();
    await sleep(500);
    expect(await hosts()).toBe(0);
  });
});

describe("design service, density 2", () => {
  // design.spec.ts:152, a second launch with layout.css.devPixelsPerPx = 2.
  it("captureElement gives a PNG of rectCapture's size at density 2, zoom 1 and 1.5", { timeout: 120_000 }, async () => {
    const first = m;
    m = (await boot({ "layout.css.devPixelsPerPx": "2.0" })).marionette;
    try {
      expect(await m.execute("return window.devicePixelRatio;")).toBe(2);
      for (const zoom of [1, 1.5]) {
        const { png, expected } = await captureTarget(zoom);
        expect({ width: png.width, height: png.height }).toEqual(expected);
        expect(png.at[0]).toEqual([0, 200, 0]);
        expect(png.at[1]).toEqual([255, 255, 255]);
      }
    } finally {
      m = first;
    }
  });
});
