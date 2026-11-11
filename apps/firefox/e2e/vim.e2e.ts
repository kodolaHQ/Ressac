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

// Plan 50 Tasks 4-5: the vim mode's actor (WebAiOsVim): scrolling, history, tabs, link hints, find; never in a field
// nor outside web tabs.

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

// Ten visible links (more than the nine home-row letters), and four that get no label: hidden, invisible, below and left
// of the viewport. Its CSP allows only its own nonce'd style: the labels' style must still apply.
const HINTS = `<!doctype html><meta charset="utf-8"><title>liens</title>
<style nonce="n0">body{margin:0;height:4000px} .l{display:block;margin:6px} #none{display:none} #invisible{visibility:hidden}
#below{position:absolute;top:3000px} #left{position:absolute;left:-500px;top:10px}</style>
${Array.from({ length: 10 }, (_, i) => `<a id="l${i}" class="l" href="/vim2?n=${i}">lien ${i}</a>`).join("")}
<a id="none" href="/vim2?n=none">caché</a><a id="invisible" href="/vim2?n=invisible">invisible</a>
<a id="below" href="/vim2?n=below">en bas</a><a id="left" href="/vim2?n=left">à gauche</a>`;
// No link; a tall page.
const NO_LINKS = `<!doctype html><meta charset="utf-8"><title>sans liens</title><body style="margin:0;height:6000px"><p>rien</p>`;
// The body does not scroll; a full-height inner box does (a web app's layout, such as Gmail's).
const INNER = `<!doctype html><meta charset="utf-8"><title>boîte</title>
<style>html,body{margin:0;height:100%;overflow:hidden}#inner{height:100%;overflow:auto}#inner>div{height:5000px}</style>
<div id="inner"><div>contenu</div></div>`;

const send = (body: string, headers: Record<string, string> = {}) => (_req: unknown, res: ServerResponse) =>
  void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers }).end(body);

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
const dirs: string[] = [];

beforeAll(async () => {
  server = await startServer({ routes: { "/vim": send(PAGE), "/vim2": send(PAGE), "/hints": send(HINTS, { "Content-Security-Policy": "style-src 'nonce-n0'" }), "/nolinks": send(NO_LINKS), "/inner": send(INNER) } });
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
/** The labels shown (a closed shadow root: read with chrome privileges), each with the id of the link at its place. */
const hints = () =>
  inBrowser<{ label: string; link: string | null; position: string }[] | null>(
    m,
    B,
    `const root = [...document.documentElement.children].map((e) => e.openOrClosedShadowRoot).find((r) => r?.querySelector(".hint"));
     if (!root) return null;
     return [...root.querySelectorAll(".hint:not(.gone)")].map((h) => {
       const r = h.getBoundingClientRect();
       const link = [...document.querySelectorAll("a")].find((a) => { const b = a.getBoundingClientRect(); return Math.abs(b.left - r.left) < 1 && Math.abs(b.top - r.top) < 1; });
       return { label: h.textContent, link: link?.id ?? null, position: getComputedStyle(h).position };
     });`,
    { system: true },
  );
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

describe("vim mode: hints, find, inner scrolling", () => {
  beforeEach(async () => {
    await setVim(true);
  });

  it("f labels each visible link with short, distinct home-row labels; typing one follows it", async () => {
    await open("/hints");
    await pressKeys(m, "f");
    await expect.poll(hints).not.toBeNull();
    const shown = (await hints())!;
    expect(shown.map((h) => h.link).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `l${i}`).sort());
    const labels = shown.map((h) => h.label);
    expect(new Set(labels).size).toBe(10);
    for (const l of labels) expect(l).toMatch(/^[asdfghjkl]{1,2}$/);
    // None is the start of another; 8 of one letter, 2 of two (breadth-first).
    for (const a of labels) for (const b of labels) if (a !== b) expect(b.startsWith(a)).toBe(false);
    expect(labels.filter((l) => l.length === 1)).toHaveLength(8);
    // The page's CSP (style-src 'none') does not reach the labels' style.
    expect(shown[0]!.position).toBe("absolute");
    await typeText(m, shown.find((h) => h.link === "l3")!.label);
    await waitFor(m, `return ${B}.currentURI.spec`, (v: string) => v.endsWith("/vim2?n=3"));
  });

  it("F opens the link in a new tab of the same space, in the background", async () => {
    const id = await open("/hints");
    await pressKeys(m, "F");
    await expect.poll(hints).not.toBeNull();
    const label = (await hints())!.find((h) => h.link === "l5")!.label;
    const before = new Set(Object.keys((await state(m)).tabs));
    await typeText(m, label);
    await expect.poll(async () => Object.values((await state(m)).tabs).find((t) => !before.has(t.id))?.url).toBe(`${server.url}/vim2?n=5`);
    const s = await state(m);
    const added = Object.values(s.tabs).find((t) => !before.has(t.id))!;
    expect(added.spaceId).toBe(s.tabs[id]!.spaceId);
    expect(await url()).toBe(`${server.url}/hints`);
    await expect.poll(hints).toBeNull();
  });

  it("Escape and a scroll remove the labels", async () => {
    await open("/hints");
    await pressKeys(m, "f");
    await expect.poll(hints).not.toBeNull();
    await pressKeys(m, "Escape");
    await expect.poll(hints).toBeNull();
    await pressKeys(m, "f");
    await expect.poll(hints).not.toBeNull();
    await inPage("window.scrollTo(0, 100); return 1;");
    await expect.poll(hints).toBeNull();
  });

  it("with motion, the labels fade out, then leave the page", async () => {
    await m.execute(`Services.prefs.setIntPref("ui.prefersReducedMotion", 0);`);
    try {
      await open("/hints");
      await pressKeys(m, "f");
      await expect.poll(hints).not.toBeNull();
      await pressKeys(m, "Escape");
      await expect.poll(hints).toBeNull();
    } finally {
      await m.execute(`Services.prefs.setIntPref("ui.prefersReducedMotion", 1);`);
    }
  });

  it("f on a page without visible links shows nothing and leaves hint mode", async () => {
    await open("/nolinks");
    await pressKeys(m, "f");
    await sleep(300);
    expect(await hints()).toBeNull();
    await pressKeys(m, "j");
    await expect.poll(scrollY).toBeGreaterThan(0);
  });

  it("/ opens Firefox's find bar with the focus in it", async () => {
    await open();
    await pressKeys(m, "/");
    await waitFor(m, "const f = gBrowser.getCachedFindBar(); return !!f && !f.hidden && document.activeElement === f._findField", (v) => v === true);
    await pressKeys(m, "Escape");
    await waitFor(m, "return gBrowser.getCachedFindBar().hidden", (v) => v === true);
  });

  it("j scrolls the inner box when the window cannot scroll", async () => {
    await open("/inner");
    await pressKeys(m, "j");
    await expect.poll(() => inPage<number>("return document.getElementById('inner').scrollTop;")).toBe(60);
    await pressKeys(m, "G");
    await expect.poll(() => inPage<boolean>("const e = document.getElementById('inner'); return e.scrollTop + e.clientHeight >= e.scrollHeight - 1;")).toBe(true);
    await typeText(m, "gg");
    await expect.poll(() => inPage<number>("return document.getElementById('inner').scrollTop;")).toBe(0);
    expect(await scrollY()).toBe(0);
  });
});

/** The window's displayed tab. */
const shown = async () => {
  const f = (await state(m)).windows[0]!;
  return f.active[f.activeSpace];
};
const activeSpace = async () => (await state(m)).windows[0]!.activeSpace;
/** Keyboard back on the displayed page, its actor ready. */
async function backToPage() {
  await waitFor(m, `return !${B}.webProgress.isLoadingDocument`, (v) => v === true);
  await m.execute(`${B}.focus();`);
  await actorReady();
}
let spaceCount = 0;
/** A new space with three tabs (its own order, whatever earlier cases left), the last one shown: /vim?<space>-<1..3>. */
async function threeTabs(): Promise<string[]> {
  const windowId = (await state(m)).windows[0]!.id;
  const n = ++spaceCount;
  await dispatch(m, { type: "createSpace", name: `Vim ${n}`, icon: "⌨️", private: false, profile: "default", windowId });
  return [await open(`/vim?${n}-1`), await open(`/vim?${n}-2`), await open(`/vim?${n}-3`)];
}
const commandField = () =>
  waitUi(m, "return doc.activeElement?.dataset.testid === 'command-input' && document.activeElement === document.getElementById('webaios-sidebar')");
const commandValue = () => inUi<string>(m, "return doc.querySelector('[data-testid=\"command-input\"]').value");

describe("vim mode: tabs and spaces", () => {
  beforeEach(async () => {
    await setVim(true);
  });
  // Back to one space: with several, the sidebar's footer trades the Settings button for the spaces (later cases click it).
  afterAll(async () => {
    for (const e of (await state(m)).spaces.slice(1)) await dispatch(m, { type: "deleteSpace", id: e.id });
  });

  it("J / K and gT / gt walk the sidebar's order, wrapping; g0 / g$ go to the ends", async () => {
    const [a, b, c] = await threeTabs();
    await pressKeys(m, "J");
    await expect.poll(shown).toBe(b);
    // The keyboard follows the tab: no refocusing between keys.
    await actorReady();
    await pressKeys(m, "J");
    await expect.poll(shown).toBe(a);
    await backToPage();
    await pressKeys(m, "K");
    await expect.poll(shown).toBe(b);
    await backToPage();
    await typeText(m, "gt");
    await expect.poll(shown).toBe(c);
    await backToPage();
    await pressKeys(m, "K"); // from the last, wraps to the first
    await expect.poll(shown).toBe(a);
    await backToPage();
    await typeText(m, "gT"); // and back
    await expect.poll(shown).toBe(c);
    await backToPage();
    await typeText(m, "g0");
    await expect.poll(shown).toBe(a);
    await backToPage();
    await typeText(m, "g$");
    await expect.poll(shown).toBe(c);
  });

  it("x then X brings the closed tab back", async () => {
    await threeTabs();
    const last = `${server.url}/vim?${spaceCount}-3`;
    const has = async () => Object.values((await state(m)).tabs).some((t) => t.url === last);
    await pressKeys(m, "x");
    await expect.poll(has).toBe(false);
    await backToPage();
    await pressKeys(m, "X");
    await expect.poll(has).toBe(true);
  });

  it("t opens the command bar, o the address bar, each with the focus", async () => {
    await open();
    await pressKeys(m, "t");
    await commandField();
    expect(await commandValue()).toBe("");
    await pressKeys(m, "Escape");
    await waitUi(m, "return !doc.querySelector('[data-testid=\"command-bar\"]')");
    await backToPage();
    await pressKeys(m, "o");
    await commandField();
    expect(await commandValue()).toBe(`${server.url}/vim`);
    await pressKeys(m, "Escape");
    await waitUi(m, "return !doc.querySelector('[data-testid=\"command-bar\"]')");
  });

  it("gs / gS show the next / previous space, wrapping", async () => {
    await threeTabs();
    const windowId = (await state(m)).windows[0]!.id;
    const spaces = (await state(m)).spaces.map((e) => e.id);
    // A web page in the first space too: the keys need one to land in.
    await dispatch(m, { type: "activateSpace", windowId, id: spaces[0]! });
    await open();
    await typeText(m, "gS"); // from the first, the last
    await expect.poll(activeSpace).toBe(spaces.at(-1));
    await backToPage();
    await typeText(m, "gs"); // from the last, the first
    await expect.poll(activeSpace).toBe(spaces[0]);
    await backToPage();
    await typeText(m, "gs");
    await expect.poll(activeSpace).toBe(spaces[1]);
  });

  it("in a field JKtoX is typed; with the mode off, none of these keys does anything", async () => {
    await threeTabs();
    const before = await state(m);
    const id = await shown();
    await inPage("document.getElementById('in').focus(); return 1;");
    await typeText(m, "JKtoX");
    expect(await inPage<string>("return document.getElementById('in').value;")).toBe("JKtoX");
    await setVim(false);
    await m.execute(`${B}.focus();`);
    await actorReady();
    await inPage("document.activeElement.blur(); return 1;");
    for (const k of ["J", "K", "X", "t", "o"]) await pressKeys(m, k);
    await typeText(m, "gtgsg0");
    await sleep(500);
    const after = await state(m);
    expect(await shown()).toBe(id);
    expect(after.windows[0]!.activeSpace).toBe(before.windows[0]!.activeSpace);
    expect(Object.keys(after.tabs).length).toBe(Object.keys(before.tabs).length);
    expect(await inUi(m, "return !!doc.querySelector('[data-testid=\"command-bar\"]')")).toBe(false);
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
