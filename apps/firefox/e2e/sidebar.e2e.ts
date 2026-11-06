import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import type { EtatNavigateur } from "../../navigateur/src/commun/modele";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, pixel, pressKeys, waitUi } from "./ui";

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
async function open(path: string, extra: Partial<Extract<Action, { type: "ouvrirOnglet" }>> = {}): Promise<string> {
  const before = new Set(Object.keys((await state(m)).onglets));
  const after = await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await win()).id, url: server.url + path, ...extra });
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

/** The tab list as shown: ids in order, and the one marked current. */
const shownTabs = () =>
  inUi<{ ids: string[]; current: string | null }>(
    m,
    `const lis = [...doc.querySelectorAll('[data-testid^="onglet-"]')];
     return { ids: lis.map((li) => li.dataset.testid.slice(7)), current: lis.find((li) => li.getAttribute("aria-current") === "page")?.dataset.testid.slice(7) ?? null };`,
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
    `return !!doc.querySelector('[data-testid="page-vide"]') && doc.activeElement?.dataset.testid === "saisie-page-vide"
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
  it("drags the window from its empty areas only, and leaves the page the whole height", async () => {
    await open("/icone");
    await waitUi(m, `return !frame.hasAttribute("full");`);
    const drag = await inUi<Record<string, string>>(
      m,
      `${DRAGGING} return { allowed: frame.contentWindow.docShell.windowDraggingAllowed, sidebar: of(".barre"), button: of(".navigation button"), address: of(".ligne"), tabs: of(".defilant"), footer: of("footer") };`,
    );
    expect(drag).toEqual({ allowed: true, sidebar: "drag", button: "no-drag", address: "no-drag", tabs: "no-drag", footer: "no-drag" });
    expect(await m.execute(`const r = gBrowser.selectedBrowser.getBoundingClientRect(); return [r.top, r.height - window.innerHeight];`)).toEqual([0, 0]);
    // Under an overlay the sidebar's area belongs to the overlay.
    await pressKeys(m, "Meta+t");
    await waitUi(m, `${DRAGGING} return of(".barre") === "default";`);
  });

  it("shows the extensions inside the address pill and the space above the tabs", async () => {
    const shown = await inUi<{ menuIn: boolean; pill: number; space: string; gap: number }>(
      m,
      `const pill = doc.querySelector(".ligne").getBoundingClientRect(), menu = doc.querySelector('[data-testid="menu-extensions"]').getBoundingClientRect();
       const tiles = doc.querySelector('[data-testid="essentiels"]').getBoundingClientRect();
       return { menuIn: menu.right <= pill.right && menu.top >= pill.top && menu.bottom <= pill.bottom, pill: pill.height, gap: tiles.top - pill.bottom,
         space: doc.querySelector('[data-testid="titre-espace"]').textContent };`,
    );
    const espace = (await state(m)).espaces[0]!;
    expect(shown).toEqual({ menuIn: true, pill: 34, gap: 14, space: `${espace.icone} ${espace.nom}` });
    // The panel opens under the pill, which keeps its height.
    await click(m, '[data-testid="menu-extensions"]');
    const panel = await waitUi<{ top: number; bottom: number } | null>(
      m,
      `const p = doc.querySelector('[data-testid="panneau-extensions"]'); return p && { top: p.getBoundingClientRect().top, bottom: doc.querySelector("form").getBoundingClientRect().bottom };`,
    );
    expect(panel!.top).toBeGreaterThanOrEqual(panel!.bottom);
  });
});

describe("WebAiOs sidebar", () => {
  it("“Nouvel onglet” shows the empty page with its field focused; Enter opens the address", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(m, '[data-testid="nouvel-onglet"]');
    await emptyPageFocused();
    await inUi(m, `const f = doc.querySelector('[data-testid="saisie-page-vide"]'); f.value = arguments[0]; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`, [
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
    await click(m, `[data-testid="onglet-${b}"]`);
    await waitShown((t) => t.current === b);
    await click(m, `[data-testid="onglet-${b}"] button[aria-label="Fermer l'onglet"]`);
    const shown = await waitShown((t) => t.ids.length === 2);
    expect(shown).toEqual({ ids: [a, c], current: c });
  });

  it("drag and drop reorders the list and the state", async () => {
    const a = await open("/a.html", { activer: false });
    const b = await open("/b.html", { activer: false });
    const c = await open("/texte.html", { activer: false });
    await waitShown((t) => t.ids.length === 3);
    // c dropped on the top half of a: before it.
    await inUi(
      m,
      `const dt = new ui.DataTransfer();
       dt.setData("application/x-webaios-onglet", arguments[0]);
       const target = doc.querySelector('[data-testid="onglet-' + arguments[1] + '"]');
       const r = target.getBoundingClientRect();
       for (const type of ["dragover", "drop"])
         target.dispatchEvent(new ui.DragEvent(type, { dataTransfer: dt, clientX: r.left + 10, clientY: r.top + 2, bubbles: true, cancelable: true }));`,
      [c, a],
    );
    expect((await waitShown((t) => t.ids[0] === c)).ids).toEqual([c, a, b]);
    const f = await win();
    expect(f.ordre[f.espaceActif]).toEqual([c, a, b]);
  });

  it("right click → “Épingler” pins the tab in this space only", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(m, `[data-testid="onglet-${a}"]`, { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Épingler" });
    await waitShown((t) => t.ids.length === 0);
    const pinned = '[data-testid="epingles"] [data-testid^="favori-"]';
    expect(await count(pinned)).toBe(1);
    await dispatch(m, { type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: (await win()).id });
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 0", [pinned]);
  });

  it("an essential is visible in every space", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(m, `[data-testid="onglet-${a}"]`, { button: 2 });
    await click(m, '[role="menuitem"]', { text: "Ajouter aux essentiels" });
    const essentials = '[data-testid="essentiels"] [data-testid^="favori-"]';
    await waitUi(m, "return doc.querySelectorAll(arguments[0]).length === 1", [essentials]);
    await dispatch(m, { type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: (await win()).id });
    const boulot = (await win()).espaceActif;
    await waitUi(m, "return doc.querySelector(arguments[0])?.getAttribute('aria-current') === 'true'", [`[data-testid="espace-${boulot}"]`]);
    expect(await count(essentials)).toBe(1);
  });

  it("switching spaces shows its tabs and finds each space's active tab", async () => {
    const home = (await win()).espaceActif;
    const a = await open("/a.html");
    const p = await open("/plante.html", { activer: false });
    await dispatch(m, { type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId: (await win()).id });
    const boulot = (await win()).espaceActif;
    const b = await open("/b.html");
    expect(await waitShown((t) => t.ids.length === 1)).toEqual({ ids: [b], current: b });
    await click(m, `[data-testid="espace-${home}"]`);
    expect(await waitShown((t) => t.ids.length === 2)).toEqual({ ids: [a, p], current: a });
    await click(m, `[data-testid="espace-${boulot}"]`);
    expect(await waitShown((t) => t.ids.length === 1)).toEqual({ ids: [b], current: b });
  });

  it("closing the last tab shows the empty page with its field focused", async () => {
    const a = await open("/a.html");
    await waitTitle(a, "Page A");
    await click(m, `[data-testid="onglet-${a}"] button[aria-label="Fermer l'onglet"]`);
    await emptyPageFocused();
  });

  it("shows the web page right of the sidebar", async () => {
    const id = await open("/icone");
    await waitTitle(id, "icone");
    // The UI shrinks to its column once a web page is displayed.
    await waitFor(m, "return document.getElementById('webaios-sidebar').hasAttribute('full')", (v) => v === false);
    const bar = await inUi<string>(m, "return ui.getComputedStyle(doc.querySelector('[data-testid=\"barre-laterale\"]')).backgroundColor");
    // The page may paint a moment after its title arrives.
    for (let i = 0; i < 50 && (await pixel(m, 900, 400)).join() !== "255,0,0"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await pixel(m, 900, 400)).toEqual([255, 0, 0]);
    expect(`rgb(${(await pixel(m, 100, 400)).join(", ")})`).toBe(bar);
    // The empty page covers the page: the UI paints above Firefox's tab box.
    await dispatch(m, { type: "afficherPageVide", fenetreId: (await win()).id });
    const empty = await waitUi<string>(m, "const p = doc.querySelector('[data-testid=\"page-vide\"]'); return p && ui.getComputedStyle(p.parentElement).backgroundColor");
    for (let i = 0; i < 50 && `rgb(${(await pixel(m, 900, 400)).join(", ")})` !== empty; i++) await new Promise((r) => setTimeout(r, 100));
    expect(`rgb(${(await pixel(m, 900, 400)).join(", ")})`).toBe(empty);
  });

  it("shows an internal webaios: page as not yet available", async () => {
    await dispatch(m, { type: "ouvrirApplications", fenetreId: (await win()).id });
    const text = await waitUi<string>(m, "return doc.querySelector('[data-testid=\"page-interne\"]')?.textContent");
    expect(text).toBe("Pas encore disponible dans WebAiOs-Firefox.");
    expect(await m.execute("return document.getElementById('webaios-sidebar').hasAttribute('full')")).toBe(true);
  });

  it("shows the favicon a page declares", async () => {
    const id = await open("/icone");
    await waitTitle(id, "icone");
    await waitUi(m, "const img = doc.querySelector(arguments[0]); return !!img && img.complete && img.naturalWidth > 0", [`[data-testid="onglet-${id}"] img`]);
  });
});
