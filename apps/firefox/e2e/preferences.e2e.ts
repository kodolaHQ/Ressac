import { afterEach, expect, it } from "vitest";
import type { BrowserState } from "../shared/model";
import { HIDDEN_CATEGORIES, HIDDEN_GROUPS, HIDDEN_PANES } from "../chrome/store/preferences-cleanup";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { click, missingApi, waitUi } from "./ui";

// Plan 44 Task 7: about:preferences without what contradicts Ressac; the tabs it opens join the store.

const activeTab = (s: BrowserState) => s.tabs[s.windows[0]!.active[s.windows[0]!.activeSpace]!];

let w: LaunchedRessac | undefined;
let m: Marionette;
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
  }
});

async function launch(): Promise<void> {
  w = await launchRessac();
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
}

/** The preferences page's document, its visible check and deep (shadow-piercing) helpers, in the chrome context. */
const PREFS = `
  const doc = gBrowser.selectedBrowser.contentDocument;
  const shown = (e) => !!e && e.checkVisibility() && doc.defaultView.getComputedStyle(e).display !== "none";
  const children = (n) => [...(n.shadowRoot?.childNodes ?? []), ...n.childNodes];
  const deepText = (n, skip = ":not(*)") => children(n).map((c) => (c.nodeType === 3 ? c.data : c.nodeType === 1 && shown(c) && !c.matches(skip) ? deepText(c, skip) : "")).join(" ");
  const deepFind = (n, sel) => { for (const c of children(n)) if (c.nodeType === 1) { if (c.matches(sel) && shown(c)) return c; const f = deepFind(c, sel); if (f) return f; } return null; };
`;
const inPrefs = <T>(body: string, args: unknown[] = []) => m.execute<T>(PREFS + body, args);

/** Shows `pane` and waits until the visible groups of that pane have rendered. */
async function showPane(pane: string, rendered: string[]): Promise<void> {
  await inPrefs(`doc.defaultView.gotoPref(arguments[0]);`, [pane]);
  const group = (g: string) => `[...doc.querySelectorAll('setting-group[groupid="${g}"], [data-srd-groupid="${g}"]')].find(shown)`;
  const ready = rendered.map((g) => `deepText(${group(g)} ?? doc.createElement("i")).trim() !== ""`).join(" && ");
  await waitFor(m, PREFS + `return ${ready};`, (v) => v === true);
}

async function openPrefs(): Promise<void> {
  const s = await state(m);
  await dispatch(m, { type: "openTab", windowId: s.windows[0]!.id, url: "about:preferences", activate: true });
  await waitFor(m, "return gBrowser.selectedBrowser.contentDocument?.readyState === 'complete' && !!gBrowser.selectedBrowser.contentDocument.defaultView.gotoPref", (v) => v === true);
}

/** The settings Ressac keeps, by the Firefox 161 pane that shows them. */
const KEPT = [
  ["paneDownloads", ["downloads"]],
  ["paneAccessibility", ["fonts", "zoom"]],
  ["paneLanguages", ["browserLanguage"]],
  ["paneConnectionSecurity", ["networkProxy"]],
  ["panePasswordsAutofill", ["passwords"]],
  ["panePrivacy", ["cookiesAndSiteData2"]],
  ["paneSearch", ["defaultEngine"]],
] as const;

it("hidden: Firefox's panes and groups that contradict Ressac are not shown", async () => {
  await launch();
  await openPrefs();
  for (const [pane, rendered] of KEPT) {
    await showPane(pane, [...rendered]);
    const visible = await inPrefs<string[]>(
      `const [categories, groups, panes] = arguments;
       return [...categories.map((id) => doc.getElementById(id)), ...groups.flatMap((g) => [...doc.querySelectorAll('setting-group[groupid="' + g + '"], [data-srd-groupid="' + g + '"]')]),
               ...panes.flatMap((p) => [...doc.querySelectorAll('[data-category="' + p + '"]')])]
         .filter((e) => e && doc.defaultView.getComputedStyle(e).display !== "none")
         .map((e) => e.id || e.getAttribute("groupid") || e.getAttribute("data-srd-groupid") || e.getAttribute("data-category"));`,
      [HIDDEN_CATEGORIES, HIDDEN_GROUPS, HIDDEN_PANES],
    );
    expect(visible, pane).toEqual([]);
  }
});

it("kept: the browser's own settings stay", async () => {
  await launch();
  await openPrefs();
  // showPane waits for each of them to be shown with content.
  for (const [pane, rendered] of KEPT) await showPane(pane, [...rendered]);
});

// Kept despite its « Firefox Relay » (email masks): the passwords group is a setting Ressac keeps.
const BRANDED = '[groupid="passwords"], [data-srd-groupid="passwords"]';

it("no brand: the panes Ressac keeps name neither Firefox nor Mozilla", async () => {
  await launch();
  await openPrefs();
  for (const [pane, rendered] of KEPT) {
    await showPane(pane, [...rendered]);
    const text = await inPrefs<string>(`return deepText(doc.querySelector(".main-content"), arguments[0]).replace(/\\s+/g, " ");`, [BRANDED]);
    expect(text.match(/.{0,60}(Firefox|Mozilla).{0,60}/g), pane).toBeNull();
  }
});

it("logins tab: the saved passwords open in a store tab of the current space", async () => {
  await launch();
  await click(m, '[data-testid="settings-button"]');
  await click(m, '[data-testid="settings-nav-about"]');
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"open-advanced\"]')");
  await click(m, '[data-testid="open-advanced"]');
  await waitFor(m, "return gBrowser.selectedBrowser.contentDocument?.readyState === 'complete' && !!gBrowser.selectedBrowser.contentDocument.defaultView.gotoPref", (v) => v === true);
  await showPane("panePasswordsAutofill", ["passwords"]);
  await inPrefs(`deepFind(doc.documentElement, "#showPasswords, #manageSavedPasswords").click();`);
  const s = await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready).state)();`, (s) => !!activeTab(s)?.url.startsWith("about:logins"));
  expect(activeTab(s)!.spaceId).toBe(s.windows[0]!.activeSpace);
  expect(await m.execute("return gBrowser.selectedTab.getAttribute('ressac-tab-id')")).toBe(s.windows[0]!.active[s.windows[0]!.activeSpace]);
});

it("other tabs opened while the preferences show keep their own space and container", async () => {
  await launch();
  const windowId = (await state(m)).windows[0]!.id;
  const first = (await state(m)).windows[0]!.activeSpace;
  await dispatch(m, { type: "createSpace", name: "Pro", icon: "💼", private: false, profile: "new", windowId });
  await openPrefs();
  const container = await m.execute<number>("return gBrowser.selectedTab.userContextId");
  expect(container).not.toBe(0);
  // A call without options fails as Firefox's own addTab does (no triggering principal), not in our override.
  const error = await m.execute<string>(`try { gBrowser.addTab("about:blank"); return ""; } catch (e) { return String(e); }`);
  expect(error).not.toMatch(/TypeError/);
  // TabSync's own creation: a tab of the first space (default profile), shown in the background.
  const before = Object.keys((await state(m)).tabs);
  const after = await dispatch(m, { type: "openTab", windowId, spaceId: first, url: "about:blank", activate: false });
  const added = Object.keys(after.tabs).filter((id) => !before.includes(id));
  expect(added).toHaveLength(1);
  const xul = await m.execute<{ count: number; userContextId: number }>(
    `return (async () => { await window.ressacWindow.ensure(arguments[0]); const t = gBrowser.tabs.filter((t) => t.getAttribute("ressac-tab-id") === arguments[0]); return { count: t.length, userContextId: t[0].userContextId }; })();`,
    [added[0]],
  );
  expect(xul).toEqual({ count: 1, userContextId: 0 });
  expect(Object.keys((await state(m)).tabs)).toHaveLength(before.length + 1);
});
