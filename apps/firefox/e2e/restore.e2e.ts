import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inUi, pressKeys, waitUi } from "./ui";

let server: Awaited<ReturnType<typeof startServer>>;
let dataDir: string;
let profile: string;
let w: LaunchedWebAiOs | undefined;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());
afterEach(async () => {
  await w?.close();
  w = undefined;
  await rm(dataDir, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
});

/** Launches on the shared dataDir/profile (created on first use) and waits until the window has loaded its state. */
async function start(): Promise<Marionette> {
  dataDir ??= await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile ??= await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  w = await launchWebAiOs({ dataDir, profile });
  const m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"barre-laterale\"]')");
  return m;
}
/** Quits the way a user would, then forgets the instance (the folders stay for the next start). */
async function quit(): Promise<void> {
  await w!.close();
  w = undefined;
}
const win = async (m: Marionette) => (await state(m)).fenetres[0]!;
const marked = (m: Marionette) => m.execute<number>("return gBrowser.tabs.filter((t) => t.hasAttribute('webaios-tab-id')).length");

// Each test starts from fresh folders.
const fresh = () => {
  dataDir = undefined as never;
  profile = undefined as never;
};

describe("restore at startup", () => {
  it("restores tabs, spaces, pins, essentials and the active tab of each space", async () => {
    fresh();
    let m = await start();
    const fenetreId = (await win(m)).id;
    const open = async (p: string, activer = false) => {
      const before = new Set(Object.keys((await state(m)).onglets));
      const after = await dispatch(m, { type: "ouvrirOnglet", fenetreId, url: server.url + p, activer });
      return Object.keys(after.onglets).find((id) => !before.has(id))!;
    };
    const a = await open("/a.html");
    const b = await open("/b.html");
    await open("/texte.html", true);
    await dispatch(m, { type: "epinglerOnglet", id: a });
    await dispatch(m, { type: "ajouterEssentiel", id: b });
    await dispatch(m, { type: "creerEspace", nom: "Boulot", icone: "💼", prive: false, profil: "defaut", fenetreId } as Action);
    const boulot = (await state(m)).espaces.find((e) => e.nom === "Boulot")!;
    const c = await open("/b.html?n=1", true);
    const before = await state(m);
    await quit();

    m = await start();
    const after = await state(m);
    expect(after.espaces.map((e) => [e.nom, e.icone, e.epingles.length])).toEqual(before.espaces.map((e) => [e.nom, e.icone, e.epingles.length]));
    expect(after.essentiels).toEqual(before.essentiels);
    const f = after.fenetres[0]!;
    expect(f.espaceActif).toBe(boulot.id);
    expect(f.actif).toEqual(before.fenetres[0]!.actif);
    expect(f.actif[boulot.id]).toBe(c);
    expect(f.ordre).toEqual(before.fenetres[0]!.ordre);
    // The active tab of the active space is displayed.
    await waitFor(m, "return gBrowser.selectedTab.getAttribute('webaios-tab-id')", (v) => v === c);
  });

  it("keeps a cookie set by a local server, in the space's own container found by name", async () => {
    fresh();
    let m = await start();
    const fenetreId = (await win(m)).id;
    await dispatch(m, { type: "creerEspace", nom: "Propre", icone: "🔒", prive: false, profil: "nouveau", fenetreId } as Action);
    const open = async (p: string) => {
      const before = new Set(Object.keys((await state(m)).onglets));
      const after = await dispatch(m, { type: "ouvrirOnglet", fenetreId, url: server.url + p });
      return Object.keys(after.onglets).find((id) => !before.has(id))!;
    };
    const title = (id: string, t: string) => waitFor(m, `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready).state.onglets[${JSON.stringify(id)}]?.titre)();`, (v) => v === t);
    await title(await open("/cookie"), "cookie");
    await quit();

    m = await start();
    await title(await open("/lire-cookie"), "essai=1");
  });

  it("100 restored tabs: one marked XUL tab (the active one) besides the parking tab; activating another creates a second", async () => {
    fresh();
    let m = await start();
    const fenetreId = (await win(m)).id;
    await m.execute(
      `return (async () => {
        const store = await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready;
        for (let i = 0; i < 100; i++) store.dispatch({ type: "ouvrirOnglet", fenetreId: arguments[0], url: arguments[1] + "/b.html?n=" + i, activer: i === 99 });
        await store.flush();
      })();`,
      [fenetreId, server.url],
    );
    expect(await marked(m)).toBe(1);
    await quit();

    m = await start();
    const f = await win(m);
    expect(f.ordre[f.espaceActif]).toHaveLength(100);
    expect(await marked(m)).toBe(1);
    expect(await m.execute<number>("return gBrowser.tabs.length")).toBe(2);
    await dispatch(m, { type: "activerOnglet", id: f.ordre[f.espaceActif]![0]! });
    await waitFor(m, "return gBrowser.tabs.filter((t) => t.hasAttribute('webaios-tab-id')).length", (n) => n === 2);
  });

  it("keeps the chosen search engine and uses it from ⌘T", async () => {
    fresh();
    let m = await start();
    await dispatch(m, { type: "choisirMoteur", moteur: "duckduckgo" });
    await quit();

    m = await start();
    expect((await state(m)).reglages.moteur).toBe("duckduckgo");
    // No network in tests: watch the requests and cancel them.
    await m.execute(`
      window.webaiosRequests = [];
      Services.obs.addObserver({ observe(ch) { ch.QueryInterface(Ci.nsIChannel); if (ch.URI.host === "duckduckgo.com") { window.webaiosRequests.push(ch.URI.spec); ch.cancel(Cr.NS_ERROR_ABORT); } } }, "http-on-modify-request");
    `);
    await pressKeys(m, "Meta+t");
    await waitUi(m, "return doc.activeElement?.dataset.testid === 'saisie-commande'");
    await inUi(m, `const f = doc.activeElement; f.value = "chat"; f.dispatchEvent(new ui.Event("input", { bubbles: true }));`);
    await pressKeys(m, "Enter");
    await waitFor(m, "return window.webaiosRequests", (r: string[]) => r.includes("https://duckduckgo.com/?q=chat"));
  });

  it("a change made right before quitting survives (no wait for the 500 ms recorder)", async () => {
    fresh();
    let m = await start();
    await dispatch(m, { type: "choisirMoteur", moteur: "qwant" });
    await quit(); // straight after the dispatch
    m = await start();
    expect((await state(m)).reglages.moteur).toBe("qwant");
  });

  it("an unreadable session: one notification, with the .corrompu path", async () => {
    fresh();
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    await writeFile(path.join(dataDir, "session.json"), "{ not json");
    const m = await start();
    const aside = (await readdir(dataDir)).find((n) => n.endsWith(".corrompu"))!;
    const text = await waitFor<string[]>(
      m,
      `return (async () => { const nb = window.gNotificationBox; return [...nb.allNotifications].filter((n) => n.getAttribute("value") === "webaios-session-set-aside").map((n) => n.label?.textContent ?? n.messageText?.textContent ?? n.label ?? ""); })();`,
      (v) => v.length > 0,
    );
    await new Promise((r) => setTimeout(r, 500)); // a duplicate would show up by now
    const again = await m.execute<number>(`return [...window.gNotificationBox.allNotifications].filter((n) => n.getAttribute("value") === "webaios-session-set-aside").length`);
    expect(again).toBe(1);
    expect(text).toHaveLength(1);
    expect(text[0]).toContain(path.join(dataDir, aside));
    expect(text[0]).toContain("WebAiOs repart avec une session neuve");
  });
});
