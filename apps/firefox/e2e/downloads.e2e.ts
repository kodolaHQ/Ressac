import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dispatch, inWindow, newWindow, state, waitFor, windowHandles } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, waitUi } from "./ui";

const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";

let server: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let dl: string;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
beforeEach(async () => {
  w = await launchWebAiOs({ env: { WEBAIOS_TEST_ADRESSES_PUBLIQUES: "127.0.0.1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  // Downloads go to the test's data dir, never to ~/Downloads.
  dl = join(w.dataDir, "dl");
  await mkdir(dl);
  await m.execute(`Services.prefs.setIntPref("browser.download.folderList", 2); Services.prefs.setStringPref("browser.download.dir", arguments[0]);`, [dl]);
});
afterEach(async () => {
  try {
    expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
  }
});

/** Opens telecharger.html in a tab and returns a function that clicks #lien in the page. */
async function openPage(): Promise<() => Promise<unknown>> {
  const before = new Set(Object.keys((await state(m)).onglets));
  const f = (await state(m)).fenetres[0]!.id;
  const s = await dispatch(m, { type: "ouvrirOnglet", fenetreId: f, url: `${server.url}/telecharger.html` });
  const id = Object.keys(s.onglets).find((i) => !before.has(i))!;
  await waitFor(m, "return gBrowser.selectedBrowser.currentURI.spec.endsWith('/telecharger.html') && !gBrowser.selectedBrowser.webProgress.isLoadingDocument", (v) => v === true);
  return async () => {
    const handle = await m.execute<string>(
      `const t = gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === arguments[0]);
       return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(t.linkedBrowser);`,
      [id],
    );
    await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
    await m.setContext("content");
    try {
      return await m.execute('document.getElementById("lien").click(); return 0');
    } finally {
      await m.setContext("chrome");
    }
  };
}
const until = async (ok: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 100))) if (Date.now() > end) throw new Error("timed out");
};
const rows = () => inUi<string[]>(m, `return [...doc.querySelectorAll('[data-testid="telechargement"]')].map((e) => e.dataset.etat)`);
const list = () => inUi<number>(m, "return (await ui.webaios.telechargements.liste()).length");
const unfinished = () => inUi<number>(m, "return (await ui.webaios.telechargements.liste()).filter((t) => t.etat === 'en-cours').length");

describe("downloads", () => {
  it("a file from the test server arrives, ends « termine »; the second gets Firefox's free name", async () => {
    const click1 = await openPage();
    await click1();
    await until(() => existsSync(join(dl, "fichier.txt")));
    await waitUi(m, "return (await ui.webaios.telechargements.liste()).some((t) => t.etat === 'termine')");
    await click1();
    await until(() => existsSync(join(dl, "fichier(1).txt")));
    expect(readFileSync(join(dl, "fichier.txt"), "utf8")).toContain("Bonjour");
    await click(m, 'button[aria-label="Téléchargements"]');
    await waitUi(m, `return doc.querySelectorAll('[data-testid="telechargements"] [data-testid="telechargement"]').length === 2`);
    const first = await inUi<{ etat: string; text: string; show: boolean }>(
      m,
      `const e = doc.querySelector('[data-testid="telechargement"]');
       return { etat: e.dataset.etat, text: e.textContent, show: [...e.querySelectorAll("button")].some((b) => b.textContent.includes("Afficher dans le Finder")) };`,
    );
    expect(first.etat).toBe("termine");
    expect(first.text).toContain("fichier(1).txt");
    expect(first.show).toBe(true);
  });

  it("no native panel or window opens", async () => {
    const windows = (await windowHandles(m)).length;
    const click1 = await openPage();
    await click1();
    await until(() => existsSync(join(dl, "fichier.txt")));
    await waitUi(m, "return (await ui.webaios.telechargements.liste()).some((t) => t.etat === 'termine')");
    expect(await m.execute<string | null>(`return document.getElementById("downloadsPanel")?.state ?? null`)).not.toBe("open");
    expect((await windowHandles(m)).length).toBe(windows);
  });

  it("a cancelled download shows « Annulé »; the next one goes through", async () => {
    const click1 = await openPage();
    await m.execute(
      `return (async () => {
        const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
        const d = await Downloads.createDownload({ source: arguments[0], target: arguments[1] });
        (await Downloads.getList(Downloads.ALL)).add(d);
        d.start().catch(() => {});
      })();`,
      [`${server.url}/fichier-lent`, join(dl, "lent.bin")],
    );
    await click(m, 'button[aria-label="Téléchargements"]');
    await waitUi(m, `return doc.querySelector('[data-testid="telechargement"]')?.dataset.etat === "en-cours" && !!doc.querySelector("button.telechargements .pastille")`);
    await click(m, '[data-testid="telechargement"] button', { text: "Annuler" });
    await waitUi(m, `return doc.querySelector('[data-testid="telechargement"]')?.dataset.etat === "annule" && !doc.querySelector(".pastille")`);
    await click1();
    await waitUi(m, `return doc.querySelector('[data-testid="telechargement"]')?.dataset.etat === "termine"`);
    expect(await rows()).toEqual(["termine", "annule"]);
  });

  it("both windows show the button and the same list", async () => {
    const click1 = await openPage();
    await click1();
    await waitUi(m, "return (await ui.webaios.telechargements.liste()).some((t) => t.etat === 'termine')");
    const other = await newWindow(m);
    await inWindow(m, other, async () => {
      await waitUi(m, `return !!doc.querySelector('button[aria-label="Téléchargements"]')`);
      expect(await list()).toBe(1);
    });
    expect(await unfinished()).toBe(0);
  });
});
