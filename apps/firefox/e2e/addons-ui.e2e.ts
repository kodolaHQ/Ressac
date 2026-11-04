import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { button, cleanupXpis, installAddon } from "./addons";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, waitUi } from "./ui";

// The sidebar's add-on strip (ui/ExtensionsStrip.svelte) over the window side (chrome/window/addons.ts).

const ID = "button@webaios.test";
let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
beforeAll(async () => (server = await startServer()));
afterAll(async () => {
  await server?.close();
  await cleanupXpis();
});
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

const BTN = '[data-testid="action-extension"]';
const MENU = '[data-testid="menu-extensions"]';
const PANEL = '[data-testid="panneau-extensions"]';
const fenetre = async () => (await state(m)).fenetres[0]!;
async function open(path: string): Promise<void> {
  const url = server.url + path;
  await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await fenetre()).id, url });
  await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`, (v) => v === true);
}
const setPinned = (ids: string[]) => m.execute("Services.prefs.setStringPref('webaios.extensions.pinned', arguments[0])", [JSON.stringify(ids)]);
const popupOpen = () => m.execute<boolean>("return !!document.querySelector('browser.webextension-popup-browser')");
const openMenu = () => click(m, MENU);

describe("add-on strip, sidebar", () => {
  it("a pinned add-on has its button in the bar; a click opens its popup", async () => {
    await setPinned([ID]);
    await installAddon(m, button());
    await open("/texte.html");
    await waitUi(m, `const b = doc.querySelector('[data-testid="barre-extensions"] ${BTN}'); return b && !b.disabled`);
    const b = await inUi<any>(m, `const b = doc.querySelector(${JSON.stringify(BTN)}); return { title: b.title, image: b.style.backgroundImage, noIcon: b.classList.contains("no-icon") };`);
    expect(b.title).toBe("Bouton de test");
    expect(b.image).toContain("moz-extension://");
    expect(b.noIcon).toBe(false);
    await click(m, BTN);
    const r = await waitFor<any>(
      m,
      `const popup = document.querySelector("browser.webextension-popup-browser");
       const panel = popup?.closest("panel");
       if (popup?.contentTitle !== "Popup de test prête" || panel?.state !== "open") return null;
       const frame = document.getElementById("webaios-sidebar");
       const f = frame.getBoundingClientRect();
       const bb = frame.contentDocument.querySelector(${JSON.stringify(BTN)}).getBoundingClientRect();
       const a = document.getElementById("webaios-action-anchor").getBoundingClientRect();
       return { anchorId: panel.anchorNode?.id, dx: a.x - (f.x + frame.clientLeft + bb.x), dy: a.y - (f.y + frame.clientTop + bb.y) };`,
      (v) => v !== null,
    );
    expect(r.anchorId).toBe("webaios-action-anchor");
    expect(Math.abs(r.dx)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.dy)).toBeLessThanOrEqual(1);
  });

  it("without a web page the button is greyed: no popup", async () => {
    await setPinned([ID]);
    await installAddon(m, button());
    const disabled = (want: boolean) => waitUi(m, `return doc.querySelector(${JSON.stringify(BTN)})?.disabled === ${want}`);
    await disabled(true);
    await open("/texte.html");
    await disabled(false);
    await dispatch(m, { type: "ouvrirApplications", fenetreId: (await fenetre()).id });
    await disabled(true);
    await inUi(m, `doc.querySelector(${JSON.stringify(BTN)}).click()`);
    await new Promise((r) => setTimeout(r, 1000));
    expect(await popupOpen()).toBe(false);
  });

  it("the menu lists an unpinned add-on; Épingler puts it on the bar", async () => {
    await installAddon(m, button());
    await openMenu();
    const row = '[data-testid="ligne-barre-extension"]';
    await waitUi(m, `const l = doc.querySelector(${JSON.stringify(row)}); return l?.querySelector(${JSON.stringify(BTN)}) && l.textContent.includes("Épingler")`);
    expect(await inUi(m, `return doc.querySelectorAll('[data-testid="barre-extensions"] ${BTN}').length`)).toBe(0);
    await click(m, `${row} .lien`, { text: "Épingler" });
    await waitUi(m, `return doc.querySelectorAll('[data-testid="barre-extensions"] ${BTN}').length === 1`);
    expect(await m.execute("return Services.prefs.getStringPref('webaios.extensions.pinned')")).toContain(ID);
    await waitUi(m, `return doc.querySelector(${JSON.stringify(row)})?.textContent.includes("Détacher")`);
  });

  it("a long name is cut; Épingler stays whole", async () => {
    await installAddon(m, button({ name: "Une extension au nom vraiment beaucoup trop long pour la barre" }));
    await openMenu();
    const r = await waitUi<any>(
      m,
      `const panel = doc.querySelector(${JSON.stringify(PANEL)});
       const line = panel?.querySelector('[data-testid="ligne-barre-extension"]');
       if (!line) return null;
       const b = line.querySelector(".lien"), nom = line.querySelector(".nom");
       const side = doc.querySelector('[data-testid="barre-laterale"]').getBoundingClientRect();
       const inside = (r, c) => r.left >= c.left - 0.5 && r.right <= c.right + 0.5;
       return {
         buttonWhole: b.scrollWidth <= b.clientWidth + 0.5,
         nameCut: [getComputedStyle(nom).textOverflow, nom.scrollWidth > nom.clientWidth],
         inPanel: inside(b.getBoundingClientRect(), panel.getBoundingClientRect()) && inside(line.getBoundingClientRect(), panel.getBoundingClientRect()),
         inSidebar: inside(panel.getBoundingClientRect(), side),
       };`,
    );
    expect(r).toEqual({ buttonWhole: true, nameCut: ["ellipsis", true], inPanel: true, inSidebar: true });
  });

  it("Gérer les extensions opens about:addons", async () => {
    await openMenu();
    await click(m, `${PANEL} .gerer`, { text: "Gérer les extensions" });
    await waitUi(m, `return !doc.querySelector(${JSON.stringify(PANEL)})`);
    const f = await waitFor(m, "return window.webaiosWindow.store.state", (st: any) => Object.values(st.onglets).some((o: any) => o.url.startsWith("about:addons")));
    const fen = f.fenetres[0];
    expect(f.onglets[fen.actif[fen.espaceActif]].url).toMatch(/^about:addons/);
  });

  it("Trouver des modules opens AMO in a tab", async () => {
    await openMenu();
    await click(m, `${PANEL} .gerer`, { text: "Trouver des modules" });
    await waitUi(m, `return !doc.querySelector(${JSON.stringify(PANEL)})`);
    const f = await waitFor(m, "return window.webaiosWindow.store.state", (st: any) => Object.values(st.onglets).some((o: any) => o.url === "https://addons.mozilla.org/fr/firefox/"));
    const tab: any = Object.values(f.onglets).find((o: any) => o.url === "https://addons.mozilla.org/fr/firefox/");
    expect(tab.espaceId).toBe(f.fenetres[0].espaceActif);
  });

  it("a pending update shows a dot and Revoir la mise à jour", async () => {
    await m.execute(
      `const { ExtensionsUI } = ChromeUtils.importESModule("resource:///modules/ExtensionsUI.sys.mjs");
       window.reviewed = [];
       ExtensionsUI.showUpdate = (browser, info) => window.reviewed.push(info.addon.id);
       ExtensionsUI.updates.add(arguments[0]);
       ExtensionsUI.emit("change");`,
      [{ addon: { id: ID, name: "Bouton de test" } }],
    );
    await waitUi(m, `return !!doc.querySelector('${MENU} .point')`);
    await openMenu();
    const line = '[data-testid="maj-extension"]';
    await waitUi(m, `return doc.querySelector(${JSON.stringify(line)})?.textContent.includes("Bouton de test : mise à jour en attente de ton accord.")`);
    await click(m, `${line} .lien`, { text: "Revoir la mise à jour" });
    await waitFor(m, "return window.reviewed", (l: string[]) => l.length === 1 && l[0] === ID);
  });
});
