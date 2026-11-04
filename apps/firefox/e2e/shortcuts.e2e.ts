import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EtatNavigateur } from "../../navigateur/src/commun/modele";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inUi, missingApi, pressKeys, waitUi } from "./ui";

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
const waitTitle = (id: string, title: string) => waitState((s) => s.onglets[id]?.titre, (t) => t === title);
const barOpen = () => inUi<boolean>(m, "return !!doc.querySelector('[data-testid=\"barre-commande\"]')");
const waitBar = (open: boolean) => waitUi(m, "return !!doc.querySelector('[data-testid=\"barre-commande\"]') === arguments[0]", [open]);
/** Types `text` in the command bar field and presses Enter. */
async function submit(text: string): Promise<void> {
  await waitUi(m, "return doc.activeElement?.dataset.testid === 'saisie-commande'");
  await inUi(m, `const f = doc.activeElement; f.value = arguments[0]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [text]);
  await pressKeys(m, "Enter");
}
/** The keyboard goes to the displayed web page. */
const focusPage = () => m.execute("gBrowser.selectedBrowser.focus()");

describe("WebAiOs shortcuts", () => {
  it("⌘T opens the command bar, not a Firefox tab", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    const tabs = await m.execute<number>("return gBrowser.tabs.length");
    await focusPage();
    await pressKeys(m, "Meta+t");
    await waitBar(true);
    expect(await m.execute<number>("return gBrowser.tabs.length")).toBe(tabs);
    expect(Object.keys((await state(m)).onglets)).toEqual([a]);
  });

  it("⌘T + address opens a tab; ⌘W closes it; ⇧⌘T reopens it with its URL", async () => {
    await pressKeys(m, "Meta+t");
    await submit(server.url + "/b.html");
    const b = await waitState((s) => Object.keys(s.onglets), (ids) => ids.length === 1).then((ids) => ids[0]!);
    await waitTitle(b, "Page B");
    await pressKeys(m, "Meta+w");
    await waitState((s) => Object.keys(s.onglets).length, (n) => n === 0);
    await pressKeys(m, "Meta+Shift+t");
    const urls = await waitState((s) => Object.values(s.onglets).map((o) => o.url), (u) => u.length === 1);
    expect(urls).toEqual([server.url + "/b.html"]);
  });

  it("⌃2 activates the second space", async () => {
    const first = (await win()).espaceActif;
    await dispatch(m, { type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: (await win()).id });
    const second = (await win()).espaceActif;
    await dispatch(m, { type: "activerEspace", fenetreId: (await win()).id, id: first });
    await pressKeys(m, "Control+2");
    await waitState((s) => s.fenetres[0]!.espaceActif, (e) => e === second);
  });

  it("Firefox's next/previous tab keys do not leave the space", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await dispatch(m, { type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: (await win()).id });
    const second = (await win()).espaceActif;
    const b = await open("/b.html");
    await waitTitle(b, "Page B");
    await focusPage();
    for (const combo of ["Control+PageUp", "Control+PageDown", "Meta+Alt+ArrowLeft", "Meta+Alt+ArrowRight", "Meta+Shift+{", "Meta+Shift+}"]) {
      await pressKeys(m, combo);
      await new Promise((r) => setTimeout(r, 200));
      expect([combo, (await win()).espaceActif, await activeId()]).toEqual([combo, second, b]);
      expect(await m.execute<string | null>("return gBrowser.selectedTab.getAttribute('webaios-tab-id')")).toBe(b);
    }
  });

  it("⌘[ and ⌘] follow the tab's history", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await m.execute("window.webaiosWindow.navigate(arguments[0], arguments[1])", [a, server.url + "/b.html"]);
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
    await dispatch(m, { type: "activerOnglet", id: a });
    await focusPage();
    await pressKeys(m, "Meta+9");
    await waitState((s) => s.fenetres[0]!.actif[s.fenetres[0]!.espaceActif], (id) => id === c);
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
    await waitState((s) => Object.keys(s.onglets).length, (n) => n === 0);
    expect(await barOpen()).toBe(false);
  });

  // raccourcis.spec.ts:258
  it("⇧⌘J toggles the downloads panel", async () => {
    const shown = (v: boolean) => waitUi(m, "return !!doc.querySelector('[data-testid=\"telechargements\"]') === arguments[0]", [v]);
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
  });
});
