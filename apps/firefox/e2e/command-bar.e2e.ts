import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BrowserState } from "../shared/model";
import { dispatch, state, waitFor } from "./firefox";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { writeAction } from "./actions";
import { testActor } from "./agent-extensions";
import { SITE_HOME, resolveLocalHosts, siteWindowCount, startSitesServer, writeSite } from "./sites";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { click, inUi, missingApi, pixel, pressKeys, typeText, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
const kept: string[] = [];
afterAll(async () => {
  await server?.close();
  for (const d of kept) await rm(d, { recursive: true, force: true });
});
beforeEach(async () => {
  w = await launchWebAiOs();
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
});
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
  }
});

const win = async () => (await state(m)).windows[0]!;
const activeId = async () => {
  const f = await win();
  return f.active[f.activeSpace] ?? null;
};
async function open(path: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const after = await dispatch(m, { type: "openTab", windowId: (await win()).id, url: server.url + path });
  return Object.keys(after.tabs).find((id) => !before.has(id))!;
}
async function waitState<T>(read: (s: BrowserState) => T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read(await state(m));
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const waitTitle = (id: string, title: string) => waitState((s) => s.tabs[id]?.title, (t) => t === title);
const waitBar = (open: boolean) => waitUi(m, "return !!doc.querySelector('[data-testid=\"command-bar\"]') === arguments[0]", [open]);
/** The bar's field has the keyboard: focused in the UI, and the UI iframe focused in the window. */
const fieldFocused = () =>
  waitUi(m, "return doc.activeElement?.dataset.testid === 'command-input' && document.activeElement === document.getElementById('webaios-sidebar')");
const fieldValue = () => inUi<string>(m, "return doc.querySelector('[data-testid=\"command-input\"]').value");
async function type(text: string): Promise<void> {
  await fieldFocused();
  await inUi(m, `const f = doc.activeElement; f.value = arguments[0]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [text]);
}
const selectedType = () => inUi<string | undefined>(m, "return doc.querySelector('[data-testid=\"command-row\"][aria-selected=\"true\"]')?.dataset.type");
/** The history has `part` (a visit is noted a moment after the load). */
const visited = (part: string) =>
  waitUi(m, "return (await ui.webaios.history.search(arguments[0], 5, true)).length > 0", [part], 15_000);
async function withPageA(): Promise<string> {
  const a = await open("/a.html");
  await waitTitle(a, "Page A");
  return a;
}

/** The empty page's field has the keyboard. */
const emptyPageFocused = () =>
  waitUi(m, "return doc.activeElement?.dataset.testid === 'empty-page-input' && document.activeElement === document.getElementById('webaios-sidebar')");
const veilClick = () => inUi(m, `for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, 5, 5, { button: 0, clickCount: 1 });`);
/** A click in the bar's box margin, off the field and the lines (6, 6: Gecko hit-tests 3, 3 outside the 12 px rounded corner). */
const marginClick = () =>
  inUi(
    m,
    `const r = doc.querySelector('[data-testid="command-bar"]').getBoundingClientRect();
     for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, r.left + 6, r.top + 6, { button: 0, clickCount: 1 });`,
  );
const cardInFocus = () => inUi<boolean>(m, "return !!doc.activeElement?.closest('[data-testid=\"request-modal\"]')");
/** The agent is up and a user tab (not shared with it) is shown: what makes it ask to read the tab. */
async function withAgentAndTab(): Promise<string> {
  const config = join(w.dataDir, "workspace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
  // The home page's panel starts the agent's session, which takes back every access: the tool is called after it.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
  const id = await open("/texte.html");
  await waitTitle(id, "Texte");
  return id;
}
/** The agent asks to read the tab; the promise never rejects when the app closes at the end of the test. */
function readTab(id: string): Promise<unknown> {
  const p = callTool(w.dataDir, "read_tab", { id });
  p.catch(() => {});
  return p;
}
const armedCard = () => waitUi(m, "return !!doc.querySelector('[data-testid=\"request-modal\"][data-armed]')");
const pending = (p: Promise<unknown>, ms = 1500) => Promise.race([p.then(() => "answered"), new Promise((r) => setTimeout(() => r("pending"), ms))]);
/** The card is still pending and still shown. */
async function stillPending(reading: Promise<unknown>): Promise<void> {
  expect(await pending(reading)).toBe("pending");
  expect(await inUi(m, "return !!doc.querySelector('[data-testid=\"request-modal\"]')")).toBe(true);
}
/** « Nouvel espace » open with a draft ready to be created; returns the space count. */
async function newSpaceDraft(): Promise<number> {
  const count = (await state(m)).spaces.length;
  const MODAL = '[data-testid="space-modal"]';
  await click(m, '[data-testid="new-space"]');
  await waitUi(m, "return doc.querySelector(arguments[0] + ' h2')?.textContent === 'Nouvel espace'", [MODAL]);
  await inUi(m, `const f = doc.querySelector(arguments[0] + ' [aria-label="Nom de l\\'espace"]'); f.value = "Jeux"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [MODAL]);
  await inUi(
    m,
    `const s = doc.querySelector(arguments[0] + " select"); s.value = [...s.options].find((o) => o.textContent === "Nouveau profil").value; s.dispatchEvent(new ui.Event("change", { bubbles: true }));`,
    [MODAL],
  );
  await waitUi(m, "return !doc.querySelector(arguments[0] + ' button[type=submit]').disabled", [MODAL]);
  return count;
}
async function draftKept(count: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 500));
  expect(await inUi(m, "return doc.querySelector('[data-testid=\"space-modal\"] h2')?.textContent")).toBe("Nouvel espace");
  expect((await state(m)).spaces.length).toBe(count);
}

describe("Command bar", () => {
  it("the command bar offers site apps and opens one", async () => {
    // Relaunched on a data folder that holds the app before the start (the watcher sees no initial event).
    await w.close();
    const sites = await startSitesServer();
    const dataDir = await mkdtemp(join(os.tmpdir(), "webaios-data-"));
    const profile = await mkdtemp(join(os.tmpdir(), "webaios-firefox-"));
    try {
      writeSite(dataDir, "vidola", {
        declaration: { name: "Vidola", url: sites.url("vidola-a.localhost", "/"), domains: ["vidola-a.localhost"], login: [] },
        files: { "home/index.html": SITE_HOME },
      });
      const actor = testActor(profile);
      w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_LOCAL_ADDRESSES: "1", ...actor.env }, prefs: actor.prefs });
      m = w.marionette;
      await m.setContext("chrome");
      await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
      await waitUi(m, "return !!doc.querySelector('[data-testid=\"sidebar\"]')");
      await resolveLocalHosts(m, ["vidola-a.localhost"]);
      await waitUi(m, "return (await ui.webaios.sites.list()).some((s) => s.id === 'vidola')", [], 30_000);
      await pressKeys(m, "Meta+t");
      await type("Vidola");
      await waitUi(m, "return doc.querySelectorAll('[data-testid=\"command-row\"][data-type=\"app\"]').length === 1");
      await click(m, '[data-testid="command-row"][data-type="app"] button');
      await waitFor(m, "return [...Services.wm.getEnumerator('navigator:browser')].some((w) => w.document.documentElement.getAttribute('webaios-site') === 'vidola')", (v) => v === true);
      expect(await siteWindowCount(m, "vidola")).toBe(1);
      await waitBar(false);
    } finally {
      // afterEach closes w; the folders go in afterAll.
      kept.push(dataDir, profile);
      await sites.close();
    }
  });

  it("⌘T opens an empty bar with its field focused", async () => {
    await withPageA();
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    expect(await fieldValue()).toBe("");
  });

  it("⌘T + Enter on an empty field shows the empty page", async () => {
    await withPageA();
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    await pressKeys(m, "Enter");
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"empty-page\"]')");
    await waitBar(false);
  });

  it("⌘T + an address opens a new tab", async () => {
    const a = await withPageA();
    await pressKeys(m, "Meta+t");
    await type(server.url + "/b.html");
    await pressKeys(m, "Enter");
    const ids = await waitState((s) => Object.keys(s.tabs), (i) => i.length === 2);
    const b = ids.find((id) => id !== a)!;
    expect(await activeId()).toBe(b);
    await waitTitle(b, "Page B");
    await waitBar(false);
  });

  it("⌘L fills in the active URL, all selected; Enter loads in the same tab", async () => {
    const a = await withPageA();
    await pressKeys(m, "Meta+l");
    await fieldFocused();
    const url = server.url + "/a.html";
    expect(await inUi(m, "const f = doc.activeElement; return [f.value, f.selectionStart, f.selectionEnd]")).toEqual([url, 0, url.length]);
    await type(server.url + "/b.html");
    await pressKeys(m, "Enter");
    await waitTitle(a, "Page B");
    expect(Object.keys((await state(m)).tabs)).toEqual([a]);
  });

  it("⌘L on the empty page gives an empty field", async () => {
    await pressKeys(m, "Meta+l");
    await fieldFocused();
    expect(await fieldValue()).toBe("");
  });

  it("Escape closes the bar; the page shows again and gets the keyboard back", async () => {
    await withPageA();
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    await pressKeys(m, "Escape");
    await waitBar(false);
    await waitFor(m, "return document.getElementById('webaios-sidebar').hasAttribute('full')", (v) => v === false);
    await waitFor(m, "return document.activeElement === gBrowser.selectedBrowser", (v) => v === true);
  });

  it("closes when the active tab changes", async () => {
    const a = await withPageA();
    await open("/b.html");
    await pressKeys(m, "Meta+t");
    await waitBar(true);
    await dispatch(m, { type: "activateTab", id: a });
    await waitBar(false);
  });

  it("a click on the veil closes the bar", async () => {
    await withPageA();
    await pressKeys(m, "Meta+t");
    await waitBar(true);
    await inUi(m, `for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, 5, 5, { button: 0, clickCount: 1 });`);
    await waitBar(false);
  });

  it("an open tab gets activated, no new tab", async () => {
    const a = await withPageA();
    const b = await open("/b.html");
    await waitTitle(b, "Page B");
    await pressKeys(m, "Meta+t");
    await type("Page A");
    await waitUi(m, "return doc.querySelectorAll('[data-testid=\"command-row\"][data-type=\"tab\"]').length === 1");
    await pressKeys(m, "ArrowDown");
    await pressKeys(m, "Enter");
    await waitState((s) => s.windows[0]!.active[s.windows[0]!.activeSpace], (id) => id === a);
    expect(Object.keys((await state(m)).tabs)).toHaveLength(2);
  });

  it("↑ and ↓ loop over the lines", async () => {
    await withPageA();
    await pressKeys(m, "Meta+t");
    await type("Page A");
    await waitUi(m, "return doc.querySelectorAll('[data-testid=\"command-row\"][data-type=\"tab\"]').length === 1");
    expect(await selectedType()).toBe("default");
    await pressKeys(m, "ArrowUp");
    expect(await selectedType()).toBe("tab");
    await pressKeys(m, "ArrowDown");
    expect(await selectedType()).toBe("default");
  });

  it("Tab and ⇧Tab keep the keyboard in the field", async () => {
    await withPageA();
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    for (const k of ["Tab", "Tab", "Shift+Tab", "Tab"]) {
      await pressKeys(m, k);
      await fieldFocused();
    }
  });

  it("with the bar open the window under it is inert", async () => {
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    expect(await inUi(m, "return doc.querySelector('.window').hasAttribute('inert')")).toBe(true);
    await pressKeys(m, "Escape");
    await waitUi(m, "return !doc.querySelector('.window').hasAttribute('inert')");
  });

  it("over a web page, the page stays visible under the veil, darkened", async () => {
    const id = await open("/icone");
    await waitTitle(id, "icone");
    for (let i = 0; i < 50 && (await pixel(m, 900, 700)).join() !== "255,0,0"; i++) await new Promise((r) => setTimeout(r, 100));
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    const [r, g, b] = await pixel(m, 900, 700);
    expect(r).toBeLessThan(255);
    expect(r).toBeGreaterThan(2 * Math.max(g, b, 20));
  });

  // barre-commande.spec.ts:96
  it("keys typed right after ⌘T land in the field", async () => {
    await withPageA();
    await pressKeys(m, "Meta+t");
    await typeText(m, "abc");
    await fieldFocused();
    expect(await fieldValue()).toBe("abc");
  });

  // barre-commande.spec.ts:284
  it("an empty ⌘T: the actions, then the other open tabs, not the shown one; Enter shows the empty page", async () => {
    await writeAction(w.dataDir, "sans-workflow", { name: "Zorglub" });
    await waitUi(m, "return (await ui.webaios.actions.list()).length > 0", [], 30_000);
    await withPageA();
    const b = await open("/b.html");
    await waitTitle(b, "Page B");
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    await waitUi(m, "return [...doc.querySelectorAll('[data-testid=\"command-section\"]')].map((e) => e.textContent).join() === 'Actions,Onglets ouverts'");
    expect(await inUi(m, "return [...doc.querySelectorAll('[data-testid=\"command-row\"][data-type=\"action\"]')].map((e) => e.textContent).join()")).toContain("Zorglub");
    expect(await inUi(m, "return [...doc.querySelectorAll('[data-testid=\"command-row\"][data-type=\"tab\"]')].map((e) => e.textContent)")).toEqual([
      expect.stringContaining("Page A"),
    ]);
    await pressKeys(m, "Enter");
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"empty-page\"]')");
  });

  // barre-commande.spec.ts:430
  it("Enter in the bar does not allow the agent's request hidden under it", async () => {
    const id = await withAgentAndTab();
    const reading = readTab(id);
    await armedCard();
    await pressKeys(m, "Meta+t");
    await type(server.url + "/b.html");
    await pressKeys(m, "Enter");
    await waitBar(false);
    await stillPending(reading);
  });

  // barre-commande.spec.ts:445
  it("Enter in the bar does not submit the space settings draft hidden under it", async () => {
    const count = await newSpaceDraft();
    await pressKeys(m, "Meta+t");
    await type(server.url + "/b.html");
    await pressKeys(m, "Enter");
    await waitBar(false);
    await draftKept(count);
  });

  // barre-commande.spec.ts:466
  it("an agent request arriving while the bar is open closes it, shows the card and gives it the keyboard", async () => {
    const id = await withAgentAndTab();
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    const reading = readTab(id);
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"request-modal\"]')");
    await waitBar(false);
    await waitUi(m, "return !!doc.activeElement?.closest('[data-testid=\"request-modal\"]') && document.activeElement === document.getElementById('webaios-sidebar')");
    expect(await pending(reading, 300)).toBe("pending");
  });

  // barre-commande.spec.ts:478
  it("on the empty page, Escape gives the keyboard back to the empty page's field", async () => {
    // No check that the field has the keyboard at start: Marionette's NewSession focuses the selected browser.
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    await pressKeys(m, "Escape");
    await waitBar(false);
    await emptyPageFocused();
  });

  // barre-commande.spec.ts:503
  it("on the empty page, a click on the veil gives the keyboard back to the empty page's field", async () => {
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    await veilClick();
    await waitBar(false);
    await emptyPageFocused();
  });

  // barre-commande.spec.ts:516
  it("a click in the bar's margin then Enter does not allow the agent's request under it", async () => {
    const id = await withAgentAndTab();
    const reading = readTab(id);
    await armedCard();
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    await marginClick();
    await fieldFocused();
    await pressKeys(m, "Enter");
    await stillPending(reading);
  });

  // barre-commande.spec.ts:530
  it("a click in the bar's margin, Tab then Space do not allow the agent's request under it", async () => {
    const id = await withAgentAndTab();
    const reading = readTab(id);
    await armedCard();
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    await marginClick();
    await pressKeys(m, "Tab");
    await pressKeys(m, " ");
    expect(await cardInFocus()).toBe(false);
    await stillPending(reading);
  });

  // barre-commande.spec.ts:544
  it("bar open, keyboard off the field: Enter and Space do not reach the agent's request under it", async () => {
    const id = await withAgentAndTab();
    const reading = readTab(id);
    await armedCard();
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    await inUi(m, "doc.activeElement?.blur()");
    for (const k of ["Enter", " ", "Enter"]) await pressKeys(m, k);
    expect(await inUi(m, "return !!doc.querySelector('[data-testid=\"command-bar\"]')")).toBe(true);
    await stillPending(reading);
  });

  // barre-commande.spec.ts:558
  it("a click in the bar's margin then Enter does not submit the space settings draft under it", async () => {
    const count = await newSpaceDraft();
    await pressKeys(m, "Meta+t");
    await fieldFocused();
    await marginClick();
    await pressKeys(m, "Enter");
    await draftKept(count);
  });

  // barre-commande.spec.ts:577
  it("Enter twice in a row in the bar does not allow the agent's request under it", async () => {
    const id = await withAgentAndTab();
    const reading = readTab(id);
    await armedCard();
    await pressKeys(m, "Meta+t");
    await type(server.url + "/b.html");
    await pressKeys(m, "Enter");
    await pressKeys(m, "Enter");
    await waitBar(false);
    await stillPending(reading);
  });

  // barre-commande.spec.ts:361
  it("the bar offers a visited page", async () => {
    const id = await open("/b.html");
    await waitTitle(id, "Page B");
    await visited("b.html");
    await pressKeys(m, "Meta+t");
    await type("b.html");
    await waitUi(m, `return !!doc.querySelector('[data-testid="command-row"][data-type="history"], [data-testid="command-row"][data-type="tab"]')`);
  });

  // barre-commande.spec.ts:374
  it("a page no longer open comes from the history; Enter opens it in a new tab", async () => {
    const id = await open("/b.html");
    await waitTitle(id, "Page B");
    await visited("b.html");
    await inUi(m, "ui.webaios.navigate(arguments[0], arguments[1])", [id, server.url + "/a.html"]);
    await waitTitle(id, "Page A");
    await pressKeys(m, "Meta+t");
    await type("b.html");
    await waitUi(m, `return doc.querySelectorAll('[data-testid="command-row"][data-type="history"]').length === 1`);
    expect(await inUi(m, `return doc.querySelector('[data-testid="command-row"][data-type="history"]').textContent`)).toContain("Page B");
    expect(await inUi(m, `return doc.querySelectorAll('[data-testid="command-row"][data-type="tab"]').length`)).toBe(0);
    await pressKeys(m, "ArrowDown");
    await pressKeys(m, "Enter");
    const s = await waitState((s) => Object.values(s.tabs), (o) => o.length === 2 && o.some((t) => t.url.endsWith("/b.html")));
    expect(s).toHaveLength(2);
  });

  // historique.spec.ts:81
  it("a URL visited in two spaces is offered once", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await dispatch(m, { type: "createSpace", name: "Travail", icon: "💼", private: false, profile: "default", windowId: (await win()).id });
    const b = await open("/a.html");
    await waitTitle(b, "Page A");
    await waitUi(m, "return (await ui.webaios.history.recent()).length === 2", [], 15_000);
    // Open tabs hide their own history line: close both.
    for (const id of [a, b]) await dispatch(m, { type: "closeTab", id });
    await pressKeys(m, "Meta+t");
    await type("page a");
    await waitUi(m, `return doc.querySelectorAll('[data-testid="command-row"][data-type="history"]').length === 1`);
    await new Promise((r) => setTimeout(r, 300));
    expect(await inUi(m, `return doc.querySelectorAll('[data-testid="command-row"][data-type="history"]').length`)).toBe(1);
  });
});
