import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanCapture } from "../chrome/store/design-copies";
import { openTab, testActor } from "./agent-extensions";
import { armActor, askActor, center, clearLog, guardFrame, pageLog, readSource, startDesignServers, stopActor, trustedMouse, unguardFrame } from "./design";
import { waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { inBrowser, resolveLocalHosts } from "./sites";
import { pressKeys } from "./ui";

// Plan 35a Task 1: the design viewfinder actor (WebAiOsDesign), and the guard of
// the spikes' « Correctif S1 », in the top window and in every process-root frame.

const B = "gBrowser.selectedBrowser";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let servers: Awaited<ReturnType<typeof startDesignServers>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const dirs: string[] = [];

beforeAll(async () => {
  servers = await startDesignServers();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  const a = testActor(profile);
  // One web process per site: « two tabs in one process » is then a fact, not a chance. Back goes to a page left
  // without a user gesture (the bfcache test).
  w = await launchWebAiOs({ dataDir, profile, env: a.env, prefs: { ...a.prefs, "dom.ipc.processCount.webIsolated": 1, "browser.navigation.requireUserInteraction": false } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await resolveLocalHosts(m, ["localhost"]);
}, 120_000);
afterAll(async () => {
  await w?.close();
  await servers?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function open(p: string): Promise<void> {
  await openTab(m, `${servers.page}${p}`);
  await m.execute(`${B}.focus();`);
}
const inPage = <T = unknown>(script: string) => inBrowser<T>(m, B, script);
const hosts = () => inPage<number>(`return document.querySelectorAll("webaios-viseur").length;`);
/** Arms the viewfinder and waits for its host element. */
async function arm() {
  const a = await armActor(m, B);
  await expect.poll(hosts, { timeout: 10_000 }).toBe(1);
  return a;
}
/** Waits past the 500 ms swallow that follows a capture. */
const afterSwallow = () => sleep(600);

describe("design viewfinder actor", () => {
  // design.spec.ts:63
  it("click on #envoyer: the page does not react, the capture describes the button", async () => {
    await open("/");
    const a = await arm();
    await trustedMouse(m, B, "#envoyer");
    const c = cleanCapture(((await a.result()) as { r?: unknown }).r);
    expect(c?.selecteur).toBe("#envoyer");
    expect(c?.etiquette).toBe("button#envoyer");
    expect(c?.voisinage.parent).toBe("form#inscription");
    expect(Object.keys(c?.styles ?? {})).toHaveLength(26);
    expect(c?.html.startsWith("<button")).toBe(true);
    expect(c!.rect.largeur).toBeGreaterThan(0);
    expect(c?.adresse).toBe(`${servers.page}/`);
    expect((await pageLog(m, B)).reactions).toEqual([]);
    expect(await inPage("return location.href;")).toBe(`${servers.page}/`);
  });

  // design.spec.ts:83
  it("click on #lien: the tab's address does not change", async () => {
    await open("/");
    const a = await arm();
    await trustedMouse(m, B, "#lien");
    expect(((await a.result()) as { r?: { selecteur: string } }).r?.selecteur).toBe("#lien");
    await sleep(500);
    expect(await inPage("return location.href;")).toBe(`${servers.page}/`);
  });

  // design.spec.ts:97
  it("click on an element without id: the selector designates only it", async () => {
    await open("/");
    const a = await arm();
    await trustedMouse(m, B, "li:nth-child(2)");
    const c = cleanCapture(((await a.result()) as { r?: unknown }).r);
    expect(await inPage(`const l = document.querySelectorAll(${JSON.stringify(c!.selecteur)}); return l.length === 1 && l[0].textContent === "deux";`)).toBe(true);
    expect(c!.voisinage.freres.length).toBeGreaterThan(0);
  });

  // design.spec.ts:112
  it("after a capture or Escape: no viewfinder in the DOM, no global added to the page", async () => {
    await open("/");
    const keys = await inPage<string[]>("return Object.keys(window.wrappedJSObject ?? window).sort();");
    const clean = async () => {
      expect(await hosts()).toBe(0);
      expect(await inPage("return Object.keys(window.wrappedJSObject ?? window).sort();")).toEqual(keys);
      expect(await inPage("const w = window.wrappedJSObject ?? window; return [typeof w.__viseurArret, typeof w.__viseurAvaler, typeof w.__viseurChoisir];")).toEqual(["undefined", "undefined", "undefined"]);
    };
    let a = await arm();
    await pressKeys(m, "Escape");
    expect(await a.result()).toEqual({ r: null });
    await clean();
    a = await arm();
    await trustedMouse(m, B, "#email");
    expect(((await a.result()) as { r?: { selecteur: string } }).r?.selecteur).toBe("#email");
    await clean();
    a = await arm();
    await stopActor(m, B);
    expect(await a.result()).toEqual({ r: null });
    await clean();
  });

  // design.spec.ts:135, :236
  it("source: data-source read, none gives null, malformed values are discarded", async () => {
    await open("/");
    expect(await readSource(m, B, "p[data-source]")).toEqual({ fichier: "src/Inscription.svelte", ligne: 12 });
    expect(await readSource(m, B, "#nue")).toBeNull();
    // Set by the page's own script (its world, where lireSource reads).
    const pageSets = (code: string) => inPage(`const s = document.createElement("script"); s.textContent = ${JSON.stringify(code)}; document.head.append(s); s.remove(); return 1;`);
    await pageSets(`document.querySelector("#nue").__svelte_meta = { loc: { file: {}, line: "x" } }`);
    expect(await readSource(m, B, "#nue")).toBeNull();
    await pageSets(`document.querySelector("#nue").__svelte_meta = { loc: { file: "a.svelte", line: -3, column: 1.5 } }`);
    expect(await readSource(m, B, "#nue")).toEqual({ fichier: "a.svelte" });
    await pageSets(`Object.defineProperty(document.querySelector("#nue"), "__svelte_meta", { get() { throw new Error("no"); } })`);
    expect(await readSource(m, B, "#nue")).toBeNull();
    expect(await inPage("return Object.keys(window.wrappedJSObject ?? window).filter((k) => /viseur|webaios/i.test(k));")).toEqual([]);
  });

  // design.spec.ts:174
  // Pagehide ends the viewfinder first ({ r: null }); a rejection (AbortError,
  // the window gone first) is null for the parent as well.
  it("reloading during the viewfinder ends the query with null, in under 1 s", async () => {
    await open("/");
    const a = await arm();
    const t0 = Date.now();
    await m.execute(`${B}.reload();`);
    const r = await a.result();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r).not.toBe("pending");
    if (typeof r !== "string") expect("e" in r ? r.e : r.r).toSatisfy((v: unknown) => v === null || /AbortError/.test(String(v)));
  });

  // design.spec.ts:186
  it("same-document navigation: after stop, the next click reaches the page", async () => {
    await open("/");
    const a = await arm();
    await inPage(`history.pushState({}, "", "/x"); return 1;`);
    // The chrome service's answer to LOCATION_CHANGE_SAME_DOCUMENT (plan 35b): stop.
    await stopActor(m, B);
    expect(await a.result()).toEqual({ r: null });
    expect(await hosts()).toBe(0);
    await trustedMouse(m, B, "#email");
    await expect.poll(async () => (await pageLog(m, B)).reactions, { timeout: 10_000 }).toContain("click:email");
  });

  // design.spec.ts:201
  it("middle click, right click and double click do not reach the page; no new tab", async () => {
    await open("/");
    const tabs = await m.execute<number>("return gBrowser.tabs.length;");
    const a = await arm();
    await trustedMouse(m, B, "#lien", { button: 1 });
    await trustedMouse(m, B, "#lien", { button: 2 });
    await sleep(300);
    expect((await pageLog(m, B)).reactions).toEqual([]);
    expect(await inPage("return location.href;")).toBe(`${servers.page}/`);
    expect(await a.result(200)).toBe("pending");
    await trustedMouse(m, B, "#envoyer", { count: 2 });
    expect(((await a.result()) as { r?: { selecteur: string } }).r?.selecteur).toBe("#envoyer");
    await sleep(300);
    expect((await pageLog(m, B)).reactions).toEqual([]);
    expect(await m.execute("return gBrowser.tabs.length;")).toBe(tabs);
  });

  // design.spec.ts:221
  it("a click made by the page captures nothing, an Escape made by the page cancels nothing", async () => {
    await open("/");
    const a = await arm();
    await inPage(`document.querySelector("li").click(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); document.querySelector("#envoyer").dispatchEvent(new MouseEvent("click", { bubbles: true })); return 1;`);
    await sleep(300);
    expect(await hosts()).toBe(1);
    expect(await a.result(100)).toBe("pending");
    await trustedMouse(m, B, "#email");
    expect(((await a.result()) as { r?: { selecteur: string } }).r?.selecteur).toBe("#email");
  });

  it("hostile page: window capture listeners set before arming see nothing", async () => {
    await open("/hooks");
    // Points measured before arming (the page hooks getBoundingClientRect), then its log emptied.
    const at = { email: await center(m, B, "#email"), lien: await center(m, B, "#lien"), envoyer: await center(m, B, "#envoyer") };
    await clearLog(m, B);
    const tabs = await m.execute<number>("return gBrowser.tabs.length;");
    const a = await armActor(m, B);
    await sleep(200);
    await trustedMouse(m, B, at.email, { move: true });
    await trustedMouse(m, B, at.lien, { button: 1 });
    await trustedMouse(m, B, at.lien, { button: 2 });
    await sleep(200);
    const midRight = await pageLog(m, B);
    await trustedMouse(m, B, at.envoyer, { count: 2 });
    const c = (await a.result()) as { r?: { selecteur: string } };
    await sleep(300);
    const page = await pageLog(m, B);
    expect(c.r?.selecteur).toBe("#envoyer");
    for (const p of [midRight, page]) {
      expect(p.early).toEqual([]);
      expect(p.docEarly).toEqual([]);
      expect(p.reactions).toEqual([]);
    }
    expect(page.hooked).toEqual([]);
    expect(page.fakeStop).toBe(0);
    expect(await m.execute("return gBrowser.tabs.length;")).toBe(tabs);
    expect(await inPage("return location.href;")).toBe(`${servers.page}/hooks`);
  });

  it("the guard is gone 500 ms after a capture, after stop and after a reload: the next click reaches the page", async () => {
    await open("/hooks");
    const reaches = async () => {
      await clearLog(m, B);
      await trustedMouse(m, B, "#email");
      await expect.poll(async () => (await pageLog(m, B)).early, { timeout: 10_000 }).toContain("click:true");
      expect((await pageLog(m, B)).reactions).toContain("click:email");
    };
    let a = await arm();
    await trustedMouse(m, B, "#email");
    expect(((await a.result()) as { r?: { selecteur: string } }).r?.selecteur).toBe("#email");
    await afterSwallow();
    await reaches();
    a = await arm();
    await stopActor(m, B);
    expect(await a.result()).toEqual({ r: null });
    await reaches();
    a = await arm();
    await m.execute(`${B}.reload();`);
    expect(await a.result()).not.toBe("pending");
    await waitFor(m, `return !${B}.webProgress.isLoadingDocument && !!${B}.browsingContext.currentWindowGlobal`, (v) => v === true);
    await sleep(300);
    await reaches();
  });

  // didDestroy does not fire for a page kept in the bfcache: pagehide ends the viewfinder and its guard.
  it("leaving into the bfcache ends the viewfinder: after Back, no viewfinder and clicks reach the page", async () => {
    await open("/hooks");
    await inPage("window.kept = 1; return 1;");
    const a = await arm();
    await inPage(`location.href = "/hooks?next"; return 1;`);
    await waitFor(m, `return ${B}.currentURI.spec.endsWith("/hooks?next") && !${B}.webProgress.isLoadingDocument;`, (v) => v === true);
    expect(await a.result()).toEqual({ r: null });
    await m.execute(`${B}.goBack();`);
    await waitFor(m, `return ${B}.currentURI.spec.endsWith("/hooks") && !${B}.webProgress.isLoadingDocument;`, (v) => v === true);
    // The very document, restored from the bfcache (a reload would have lost `kept`).
    expect(await inPage("return window.kept;")).toBe(1);
    expect(await hosts()).toBe(0);
    await clearLog(m, B);
    await trustedMouse(m, B, "#lien", { button: 1 });
    await trustedMouse(m, B, "#email");
    await expect.poll(async () => (await pageLog(m, B)).reactions, { timeout: 10_000 }).toContain("click:email");
    expect((await pageLog(m, B)).early).toEqual(expect.arrayContaining(["auxclick:true", "click:true"]));
  });

  it("stop ends the swallow after a capture at once; a pick that throws stops the viewfinder", async () => {
    await open("/hooks");
    let a = await arm();
    await trustedMouse(m, B, "#email");
    expect(((await a.result()) as { r?: { selecteur: string } }).r?.selecteur).toBe("#email");
    await stopActor(m, B);
    await clearLog(m, B);
    await trustedMouse(m, B, "#email");
    // Well inside the 500 ms swallow.
    await sleep(100);
    expect((await pageLog(m, B)).reactions).toContain("click:email");
    await afterSwallow();
    a = await armActor(m, B, `globalThis.__viseurChoisir = () => { throw new Error("pick"); }; new Promise((ok) => (globalThis.__viseurArret = () => ok(null)))`);
    await sleep(100);
    await trustedMouse(m, B, "#envoyer");
    expect(await a.result()).toEqual({ r: null });
    await clearLog(m, B);
    await trustedMouse(m, B, "#email");
    await expect.poll(async () => (await pageLog(m, B)).reactions, { timeout: 10_000 }).toContain("click:email");
  });

  it("two tabs in one process: arming A guards nothing in B", async () => {
    await open("/hooks");
    await m.execute("window.__designTabA = gBrowser.selectedTab;");
    const a = await arm();
    await open("/hooks");
    const proc = (b: string) => m.execute(`return [${b}.remoteType, ${b}.browsingContext.currentWindowGlobal.osPid];`);
    expect(await proc("window.__designTabA.linkedBrowser")).toEqual(await proc(B));
    await clearLog(m, B);
    await trustedMouse(m, B, "#email");
    await expect.poll(async () => (await pageLog(m, B)).reactions, { timeout: 10_000 }).toContain("click:email");
    expect(await hosts()).toBe(0);
    await m.execute("gBrowser.selectedTab = window.__designTabA;");
    await waitFor(m, "return gBrowser.selectedTab === window.__designTabA;", (v) => v === true);
    await sleep(200);
    expect(await hosts()).toBe(1);
    await trustedMouse(m, B, "#envoyer");
    expect(((await a.result()) as { r?: { selecteur: string } }).r?.selecteur).toBe("#envoyer");
  });

  it("a trusted Escape stops and never reaches the page; other keys do", async () => {
    await open("/hooks");
    await clearLog(m, B);
    const a = await arm();
    await pressKeys(m, "a");
    await sleep(100);
    expect(await a.result(100)).toBe("pending");
    await pressKeys(m, "Escape");
    expect(await a.result()).toEqual({ r: null });
    expect((await pageLog(m, B)).keys).toEqual(["a:true"]);
    expect(await hosts()).toBe(0);
  });

  it("the CSP page (strict CSP, Trusted Types) is captured", async () => {
    await open("/csp");
    const a = await arm();
    await trustedMouse(m, B, "#b");
    const c = cleanCapture(((await a.result()) as { r?: unknown }).r);
    expect(c?.selecteur).toBe("#b");
    expect(Object.keys(c?.styles ?? {})).toHaveLength(26);
    expect(await hosts()).toBe(0);
  });

  it("the viewfinder runs in a webIsolated process and sees no chrome", async () => {
    await open("/");
    expect(await m.execute(`return ${B}.remoteType;`)).toMatch(/^webIsolated/);
    const a = await armActor(m, B, "({ Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services, gBrowser: typeof gBrowser, pageSecret: typeof pageSecret, Cu: typeof Cu, docShell: typeof window.docShell })");
    expect(await a.result()).toEqual({ r: { Components: "undefined", ChromeUtils: "undefined", Services: "undefined", gBrowser: "undefined", pageSecret: "undefined", Cu: "undefined", docShell: "undefined" } });
    // The page itself has it: the sandbox does not see the page's own globals.
    expect(await inPage("return typeof (window.wrappedJSObject ?? window).pageSecret;")).toBe("string");
  });

  it("a cross-origin frame is guarded: its window capture listeners see nothing", async () => {
    await open("/oop");
    await waitFor(m, `const c = ${B}.browsingContext.children[0]?.currentWindowGlobal; return !!c && c.documentURI.spec.startsWith(${JSON.stringify(servers.frame)}) && !${B}.webProgress.isLoadingDocument;`, (v) => v === true);
    // Another process: its own chrome event handler, which the top window's guard does not cover.
    expect(await m.execute(`const t = ${B}.browsingContext.currentWindowGlobal, f = ${B}.browsingContext.children[0].currentWindowGlobal; return [f.isProcessRoot, f.osPid !== t.osPid];`)).toEqual([true, true]);
    // Not in the top window: arm answers null; not in a frame: guard does nothing.
    expect(await askActor(m, B, "arm", { code: "1" }, 0)).toBeNull();
    expect(await askActor(m, B, "guard")).toBe(false);
    // The witness: the top window armed, the frame unguarded: the frame sees the click, the top's guard does not.
    const a = await arm();
    await trustedMouse(m, B, "#dans", { frame: 0 });
    await expect.poll(async () => (await pageLog(m, B, 0)).early, { timeout: 10_000 }).toContain("click:true");
    expect(await a.result(100)).toBe("pending");
    await clearLog(m, B, 0);
    expect(await guardFrame(m, B, 0)).toBe(true);
    await trustedMouse(m, B, "#dans", { frame: 0 });
    await trustedMouse(m, B, "#dans", { frame: 0, button: 1 });
    await trustedMouse(m, B, "#dans", { frame: 0, count: 2 });
    await sleep(300);
    expect((await pageLog(m, B, 0)).early).toEqual([]);
    expect(await a.result(100)).toBe("pending");
    // A frame of another site added while armed: guarded the same way (plan 35b guards it on window-global-created).
    await inPage(`const f = document.createElement("iframe"); f.src = ${JSON.stringify(`${servers.frame}/frame`)}; f.style.cssText = "width:300px;height:120px;border:0"; document.body.append(f); return 1;`);
    await waitFor(m, `const c = ${B}.browsingContext.children[1]?.currentWindowGlobal; return !!c && c.documentURI.spec.startsWith(${JSON.stringify(servers.frame)}) && c.isProcessRoot;`, (v) => v === true);
    await sleep(200);
    expect(await guardFrame(m, B, 1)).toBe(true);
    await clearLog(m, B, 1);
    await trustedMouse(m, B, "#dans", { frame: 1 });
    await sleep(300);
    expect((await pageLog(m, B, 1)).early).toEqual([]);
    expect(await a.result(100)).toBe("pending");
    // Unguarded, the click reaches the frame again; the top's viewfinder is still waiting.
    expect(await unguardFrame(m, B, 0)).toBe(true);
    await trustedMouse(m, B, "#dans", { frame: 0 });
    await expect.poll(async () => (await pageLog(m, B, 0)).early, { timeout: 10_000 }).toContain("click:true");
    expect(await a.result(100)).toBe("pending");
    await stopActor(m, B);
    expect(await a.result()).toEqual({ r: null });
  });

  // Review Focus 5.
  it("a guarded cross-origin frame that reloads gets its clicks back", async () => {
    await open("/oop");
    await waitFor(m, `const c = ${B}.browsingContext.children[0]?.currentWindowGlobal; return !!c && c.documentURI.spec.startsWith(${JSON.stringify(servers.frame)}) && !${B}.webProgress.isLoadingDocument;`, (v) => v === true);
    expect(await guardFrame(m, B, 0)).toBe(true);
    await clearLog(m, B, 0);
    await trustedMouse(m, B, "#dans", { frame: 0 });
    await sleep(300);
    expect((await pageLog(m, B, 0)).early).toEqual([]);
    const before = await m.execute<number>(`return ${B}.browsingContext.children[0].currentWindowGlobal.innerWindowId;`);
    await inBrowser(m, B, "location.reload(); return 1;", { frame: 0 });
    await waitFor(m, `const c = ${B}.browsingContext.children[0]?.currentWindowGlobal; return !!c && c.innerWindowId !== ${before} && c.documentURI.spec.startsWith(${JSON.stringify(servers.frame)});`, (v) => v === true);
    await sleep(300);
    await trustedMouse(m, B, "#dans", { frame: 0 });
    await expect.poll(async () => (await pageLog(m, B, 0)).early, { timeout: 10_000 }).toContain("click:true");
  });
});
