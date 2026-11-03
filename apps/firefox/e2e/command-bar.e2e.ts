import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EtatNavigateur } from "../../navigateur/src/commun/modele";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inUi, missingApi, pixel, pressKeys, waitUi } from "./ui";

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
const waitBar = (open: boolean) => waitUi(m, "return !!doc.querySelector('[data-testid=\"barre-commande\"]') === arguments[0]", [open]);
/** The bar's field has the keyboard: focused in the UI, and the UI iframe focused in the window. */
const fieldFocused = () =>
  waitUi(m, "return doc.activeElement?.dataset.testid === 'saisie-commande' && document.activeElement === document.getElementById('webaios-sidebar')");
const fieldValue = () => inUi<string>(m, "return doc.querySelector('[data-testid=\"saisie-commande\"]').value");
async function type(text: string): Promise<void> {
  await fieldFocused();
  await inUi(m, `const f = doc.activeElement; f.value = arguments[0]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [text]);
}
const selectedType = () => inUi<string | undefined>(m, "return doc.querySelector('[data-testid=\"ligne-commande\"][aria-selected=\"true\"]')?.dataset.type");
async function withPageA(): Promise<string> {
  const a = await open("/a.html");
  await waitTitle(a, "Page A");
  return a;
}

describe("Command bar", () => {
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
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"page-vide\"]')");
    await waitBar(false);
  });

  it("⌘T + an address opens a new tab", async () => {
    const a = await withPageA();
    await pressKeys(m, "Meta+t");
    await type(server.url + "/b.html");
    await pressKeys(m, "Enter");
    const ids = await waitState((s) => Object.keys(s.onglets), (i) => i.length === 2);
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
    expect(Object.keys((await state(m)).onglets)).toEqual([a]);
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
    await dispatch(m, { type: "activerOnglet", id: a });
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
    await waitUi(m, "return doc.querySelectorAll('[data-testid=\"ligne-commande\"][data-type=\"onglet\"]').length === 1");
    await pressKeys(m, "ArrowDown");
    await pressKeys(m, "Enter");
    await waitState((s) => s.fenetres[0]!.actif[s.fenetres[0]!.espaceActif], (id) => id === a);
    expect(Object.keys((await state(m)).onglets)).toHaveLength(2);
  });

  it("↑ and ↓ loop over the lines", async () => {
    await withPageA();
    await pressKeys(m, "Meta+t");
    await type("Page A");
    await waitUi(m, "return doc.querySelectorAll('[data-testid=\"ligne-commande\"][data-type=\"onglet\"]').length === 1");
    expect(await selectedType()).toBe("defaut");
    await pressKeys(m, "ArrowUp");
    expect(await selectedType()).toBe("onglet");
    await pressKeys(m, "ArrowDown");
    expect(await selectedType()).toBe("defaut");
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
    expect(await inUi(m, "return doc.querySelector('.fenetre').hasAttribute('inert')")).toBe(true);
    await pressKeys(m, "Escape");
    await waitUi(m, "return !doc.querySelector('.fenetre').hasAttribute('inert')");
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
});
