import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EtatNavigateur } from "../shared/modele";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inUi, keyDown, keyUp, missingApi, pressKeys, waitUi } from "./ui";

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
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"barre-laterale\"]')");
});
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
  }
});

const win = async () => (await state(m)).fenetres[0]!;
const activeId = async () => {
  const f = await win();
  return f.actif[f.espaceActif] ?? null;
};
async function open(path: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).onglets));
  const after = await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await win()).id, url: server.url + path });
  return Object.keys(after.onglets).find((id) => !before.has(id))!;
}
async function waitState<T>(read: (s: EtatNavigateur) => T, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read(await state(m));
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const waitActive = (id: string) => waitState((s) => s.fenetres[0]!.actif[s.fenetres[0]!.espaceActif], (a) => a === id);
const waitTitle = (id: string, title: string) => waitState((s) => s.onglets[id]?.titre, (t) => t === title);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PANEL = '[data-testid="panneau-onglets"]';
const panelShown = () => inUi<boolean>(m, `return !!doc.querySelector('${PANEL}')`);
const waitPanel = (shown: boolean) => waitUi(m, `return !!doc.querySelector('${PANEL}') === arguments[0]`, [shown]);
/** Index of the selected card, and the card count. */
const cards = () =>
  inUi<[number, number]>(m, `const c = [...doc.querySelectorAll('${PANEL} [data-testid="carte-onglet"]')]; return [c.findIndex((e) => e.getAttribute("aria-selected") === "true"), c.length];`);
const waitCards = (selected: number, count: number) =>
  waitUi(
    m,
    `const c = [...doc.querySelectorAll('${PANEL} [data-testid="carte-onglet"]')]; return c.length === arguments[1] && c[arguments[0]]?.getAttribute("aria-selected") === "true";`,
    [selected, count],
  );
/** The displayed web page has the keyboard. */
const pageFocused = () => m.execute<boolean>("return Services.focus.focusedElement === gBrowser.selectedBrowser");
const focusPage = () => m.execute("gBrowser.selectedBrowser.focus()");
/** a, b, c opened in that order: c is active, the recent order is c, b, a. */
async function threeTabs(): Promise<[string, string, string]> {
  const a = await open("/a.html");
  const b = await open("/b.html");
  const c = await open("/texte.html");
  await waitTitle(b, "Page B");
  await waitActive(c);
  return [a, b, c];
}

describe("⌃Tab", () => {
  it("a brief ⌃Tab goes back to the previous tab, one step only, without a panel", async () => {
    const [, b] = await threeTabs();
    await focusPage();
    await pressKeys(m, "Control+Tab");
    await waitActive(b);
    await sleep(300);
    expect(await panelShown()).toBe(false);
    // Firefox's own ⌃Tab did not move as well: the selected XUL tab is the active WebAiOs tab.
    expect(await m.execute<string>("return gBrowser.selectedTab.getAttribute('webaios-tab-id')")).toBe(b);
    expect(await activeId()).toBe(b);
  });

  it("a held ⌃Tab opens the panel; Tab advances; releasing ⌃ activates the selection", async () => {
    const [a] = await threeTabs();
    await focusPage();
    await keyDown(m, "Control");
    await pressKeys(m, "Tab");
    await waitCards(1, 3);
    await pressKeys(m, "Tab");
    await waitCards(2, 3);
    await keyUp(m, "Control");
    await waitPanel(false);
    await waitActive(a);
  });

  it("Escape cancels: the tab does not change; closed, the panel gives the keyboard back to the page", async () => {
    const [, , c] = await threeTabs();
    await focusPage();
    await keyDown(m, "Control");
    await pressKeys(m, "Tab");
    await waitCards(1, 3);
    await pressKeys(m, "Escape");
    await waitPanel(false);
    await keyUp(m, "Control");
    await sleep(300);
    expect(await activeId()).toBe(c);
    await waitFor(m, "return Services.focus.focusedElement === gBrowser.selectedBrowser", (v) => v === true);
    // Released: same.
    await keyDown(m, "Control");
    await pressKeys(m, "Tab");
    await waitCards(1, 3);
    await keyUp(m, "Control");
    await waitPanel(false);
    await waitFor(m, "return Services.focus.focusedElement === gBrowser.selectedBrowser", (v) => v === true);
    // raccourcis.spec.ts:145, brief press: the UI never took the keyboard, so it gives nothing back.
    await m.execute(`window.webaiosTestUiFocus = 0;
      document.getElementById("webaios-sidebar").addEventListener("focus", () => window.webaiosTestUiFocus++);`);
    await pressKeys(m, "Control+Tab");
    await waitActive(c);
    await sleep(300);
    expect(await m.execute("return window.webaiosTestUiFocus")).toBe(0);
    expect(await pageFocused()).toBe(true);
  });

  it("over the command bar, Escape closes the panel only", async () => {
    const [, , c] = await threeTabs();
    await pressKeys(m, "Meta+t");
    await waitUi(m, "return doc.activeElement?.dataset.testid === 'saisie-commande'");
    await keyDown(m, "Control");
    await pressKeys(m, "Tab");
    await waitCards(1, 3);
    await pressKeys(m, "Escape");
    await waitPanel(false);
    await keyUp(m, "Control");
    await sleep(300);
    expect(await inUi<boolean>(m, "return !!doc.querySelector('[data-testid=\"barre-commande\"]')")).toBe(true);
    expect(await activeId()).toBe(c);
    expect(await pageFocused()).toBe(false);
  });

  it("a page that swallows every key: ⌃Tab still switches tabs", async () => {
    const a = await open("/a.html");
    const s = await open("/avale");
    await waitTitle(s, "avale");
    await focusPage();
    await pressKeys(m, "Control+Tab");
    await waitActive(a);
    // Held, with the panel, from the swallowing page again.
    await dispatch(m, { type: "activerOnglet", id: s });
    await focusPage();
    await keyDown(m, "Control");
    await pressKeys(m, "Tab");
    await waitCards(1, 2);
    expect((await cards())[1]).toBe(2);
    await keyUp(m, "Control");
    await waitPanel(false);
    await waitActive(a);
  });

  // raccourcis.spec.ts:173
  it("a card under a motionless mouse does not take the selection; a real move does", async () => {
    const [, , c] = await threeTabs();
    await focusPage();
    // Where the first card is, then close without changing anything.
    await keyDown(m, "Control");
    await pressKeys(m, "Tab");
    await waitCards(1, 3);
    const box = await inUi<{ x: number; y: number }>(
      m,
      `const r = doc.querySelector('${PANEL} [data-testid="carte-onglet"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`,
    );
    await pressKeys(m, "Escape");
    await waitPanel(false);
    await keyUp(m, "Control");
    const move = (x: number, y: number) => m.execute("window.synthesizeMouseEvent('mousemove', arguments[0], arguments[1], {})", [x, y]);
    await move(box.x, box.y);
    // The panel shows up under the motionless mouse: the selection stays the keyboard's.
    await keyDown(m, "Control");
    await pressKeys(m, "Tab");
    await waitCards(1, 3);
    await sleep(300);
    expect(await cards()).toEqual([1, 3]);
    // Its content changes (next step) under the still motionless mouse: same.
    await pressKeys(m, "Tab");
    await waitCards(2, 3);
    await sleep(300);
    expect(await cards()).toEqual([2, 3]);
    // A real move over the card selects it.
    for (let i = 1; i <= 3; i++) await move(box.x + 2 * i, box.y + i);
    await waitCards(0, 3);
    await keyUp(m, "Control");
    await waitPanel(false);
    await waitActive(c);
  });
});
