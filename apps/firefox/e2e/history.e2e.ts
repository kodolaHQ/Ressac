import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import type { Visit } from "../shared/model";
import { dispatch, inWindow, newWindow, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let base: string;
beforeAll(async () => {
  server = await startServer();
  base = server.url;
});
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchWebAiOs({ env: { WEBAIOS_TEST_PUBLIC_ADDRESSES: "127.0.0.1", WEBAIOS_MEMORY_LOOP: "1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
});
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
  }
});

const recents = () => inUi<Visit[]>(m, "return JSON.parse(JSON.stringify(await ui.webaios.history.recent()));");
const urls = async () => (await recents()).map((v) => v.url).sort();
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const win = async () => (await state(m)).windows[0]!.id;
const open = (url: string, windowId?: string) =>
  win().then((f) => dispatch(m, { type: "openTab", windowId: windowId ?? f, url }));
const loaded = (path: string) =>
  waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec.endsWith(${JSON.stringify(path)}) && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true);

describe("history noted in the kernel", () => {
  it("two visited pages are in the history, once each", async () => {
    await open(`${base}/a.html`);
    await loaded("/a.html");
    await open(`${base}/b.html`);
    await loaded("/b.html");
    const v = await until(recents, (r) => r.length === 2 && r.every((x) => x.title.startsWith("Page")));
    expect(v.map((x) => [x.url, x.title, x.visits]).sort()).toEqual([
      [`${base}/a.html`, "Page A", 1],
      [`${base}/b.html`, "Page B", 1],
    ]);
  });

  it("a redirect notes only its target; an in-page change notes the new URL", async () => {
    const s = await open(`${base}/redirige?vers=${base}/a.html`);
    await loaded("/a.html");
    await until(urls, (u) => u.length === 1);
    expect(await urls()).toEqual([`${base}/a.html`]);
    const id = Object.keys(s.tabs).at(-1)!;
    const handle = await m.execute<string>(
      `const t = gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === arguments[0]);
       return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(t.linkedBrowser);`,
      [id],
    );
    await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
    await m.setContext("content");
    try {
      await m.execute('location.hash = "x"');
    } finally {
      await m.setContext("chrome");
    }
    expect(await until(urls, (u) => u.length === 2)).toEqual([`${base}/a.html`, `${base}/a.html#x`]);
  });

  it("a private space's visit is marked; a space turned private marks its earlier visits", async () => {
    await open(`${base}/a.html`);
    await loaded("/a.html");
    await until(urls, (u) => u.length === 1);
    const s = await state(m);
    const e = s.spaces.find((x) => x.id === s.windows[0]!.activeSpace)!;
    await dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: true, profile: e.profile } as Action);
    await open(`${base}/b.html`);
    await loaded("/b.html");
    const v = await until(recents, (r) => r.length === 2 && r.every((x) => x.private));
    expect(v.map((x) => x.private)).toEqual([true, true]);
  });

  it("a visit is noted with its window's space", async () => {
    const other = await newWindow(m);
    const id = await inWindow(m, other, () => m.execute<string>("return window.webaiosWindow.windowId"));
    const s = await dispatch(m, { type: "createSpace", name: "B", icon: "🅱", private: false, profile: "default", windowId: id });
    const b = s.spaces.at(-1)!.id;
    await open(`${base}/a.html`, id);
    const v = await until(recents, (r) => r.length === 1);
    expect(v[0]!.spaceId).toBe(b);
  });

  it("an invisible read writes nothing in the history", async () => {
    const r = await m.execute<{ ok?: unknown }>(
      `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).readPage(arguments[0], { profile: null }).then((ok) => ({ ok })))();`,
      [`${base}/b.html`],
    );
    expect(r.ok).toBeTruthy();
    expect(await urls()).toEqual([]);
  });

  it("an unreachable page is not noted", async () => {
    await open("http://127.0.0.1:1/injoignable.html");
    await until(async () => (await state(m)).tabs, (o) => Object.values(o).some((t) => t.error), 15_000);
    expect((await urls()).filter((u) => u.includes("injoignable"))).toEqual([]);
  });

  it("Places gets no visit", async () => {
    await open(`${base}/a.html`);
    await loaded("/a.html");
    await until(urls, (u) => u.length === 1);
    await new Promise((r) => setTimeout(r, 2500)); // Places batches its writes
    expect(await m.execute<boolean>("return PlacesUtils.history.hasVisits(Services.io.newURI(arguments[0]))", [`${base}/a.html`])).toBe(false);
  });

  it("the agent finds a visited page by its title", async () => {
    const config = join(w.dataDir, "workspace", ".webaios", "mcp.json");
    await until(async () => existsSync(config), Boolean, 20_000);
    await open(`${base}/a.html`);
    await loaded("/a.html");
    await until(recents, (r) => r.some((x) => x.title === "Page A"));
    expect((await callTool(w.dataDir, "search_history", { query: "Page A" })).text).toContain(`${base}/a.html`);
  });

  it("a space turned private while the host is down marks its visits once the host is back", async () => {
    await open(`${base}/a.html`);
    await loaded("/a.html");
    await until(recents, (r) => r.some((x) => x.title === "Page A"));
    const host = (body: string) => m.execute<unknown>(`return (async () => { const h = (await ChromeUtils.importESModule("${STORE}").ready).agent; ${body} })();`);
    await host("await h.stop();");
    await until(() => host("return h.pid;"), (pid) => pid === null);
    const s = await state(m);
    const e = s.spaces.find((x) => x.id === s.windows[0]!.activeSpace)!;
    await dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: true, profile: e.profile } as Action);
    await host("await h.ensure();");
    expect((await until(recents, (r) => r.length === 1))[0]!.private).toBe(true);
    expect((await callTool(w.dataDir, "search_history", { query: "Page A" })).text).not.toContain("a.html");
  });
});

/** The history lines whose URL contains `part`, as the UI sees them (one per URL and space). */
const lines_ = async (part: string) =>
  (await recents()).filter((v) => v.url.includes(part)).map((v) => ({ kept: v.kept, private: v.private }));
const retained = (part: string) => until(() => lines_(part), (l) => l.length === 1 && l[0]!.kept);
async function setActiveSpacePrivate(isPrivate: boolean) {
  const s = await state(m);
  const e = s.spaces.find((x) => x.id === s.windows[0]!.activeSpace)!;
  await dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: isPrivate, profile: e.profile } as Action);
}
const newSpace = async () => dispatch(m, { type: "createSpace", name: "Travail", icon: "💼", private: false, profile: "default", windowId: await win() });

describe("the agent's memory retains page text", () => {
  it("a page's text is retained and marked in ⌘Y", async () => {
    await open(`${base}/texte.html`);
    expect(await retained("texte.html")).toEqual([{ kept: true, private: false }]);
    await pressKeys(m, "Meta+y");
    await panelOpen(true);
    await waitUi(m, `const l = [...doc.querySelectorAll(arguments[0] + " li")].find((e) => e.textContent.includes("texte.html") || e.textContent.includes("Texte")); return l?.dataset.retenu === "true" && !!l.querySelector(arguments[1])`, [PANEL, '[aria-label="Texte retenu pour l\'agent"]']);
  });

  // Needs the rebuilt page actor (getParts): fails until `pnpm build:ui`. YouTube parts are covered by unit tests only
  // (a watch page can't be served from youtube.com offline).
  it("the meta description is retained before the body", async () => {
    await open(`${base}/description`);
    await retained("/description");
    const lu = (await callTool(w.dataDir, "read_history", { url: `${base}/description` })).text;
    expect(lu).toMatch(/Resume des licornes\n\nCorps des licornes/);
  });

  it("nothing from a private space", async () => {
    await setActiveSpacePrivate(true);
    await open(`${base}/a.html`);
    await loaded("/a.html");
    await newSpace();
    await open(`${base}/b.html`);
    await retained("b.html");
    expect(await lines_("a.html")).toEqual([{ kept: false, private: true }]);
  });

  it("Oublier le texte retenu keeps the visit", async () => {
    await open(`${base}/a.html`);
    await retained("a.html");
    await pressKeys(m, "Meta+y");
    await panelOpen(true);
    await click(m, `${PANEL} li`, { text: "Page A", button: 2 });
    await click(m, '[role="menuitem"]', { text: "Oublier le texte retenu" });
    await until(() => lines_("a.html"), (l) => l.length === 1 && !l[0]!.kept);
    expect(await lines_("a.html")).toEqual([{ kept: false, private: false }]);
    await waitUi(m, `return ![...doc.querySelectorAll(arguments[0] + " li")].some((l) => l.dataset.retenu === "true")`, [PANEL]);
  });

  it("nothing from a page that failed", async () => {
    await open("http://127.0.0.1:1/injoignable.html");
    await until(async () => (await state(m)).tabs, (o) => Object.values(o).some((t) => t.error), 15_000);
    await open(`${base}/b.html`);
    await retained("b.html");
    expect(await lines_("injoignable")).toEqual([]);
  });

  it("nothing from an HTTP-authenticated page", async () => {
    // Credentials in the URL answer the 401 without a prompt; above 1 character Firefox asks to confirm them first.
    await m.execute(`Services.prefs.setIntPref("network.http.phishy-userpass-length", 255);`);
    await open(`${base.replace("http://", "http://u:p@")}/prive/auth`);
    await waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.contentTitle === "auth")`, (v) => v === true);
    await open(`${base}/b.html`);
    await retained("b.html");
    expect(await lines_("/auth")).toEqual([{ kept: false, private: false }]);
  });

  it("a space turned private forgets its text", async () => {
    await open(`${base}/a.html`);
    await retained("a.html");
    await setActiveSpacePrivate(true);
    expect(await until(() => lines_("a.html"), (l) => l[0]?.private === true)).toEqual([{ kept: false, private: true }]);
  });
});

const PANEL = '[data-testid="historique"]';
const panelOpen = (open: boolean) => waitUi(m, `return !!doc.querySelector(arguments[0]) === arguments[1]`, [PANEL, open]);
const panelLinks = () => inUi<string[]>(m, `return [...doc.querySelectorAll(arguments[0] + " a")].map((a) => a.querySelector(".titre").textContent)`, [PANEL]);
const bar = () => waitUi(m, "return !!doc.querySelector('[data-testid=\"barre-commande\"]')");
const field = async (text: string) => {
  await waitUi(m, "return doc.activeElement?.dataset.testid === 'saisie-commande'");
  await inUi(m, `const f = doc.activeElement; f.value = arguments[0]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [text]);
};
const lines = (type: string) =>
  inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="ligne-commande"][data-type="' + arguments[0] + '"]')].map((l) => l.textContent)`, [type]);
/** a.html then b.html visited, the first tab closed. */
async function visitedAB() {
  await open(`${base}/a.html`);
  await loaded("/a.html");
  const s = await open(`${base}/b.html`);
  await loaded("/b.html");
  await until(recents, (r) => r.length === 2 && r.every((x) => x.title.startsWith("Page")));
  const [first] = Object.keys(s.tabs);
  await dispatch(m, { type: "closeTab", id: first! } as Action);
}

describe("history panel", () => {
  it("⌘Y lists visited pages; a click reopens one and closes the panel", async () => {
    await visitedAB();
    await pressKeys(m, "Meta+y");
    await panelOpen(true);
    expect((await panelLinks()).sort()).toEqual(["Page A", "Page B"]);
    await click(m, `${PANEL} a`, { text: "Page A" });
    await panelOpen(false);
    const s = await state(m);
    expect(Object.keys(s.tabs)).toHaveLength(2);
    await until(async () => (await state(m)).tabs, (o) => Object.values(o).some((t) => t.title === "Page A" && t.id === s.windows[0]!.active[s.windows[0]!.activeSpace]));
    await pressKeys(m, "Meta+y");
    await panelOpen(true);
    await pressKeys(m, "Escape");
    await panelOpen(false);
  });

  it("the search filters; Effacer l'historique › Tout empties it", async () => {
    await visitedAB();
    await pressKeys(m, "Meta+y");
    await panelOpen(true);
    const search = (v: string) =>
      inUi(m, `const f = doc.querySelector('${PANEL} [type=search]'); f.value = arguments[0]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [v]);
    await search("page b");
    await until(panelLinks, (l) => l.length === 1);
    await search("");
    await until(panelLinks, (l) => l.length === 2);
    await click(m, `${PANEL} button`, { text: "Effacer l'historique" });
    await click(m, `${PANEL} button`, { text: "Tout" });
    await until(panelLinks, (l) => l.length === 0);
  });

  it("⌘Y shows a lock on private visits only", async () => {
    await open(`${base}/a.html`);
    await loaded("/a.html");
    await until(recents, (r) => r.length === 1);
    const s = await state(m);
    const e = s.spaces.find((x) => x.id === s.windows[0]!.activeSpace)!;
    await dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: true, profile: e.profile } as Action);
    await open(`${base}/b.html`);
    await loaded("/b.html");
    await until(recents, (r) => r.length === 2 && r.every((x) => x.private));
    await pressKeys(m, "Meta+y");
    await panelOpen(true);
    const text = (sel: string) => inUi<string[]>(m, `return [...doc.querySelectorAll(arguments[0])].map((l) => l.textContent)`, [sel]);
    expect(await text(`${PANEL} [data-prive="true"]`)).toHaveLength(2);
    expect((await text(`${PANEL} [data-prive="true"]`)).find((t) => t.includes("Page B"))).toContain("🔒");
    expect((await text(`${PANEL} [data-prive="false"]`)).filter((t) => t.includes("🔒"))).toEqual([]);
  });

  it("switching tab closes the panel", async () => {
    await open(`${base}/a.html`);
    const s = await open(`${base}/b.html`);
    const [first] = Object.keys(s.tabs);
    await pressKeys(m, "Meta+y");
    await panelOpen(true);
    await dispatch(m, { type: "activateTab", id: first! } as Action);
    await panelOpen(false);
  });

  it("with the host down the panel opens empty and the bar still suggests tabs", async () => {
    await open(`${base}/a.html`);
    await loaded("/a.html");
    await until(recents, (r) => r.length === 1);
    await m.execute(`return (async () => { await (await ChromeUtils.importESModule("${STORE}").ready).agent.stop(); })();`);
    expect(await recents()).toEqual([]);
    await pressKeys(m, "Meta+y");
    await panelOpen(true);
    expect(await panelLinks()).toEqual([]);
    await pressKeys(m, "Escape");
    await panelOpen(false);
    await pressKeys(m, "Meta+t");
    await bar();
    await field("Page");
    await until(() => lines("onglet"), (l) => l.length > 0);
  });
});
