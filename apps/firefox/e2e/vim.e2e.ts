import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openTab, testActor } from "./agent-extensions";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inBrowser } from "./sites";
import { click, inUi, pressKeys, typeText, waitUi } from "./ui";

// Plan 50 Task 4: the vim mode's actor (WebAiOsVim): scrolling, history, tabs, never in a field nor outside web tabs.

const B = "gBrowser.selectedBrowser";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A long, wide page that notes every key its window sees first (capture) and counts its loads in sessionStorage.
const PAGE = `<!doctype html><meta charset="utf-8"><title>vim</title>
<style>body{margin:0;height:6000px;width:4000px}</style>
<script>
  sessionStorage.loads = String(Number(sessionStorage.loads || 0) + 1);
  for (const t of ["keydown", "keypress", "keyup"]) addEventListener(t, (e) => { document.documentElement.dataset.seen = (document.documentElement.dataset.seen || "") + t + ":" + e.key + " "; }, true);
</script>
<a id="next" href="/vim2">suivant</a>
<input id="in"><textarea id="ta"></textarea><div id="ce" contenteditable="true"></div><div id="host"></div>
<script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<input id="sin">';</script>`;

const send = (body: string) => (_req: unknown, res: ServerResponse) => void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const dirs: string[] = [];

beforeAll(async () => {
  server = await startServer({ routes: { "/vim": send(PAGE), "/vim2": send(PAGE) } });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  const profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  dirs.push(dataDir, profile);
  const a = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: a.env, prefs: { ...a.prefs, "browser.navigation.requireUserInteraction": false } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
}, 120_000);
afterAll(async () => {
  await w?.close();
  await server?.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const inPage = <T = unknown>(script: string) => inBrowser<T>(m, B, script);
const setVim = (enabled: boolean) => dispatch(m, { type: "setVimMode", enabled });
/** The page's actor has asked its mode (its parent exists), and the answer had time to come back. */
async function actorReady() {
  await waitFor(m, `return !!${B}.browsingContext.currentWindowGlobal?.getExistingActor("WebAiOsVim")`, (v) => v === true);
  await sleep(200);
}
/** Opens `p` in a new tab, focused on its body; returns the tab id. */
async function open(p = "/vim"): Promise<string> {
  const id = await openTab(m, `${server.url}${p}`);
  await m.execute(`${B}.focus();`);
  await actorReady();
  return id;
}
const scrollY = () => inPage<number>("return window.scrollY;");
const seen = () => inPage<string>("return document.documentElement.dataset.seen ?? '';");
const url = () => m.execute<string>(`return ${B}.currentURI.spec;`);
const clipboardText = () =>
  m.execute<string>(`const t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
    t.init(null); t.addDataFlavor("text/plain");
    Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard, window.browsingContext.currentWindowContext);
    const o = {}; try { t.getTransferData("text/plain", o); } catch { return ""; }
    return o.value.QueryInterface(Ci.nsISupportsString).data;`);

describe("vim mode on", () => {
  beforeEach(async () => {
    await setVim(true);
  });

  it("j, k, G, gg, d, u scroll; the page never sees the keys taken", async () => {
    await open();
    const half = (await inPage<number>("return window.innerHeight;")) / 2;
    await pressKeys(m, "j");
    await expect.poll(scrollY).toBeGreaterThan(0);
    const one = await scrollY();
    await pressKeys(m, "j");
    await expect.poll(scrollY).toBe(2 * one);
    await pressKeys(m, "k");
    await expect.poll(scrollY).toBe(one);
    await pressKeys(m, "G");
    await expect.poll(() => inPage<boolean>("return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1;")).toBe(true);
    await typeText(m, "gg");
    await expect.poll(scrollY).toBe(0);
    await pressKeys(m, "d");
    await expect.poll(scrollY).toBeGreaterThan(0);
    expect(Math.abs((await scrollY()) - half)).toBeLessThanOrEqual(2);
    await pressKeys(m, "u");
    await expect.poll(scrollY).toBe(0);
    await pressKeys(m, "l");
    await expect.poll(() => inPage<number>("return window.scrollX;")).toBeGreaterThan(0);
    await pressKeys(m, "h");
    await expect.poll(() => inPage<number>("return window.scrollX;")).toBe(0);
    // Not one keydown, keypress or keyup of those reached the page's own capture listener on window.
    expect(await seen()).toBe("");
    // A key outside the table, and one with ⌃, pass untouched.
    await pressKeys(m, "q");
    await pressKeys(m, "Control+j");
    await expect.poll(seen).toContain("keydown:q");
    expect(await seen()).toContain("keydown:j");
  });

  it("without reduced motion, j scrolls smoothly to the same place", async () => {
    await m.execute(`Services.prefs.setIntPref("ui.prefersReducedMotion", 0);`);
    try {
      await open();
      await pressKeys(m, "j");
      await expect.poll(scrollY).toBe(60);
    } finally {
      await m.execute(`Services.prefs.setIntPref("ui.prefersReducedMotion", 1);`);
    }
  });

  it("a lone g is dropped after 1 s; Escape drops it too", async () => {
    await open();
    await pressKeys(m, "j");
    await expect.poll(scrollY).toBeGreaterThan(0);
    await pressKeys(m, "g");
    await sleep(1_200);
    await pressKeys(m, "g");
    await sleep(300);
    expect(await scrollY()).toBeGreaterThan(0);
    await pressKeys(m, "Escape"); // drops the g pending above
    await pressKeys(m, "g");
    await sleep(300);
    expect(await scrollY()).toBeGreaterThan(0);
    // With nothing pending (the last g has expired), Escape is the page's.
    await sleep(1_200);
    await pressKeys(m, "Escape");
    await expect.poll(seen).toContain("keydown:Escape");
  });

  it("in a field (input, textarea, contenteditable, shadow input) jkG is typed and nothing scrolls", async () => {
    await open();
    for (const [focus, read] of [
      ["document.getElementById('in').focus()", "return document.getElementById('in').value;"],
      ["document.getElementById('ta').focus()", "return document.getElementById('ta').value;"],
      ["document.getElementById('ce').focus()", "return document.getElementById('ce').textContent;"],
      ["document.getElementById('host').shadowRoot.getElementById('sin').focus()", "return document.getElementById('host').shadowRoot.getElementById('sin').value;"],
    ]) {
      await inPage(`${focus}; return 1;`);
      await typeText(m, "jkG");
      expect(await inPage<string>(read!)).toBe("jkG");
      expect(await scrollY()).toBe(0);
    }
  });

  it("H goes back, L forward, r reloads", async () => {
    await open();
    await inPage("location.href = '/vim2'; return 1;");
    await waitFor(m, `return ${B}.currentURI.spec.endsWith("/vim2") && !${B}.webProgress.isLoadingDocument`, (v) => v === true);
    await m.execute(`${B}.focus();`);
    await actorReady();
    await pressKeys(m, "H");
    await waitFor(m, `return ${B}.currentURI.spec`, (v: string) => v.endsWith("/vim"));
    await m.execute(`${B}.focus();`);
    await actorReady();
    await pressKeys(m, "L");
    await waitFor(m, `return ${B}.currentURI.spec`, (v: string) => v.endsWith("/vim2"));
    await m.execute(`${B}.focus();`);
    await actorReady();
    const loads = Number(await inPage<string>("return sessionStorage.loads;"));
    await pressKeys(m, "r");
    await expect.poll(() => inPage<string>("return sessionStorage.loads;").catch(() => "0"), { timeout: 10_000 }).toBe(String(loads + 1));
  });

  it("yy copies the address, x closes the tab", async () => {
    const id = await open();
    await typeText(m, "yy");
    await expect.poll(clipboardText).toBe(`${server.url}/vim`);
    await pressKeys(m, "x");
    await expect.poll(async () => !!(await state(m)).tabs[id], { timeout: 10_000 }).toBe(false);
  });
});

describe("vim mode off, or outside web tabs", () => {
  it("off (the default): j reaches the page and nothing scrolls", async () => {
    await setVim(false);
    await open();
    await pressKeys(m, "j");
    await expect.poll(seen).toContain("keydown:j");
    expect(await scrollY()).toBe(0);
  });

  it("turned off while a page is open: that page lets j through", async () => {
    await setVim(true);
    await open();
    await setVim(false);
    await sleep(200);
    await pressKeys(m, "j");
    await expect.poll(seen).toContain("keydown:j");
    expect(await scrollY()).toBe(0);
  });

  it("Settings and the agent's terminal get j untouched", async () => {
    await setVim(true);
    await open();
    await click(m, '[data-testid="settings-button"]');
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"settings-nav-shortcuts\"]')");
    await inUi(m, "ui.vimSeen = []; ui.addEventListener('keydown', (e) => ui.vimSeen.push(e.key + ':' + e.defaultPrevented), true); ui.focus(); return 1;");
    await pressKeys(m, "j");
    await waitUi(m, "return ui.vimSeen.includes('j:false')");

    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${server.url}/vim` });
    await waitFor(m, `return ${B}.currentURI.spec.endsWith("/vim") && !${B}.webProgress.isLoadingDocument`, (v) => v === true);
    await m.execute(`${B}.focus();`);
    await pressKeys(m, "Meta+j");
    await waitUi(m, "return doc.activeElement?.classList.contains('xterm-helper-textarea')", [], 20_000, "agent");
    await typeText(m, "jjk");
    await pressKeys(m, "Enter");
    const input = path.join(w.dataDir, "workspace", "fake-agent-input.txt");
    await expect.poll(() => (existsSync(input) ? readFileSync(input, "utf8") : ""), { timeout: 10_000 }).toContain("jjk");
    expect(await scrollY()).toBe(0);
  });
});
