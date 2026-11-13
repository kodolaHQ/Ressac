import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BrowserState } from "../shared/model";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inUi, missingApi, pressKeys, waitUi } from "./ui";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchRessac();
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
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
const barOpen = () => inUi<boolean>(m, "return !!doc.querySelector('[data-testid=\"command-bar\"]')");
const waitBar = (open: boolean) => waitUi(m, "return !!doc.querySelector('[data-testid=\"command-bar\"]') === arguments[0]", [open]);
/** Types `text` in the command bar field and presses Enter. */
async function submit(text: string): Promise<void> {
  await waitUi(m, "return doc.activeElement?.dataset.testid === 'command-input'");
  await inUi(m, `const f = doc.activeElement; f.value = arguments[0]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [text]);
  await pressKeys(m, "Enter");
}
/** The keyboard goes to the displayed web page. */
const focusPage = () => m.execute("gBrowser.selectedBrowser.focus()");

describe("Ressac shortcuts", () => {
  it("⌘T opens the command bar, not a Firefox tab", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    const tabs = await m.execute<number>("return gBrowser.tabs.length");
    await focusPage();
    await pressKeys(m, "Meta+t");
    await waitBar(true);
    expect(await m.execute<number>("return gBrowser.tabs.length")).toBe(tabs);
    expect(Object.keys((await state(m)).tabs)).toEqual([a]);
  });

  it("⌘, opens the Settings page once, not Firefox's preferences", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await focusPage();
    await pressKeys(m, "Meta+,");
    await pressKeys(m, "Meta+,");
    await sleep(500);
    const s = await state(m);
    const pages = Object.values(s.tabs).filter((o) => o.url === "ressac://settings");
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ title: "Réglages" });
    expect(s.windows[0]!.active[s.windows[0]!.activeSpace]).toBe(pages[0]!.id);
  });

  it("⌘T + address opens a tab; ⌘W closes it; ⇧⌘T reopens it with its URL", async () => {
    await pressKeys(m, "Meta+t");
    await submit(server.url + "/b.html");
    const b = await waitState((s) => Object.keys(s.tabs), (ids) => ids.length === 1).then((ids) => ids[0]!);
    await waitTitle(b, "Page B");
    await pressKeys(m, "Meta+w");
    await waitState((s) => Object.keys(s.tabs).length, (n) => n === 0);
    await pressKeys(m, "Meta+Shift+t");
    const urls = await waitState((s) => Object.values(s.tabs).map((o) => o.url), (u) => u.length === 1);
    expect(urls).toEqual([server.url + "/b.html"]);
  });

  it("⌃2 activates the second space", async () => {
    const first = (await win()).activeSpace;
    await dispatch(m, { type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: (await win()).id });
    const second = (await win()).activeSpace;
    await dispatch(m, { type: "activateSpace", windowId: (await win()).id, id: first });
    await pressKeys(m, "Control+2");
    await waitState((s) => s.windows[0]!.activeSpace, (e) => e === second);
  });

  it("Firefox's next/previous tab keys do not leave the space", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await dispatch(m, { type: "createSpace", name: "Boulot", icon: "💼", private: false, profile: "default", windowId: (await win()).id });
    const second = (await win()).activeSpace;
    const b = await open("/b.html");
    await waitTitle(b, "Page B");
    await focusPage();
    for (const combo of ["Control+PageUp", "Control+PageDown", "Meta+Alt+ArrowLeft", "Meta+Alt+ArrowRight", "Meta+Shift+{", "Meta+Shift+}"]) {
      await pressKeys(m, combo);
      await new Promise((r) => setTimeout(r, 200));
      expect([combo, (await win()).activeSpace, await activeId()]).toEqual([combo, second, b]);
      expect(await m.execute<string | null>("return gBrowser.selectedTab.getAttribute('ressac-tab-id')")).toBe(b);
    }
  });

  it("⌘[ and ⌘] follow the tab's history", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await m.execute("window.ressacWindow.navigate(arguments[0], arguments[1])", [a, server.url + "/b.html"]);
    await waitTitle(a, "Page B");
    await focusPage();
    await pressKeys(m, "Meta+[");
    await waitTitle(a, "Page A");
    await pressKeys(m, "Meta+]");
    await waitTitle(a, "Page B");
  });

  it("⌘9 activates the last tab", async () => {
    const a = await open("/a.html");
    await open("/b.html");
    const c = await open("/texte.html");
    await dispatch(m, { type: "activateTab", id: a });
    await focusPage();
    await pressKeys(m, "Meta+9");
    await waitState((s) => s.windows[0]!.active[s.windows[0]!.activeSpace], (id) => id === c);
  });

  it("a page that swallows every key: ⌘T still opens the bar and ⌘W still closes the tab", async () => {
    const id = await open("/avale");
    await waitTitle(id, "avale");
    await focusPage();
    await pressKeys(m, "Meta+t");
    await waitBar(true);
    await pressKeys(m, "Escape");
    await waitBar(false);
    await focusPage();
    expect(await activeId()).toBe(id);
    await pressKeys(m, "Meta+w");
    await waitState((s) => Object.keys(s.tabs).length, (n) => n === 0);
    expect(await barOpen()).toBe(false);
  });

  // raccourcis.spec.ts:258
  it("⇧⌘J toggles the downloads panel", async () => {
    const shown = (v: boolean) => waitUi(m, "return !!doc.querySelector('[data-testid=\"downloads\"]') === arguments[0]", [v]);
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await pressKeys(m, "Meta+Shift+j");
    await shown(true);
    await pressKeys(m, "Meta+Shift+j");
    await shown(false);
    // The toggle gives the keyboard back to the page, as the panel's own close does.
    await waitFor(m, "return document.activeElement === gBrowser.selectedBrowser", (v) => v === true);
  });

  it("⇧⌘H and the native history commands open nothing", async () => {
    for (const k of ["Meta+Shift+h", "Meta+y", "Meta+Shift+o", "Meta+j"]) await pressKeys(m, k);
    await pressKeys(m, "Escape"); // our ⌘Y panel
    // ⇧⌘⌫ (Clear Recent History) from the page, after the Escape, which would close its dialog.
    await focusPage();
    await pressKeys(m, "Meta+Shift+Backspace");
    // doCommand() ignores `disabled`: the commands are checked disabled, the keys by pressing them.
    expect(
      await m.execute<boolean[]>(
        `return ["Browser:ShowAllHistory", "Browser:ShowAllBookmarks", "Tools:Downloads", "Tools:Sanitize"].map((id) => document.getElementById(id).getAttribute("disabled") === "true");`,
      ),
    ).toEqual([true, true, true, true]);
    await new Promise((r) => setTimeout(r, 1000));
    expect(
      await m.execute(`return { sidebar: SidebarController.isOpen, organizer: !!Services.wm.getMostRecentWindow("Places:Organizer"), sanitize: !!gDialogBox.isOpen || [...Services.wm.getEnumerator(null)].some((w) => w.location.href.includes("sanitize")) };`,
      ),
    ).toEqual({ sidebar: false, organizer: false, sanitize: false });
    // The macOS menu bar fires View › Sidebar items by their key (⇧⌘H) without the disabled <key>: the items are off.
    const items = await m.execute<{ id: string; disabled: boolean }[]>(
      `return [...document.getElementById("viewSidebarMenu").children].map((i) => ({ id: i.id, disabled: i.getAttribute("disabled") === "true" }));`,
    );
    expect(items.map((i) => i.id)).toContain("menu_historySidebar");
    expect(items.filter((i) => !i.disabled)).toEqual([]);
  });
});
