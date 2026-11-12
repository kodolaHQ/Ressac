import { writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import type { BrowserState } from "../shared/model";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, pixel, pressKeys, typeText, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
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
async function open(path: string, extra: Partial<Extract<Action, { type: "openTab" }>> = {}): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const after = await dispatch(m, { type: "openTab", windowId: (await win()).id, url: server.url + path, ...extra });
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

/** The tab list as shown: ids in order, and the one marked current. */
const shownTabs = () =>
  inUi<{ ids: string[]; current: string | null }>(
    m,
    `const lis = [...doc.querySelectorAll('[data-testid^="tab-"]')];
     return { ids: lis.map((li) => li.dataset.testid.slice(4)), current: lis.find((li) => li.getAttribute("aria-current") === "page")?.dataset.testid.slice(4) ?? null };`,
  );
const waitShown = (ok: (t: { ids: string[]; current: string | null }) => boolean) =>
  (async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const t = await shownTabs();
      if (ok(t)) return t;
      if (Date.now() > deadline) throw new Error(`timed out: shown ${JSON.stringify(t)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
const count = (selector: string) => inUi<number>(m, "return doc.querySelectorAll(arguments[0]).length", [selector]);
/** The empty page is shown and its field has the keyboard: focused in the UI, and the UI iframe focused in the window. */
const emptyPageFocused = () =>
  waitUi(
    m,
    `return !!doc.querySelector('[data-testid="empty-page"]') && doc.activeElement?.dataset.testid === "empty-page-input"
       && document.activeElement === document.getElementById("webaios-sidebar");`,
  );

// getComputedStyle does not expose -moz-window-dragging: the last matching rule gives it (a chrome rule keeps it when parsed).
const DRAGGING = `const of = (s) => {
  const el = doc.querySelector(s);
  let value = "default";
  for (const sheet of doc.styleSheets) for (const r of sheet.cssRules) {
    const v = /-moz-window-dragging: ([a-z-]+)/.exec(r.cssText)?.[1];
    if (v && el.matches(r.selectorText)) value = v;
  }
  return value;
};`;

describe("the sidebar's layout", () => {
  it("drags the window from its empty areas only, and frames the page 8 px from the top and the bottom", async () => {
    await open("/icone");
    await waitUi(m, `return !frame.hasAttribute("full");`);
    const drag = await inUi<Record<string, string>>(
      m,
      `${DRAGGING} return { allowed: frame.contentWindow.docShell.windowDraggingAllowed, sidebar: of(".bar"), button: of(".navigation button"), address: of(".line"), tabs: of(".scrolling"), footer: of("footer") };`,
    );
    expect(drag).toEqual({ allowed: true, sidebar: "drag", button: "no-drag", address: "no-drag", tabs: "no-drag", footer: "no-drag" });
    // The page sits framed on the aura, 8 px from the top and the bottom.
    expect(await m.execute(`const r = gBrowser.selectedBrowser.getBoundingClientRect(); return [r.top, r.height - window.innerHeight];`)).toEqual([8, -16]);
    // Under an overlay the sidebar's area belongs to the overlay.
    await pressKeys(m, "Meta+t");
    await waitUi(m, `${DRAGGING} return of(".bar") === "default";`);
  });

  it("shows the extensions inside the address pill and the space above the tabs", async () => {
    const shown = await inUi<{ menuIn: boolean; pill: number; space: string; gap: number }>(
      m,
      `const pill = doc.querySelector(".line").getBoundingClientRect(), menu = doc.querySelector('[data-testid="menu-extensions"]').getBoundingClientRect();
       const tiles = doc.querySelector('[data-testid="essentials"]').getBoundingClientRect();
       return { menuIn: menu.right <= pill.right && menu.top >= pill.top && menu.bottom <= pill.bottom, pill: pill.height, gap: tiles.top - pill.bottom,
         space: doc.querySelector('[data-testid="space-title"]').textContent };`,
    );
    const space = (await state(m)).spaces[0]!;
    expect(shown).toEqual({ menuIn: true, pill: 34, gap: 14, space: `${space.icon} ${space.name}` });
    // The panel opens under the pill, which keeps its height.
    await click(m, '[data-testid="menu-extensions"]');
    const panel = await waitUi<{ top: number; bottom: number } | null>(
      m,
      `const p = doc.querySelector('[data-testid="extensions-panel"]'); return p && { top: p.getBoundingClientRect().top, bottom: doc.querySelector("form").getBoundingClientRect().bottom };`,
    );
    expect(panel!.top).toBeGreaterThanOrEqual(panel!.bottom);
  });
  it("keeps spaces and tools on one row, tools folded past two spaces, chips never squashed, the row scrolling when full, with 1, 3 and 6 spaces", async () => {
    const layout = () =>
      inUi<{ centres: number[]; chipWidths: number[]; clipped: boolean; scrolls: boolean; overlap: boolean; toolsRight: boolean; tools: number }>(
        m,
        `const rect = (e) => e.getBoundingClientRect();
         const navEl = doc.querySelector("footer nav"), nav = rect(navEl);
         const chips = [...doc.querySelectorAll("footer nav button")].map(rect);
         const tools = [...doc.querySelectorAll("footer > .tool, footer > .fold")].map(rect);
         const footer = rect(doc.querySelector("footer"));
         const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
         return {
           centres: [...new Set([...chips, ...tools].map((r) => Math.round((r.top + r.height / 2) / 4)))],
           chipWidths: [...new Set(chips.map((r) => Math.round(r.width)))],
           clipped: chips.some((c) => c.left < nav.left - 1 || c.right > nav.right + 1),
           scrolls: navEl.scrollWidth > navEl.clientWidth,
           // The part of each chip the row shows: past its edge the row scrolls.
           overlap: chips.map((c) => new DOMRect(Math.max(c.left, nav.left), c.top, Math.max(0, Math.min(c.right, nav.right) - Math.max(c.left, nav.left)), c.height)).some((c) => c.width > 0 && tools.some((t) => hit(c, t))),
           toolsRight: footer.right - tools.at(-1).right < 12,
           tools: tools.length,
         };`,
      );
    for (const total of [1, 3, 6]) {
      for (let n = (await state(m)).spaces.length; n < total; n++)
        await dispatch(m, { type: "createSpace", name: `E${n}`, icon: "📁", private: n % 2 === 0, profile: "default", windowId: (await win()).id });
      await waitUi(m, "return doc.querySelectorAll('footer nav button[data-testid^=\"space-\"]').length === arguments[0]", [total]);
      const l = await layout();
      expect(l.centres).toHaveLength(1);
      expect(l.chipWidths).toEqual([28]);
      if (l.clipped) expect(l.scrolls).toBe(true);
      expect(l.overlap).toBe(false);
      expect(l.toolsRight).toBe(true);
      expect(l.tools).toBe(total > 2 ? 1 : 4);
    }
    // Two more: the last space starts past the row's edge, and scrolls into view once active.
    for (const n of [6, 7]) await dispatch(m, { type: "createSpace", name: `E${n}`, icon: "📁", private: false, profile: "default", windowId: (await win()).id });
    const last = (await state(m)).spaces.at(-1)!;
    const inView = () => inUi<boolean>(m, `const nav = doc.querySelector("footer nav").getBoundingClientRect(), c = doc.querySelector(arguments[0]).getBoundingClientRect();
      return c.left >= nav.left - 1 && c.right <= nav.right + 1;`, [`[data-testid="space-${last.id}"]`]);
    // Creating activates the new space: back to the first one, which scrolls the row to its start.
    await dispatch(m, { type: "activateSpace", windowId: (await win()).id, id: (await state(m)).spaces[0]!.id });
    await expect.poll(inView, { timeout: 5_000 }).toBe(false);
    await dispatch(m, { type: "activateSpace", windowId: (await win()).id, id: last.id });
    await expect.poll(inView, { timeout: 5_000 }).toBe(true);
  });
});

describe("WebAiOs sidebar", () => {
  it("“Nouvel onglet” shows the empty page with its field focused; Enter opens the address", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(m, '[data-testid="new-tab"]');
    await emptyPageFocused();
    await inUi(m, `const f = doc.querySelector('[data-testid="empty-page-input"]'); f.value = arguments[0]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [
      server.url + "/b.html",
    ]);
    await pressKeys(m, "Enter");
    const shown = await waitShown((t) => t.ids.length === 2);
    expect(shown.current).toBe(shown.ids[1]);
    await waitTitle(shown.ids[1]!, "Page B");
  });

  it("closing the active tab with ✕ activates the next one", async () => {
    const a = await open("/a.html");
    const b = await open("/b.html");
    const c = await open("/texte.html");
    await click(m, `[data-testid="tab-${b}"]`);
    await waitShown((t) => t.current === b);
    await click(m, `[data-testid="tab-${b}"] button[aria-label="Fermer l'onglet"]`);
    const shown = await waitShown((t) => t.ids.length === 2);
    expect(shown).toEqual({ ids: [a, c], current: c });
  });

  it("a right click on ✕ does not close the tab", async () => {
    const a = await open("/a.html");
    const b = await open("/b.html");
    await click(m, `[data-testid="tab-${b}"] button[aria-label="Fermer l'onglet"]`, { button: 2 });
    await new Promise((r) => setTimeout(r, 300));
    expect((await waitShown((t) => t.ids.length === 2)).ids).toEqual([a, b]);
  });

  it("drag and drop reorders the list and the state", async () => {
    const a = await open("/a.html", { activate: false });
    const b = await open("/b.html", { activate: false });
    const c = await open("/texte.html", { activate: false });
    await waitShown((t) => t.ids.length === 3);
    // c dropped on the top half of a: before it.
    await inUi(
      m,
      `const dt = new ui.DataTransfer();
       dt.setData("application/x-webaios-onglet", arguments[0]);
       const target = doc.querySelector('[data-testid="tab-' + arguments[1] + '"]');
       const r = target.getBoundingClientRect();
       for (const type of ["dragover", "drop"])
         target.dispatchEvent(new ui.DragEvent(type, { dataTransfer: dt, clientX: r.left + 10, clientY: r.top + 2, bubbles: true, cancelable: true }));`,
      [c, a],
    );
    expect((await waitShown((t) => t.ids[0] === c)).ids).toEqual([c, a, b]);
    const f = await win();
    expect(f.order[f.activeSpace]).toEqual([c, a, b]);
  });

  it("right click → “Épingler” pins the tab in this space only", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(m, `[data-testid="tab-${a}"]`, { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Épingler" });
    await waitShown((t) => t.ids.length === 0);
    const pinned = '[data-testid="pinned"] [data-testid^="favorite-"]';
    expect(await count(pinned)).toBe(1);
    await dispatch(m, { type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: (await win()).id });
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 0", [pinned]);
  });

  it("a pinned tab goes into a new folder, named in place; the folder collapses, and deleting it keeps the tab", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await dispatch(m, { type: "pinTab", id: a });
    const favorite = '[data-testid="pinned"] [data-testid^="favorite-"]';
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 1", [favorite]);
    await click(m, favorite, { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Nouveau dossier" });
    await waitUi(m, `return doc.activeElement?.dataset.testid === "folder-name"`);
    await typeText(m, "Docs");
    await pressKeys(m, "Enter");
    const inside = '[data-testid^="folder-"] [data-testid^="favorite-"]';
    await waitUi(m, `return doc.querySelector('[data-testid^="folder-"] .head')?.textContent.trim() === "Docs" && doc.querySelectorAll(arguments[0]).length === 1`, [inside]);
    await click(m, '[data-testid^="folder-"] .head');
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 0", [inside]);
    expect((await state(m)).spaces[0]!.folders).toMatchObject([{ name: "Docs", collapsed: true }]);
    if (process.env.WEBAIOS_SHOT) {
      await click(m, '[data-testid^="folder-"] .head');
      await new Promise((r) => setTimeout(r, 1_000));
      writeFileSync(process.env.WEBAIOS_SHOT, Buffer.from((await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value, "base64"));
    }
    await click(m, '[data-testid^="folder-"] .head', { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Supprimer le dossier" });
    await waitUi(m, `return !doc.querySelector('[data-testid^="folder-"]') && doc.querySelectorAll(arguments[0]).length === 1`, [favorite]);
  });

  it("right click → « Envoyer vers » moves the tab to the other space, in the background", async () => {
    const home = (await win()).activeSpace;
    await dispatch(m, { type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: (await win()).id });
    const work = (await win()).activeSpace;
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(m, `[data-testid="tab-${a}"]`, { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Envoyer vers 🏠 Perso" });
    await waitUi(m, "return !doc.querySelector(arguments[0])", [`[data-testid="tab-${a}"]`]);
    const s = await state(m);
    expect(s.tabs[a]!.spaceId).toBe(home);
    expect(s.windows[0]!.activeSpace).toBe(work);
    expect(s.windows[0]!.order[home]).toContain(a);
  });

  it("an essential is visible in every space", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(m, `[data-testid="tab-${a}"]`, { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Ajouter aux essentiels" });
    const essentials = '[data-testid="essentials"] [data-testid^="favorite-"]';
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 1", [essentials]);
    await dispatch(m, { type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: (await win()).id });
    const work = (await win()).activeSpace;
    await waitUi(m, "return doc.querySelector(arguments[0])?.getAttribute('aria-current') === 'true'", [`[data-testid="space-${work}"]`]);
    expect(await count(essentials)).toBe(1);
  });

  it("dragging an essential onto another reorders the grid and the state; it does not add or open anything", async () => {
    for (const path of ["/a.html", "/b.html", "/texte.html"]) await dispatch(m, { type: "addEssential", id: await open(path, { activate: false }) });
    const [a, b, c] = (await state(m)).essentials.map((f) => f.id);
    await waitUi(m, "return doc.querySelectorAll('[data-testid=\"essentials\"] [draggable=\"true\"]').length === 3");
    await inUi(
      m,
      `const dt = new ui.DataTransfer();
       dt.setData("application/x-webaios-essentiel", arguments[0]);
       const target = doc.querySelector('[data-testid="favorite-' + arguments[1] + '"]');
       for (const type of ["dragover", "drop"]) target.dispatchEvent(new ui.DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));`,
      [c, a],
    );
    const shown = "return [...doc.querySelectorAll('[data-testid=\"essentials\"] [data-testid^=\"favorite-\"]')].map((e) => e.dataset.testid.slice(9)).join()";
    await waitUi(m, `${shown} === arguments[0]`.replace("return ", "return (").replace(".join()", ".join())"), [[c, a, b].join()]);
    expect((await state(m)).essentials.map((f) => f.id)).toEqual([c, a, b]);
  });

  it("switching spaces shows its tabs and finds each space's active tab", async () => {
    const home = (await win()).activeSpace;
    const a = await open("/a.html");
    const p = await open("/plante.html", { activate: false });
    await dispatch(m, { type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: (await win()).id });
    const work = (await win()).activeSpace;
    const b = await open("/b.html");
    expect(await waitShown((t) => t.ids.length === 1)).toEqual({ ids: [b], current: b });
    await click(m, `[data-testid="space-${home}"]`);
    expect(await waitShown((t) => t.ids.length === 2)).toEqual({ ids: [a, p], current: a });
    await click(m, `[data-testid="space-${work}"]`);
    expect(await waitShown((t) => t.ids.length === 1)).toEqual({ ids: [b], current: b });
  });

  it("closing the last tab shows the empty page with its field focused", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(m, `[data-testid="tab-${a}"] button[aria-label="Fermer l'onglet"]`);
    await emptyPageFocused();
  });

  it("shows the web page right of the sidebar", async () => {
    const id = await open("/icone");
    await waitTitle(id, "icone");
    // The UI shrinks to its column once a web page is displayed.
    await waitFor(m, "return document.getElementById('webaios-sidebar').hasAttribute('full')", (v) => v === false);
    // The page may paint a moment after its title arrives.
    for (let i = 0; i < 50 && (await pixel(m, 900, 400)).join() !== "255,0,0"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await pixel(m, 900, 400)).toEqual([255, 0, 0]);
    // The sidebar's glass pane on the aura, not the page: another colour than the page's, and a glass that paints.
    const page = await pixel(m, 900, 400);
    expect(await pixel(m, 100, 400)).not.toEqual(page);
    const glass = await inUi<string>(m, "return ui.getComputedStyle(doc.querySelector('[data-testid=\"sidebar\"]')).backgroundColor");
    const alpha = glass.startsWith("rgba") ? parseFloat(glass.split(",")[3]!) : 1;
    expect(alpha, glass).toBeGreaterThan(0);
    // The empty page sits on the aura: Firefox's tab box steps aside (window.css), the page's red no longer shows.
    await dispatch(m, { type: "showBlankPage", windowId: (await win()).id });
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"empty-page\"]')");
    // Between the home field and the widgets, left of the agent panel the home page opens.
    for (let i = 0; i < 50 && (await pixel(m, 550, 190)).join() === "255,0,0"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await pixel(m, 550, 190)).not.toEqual([255, 0, 0]);
    expect(await m.execute("return getComputedStyle(document.getElementById('tabbrowser-tabbox')).opacity")).toBe("0");
  });

  it("shows an internal webaios: page as not yet available", async () => {
    // An internal page WebAiOs-Firefox does not know.
    await dispatch(m, { type: "openTab", windowId: (await win()).id, url: "webaios://inconnue" });
    const text = await waitUi<string>(m, "return doc.querySelector('[data-testid=\"internal-page\"]')?.textContent");
    expect(text).toBe("Pas encore disponible dans WebAiOs-Firefox.");
    expect(await m.execute("return document.getElementById('webaios-sidebar').hasAttribute('full')")).toBe(true);
  });

  it("shows the favicon a page declares", async () => {
    const id = await open("/icone");
    await waitTitle(id, "icone");
    await waitUi(m, "const img = doc.querySelector(arguments[0]); return !!img && img.complete && img.naturalWidth > 0", [`[data-testid="tab-${id}"] img`]);
  });
});
