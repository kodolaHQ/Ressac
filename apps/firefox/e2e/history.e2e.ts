import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import type { Visite } from "../../navigateur/src/commun/modele";
import { dispatch, inWindow, newWindow, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { inUi } from "./ui";

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
  w = await launchWebAiOs({ env: { WEBAIOS_TEST_ADRESSES_PUBLIQUES: "127.0.0.1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
});
afterEach(() => w?.close());

const recents = () => inUi<Visite[]>(m, "return JSON.parse(JSON.stringify(await ui.webaios.historique.recents()));");
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
const fenetre = async () => (await state(m)).fenetres[0]!.id;
const open = (url: string, fenetreId?: string) =>
  fenetre().then((f) => dispatch(m, { type: "ouvrirOnglet", fenetreId: fenetreId ?? f, url }));
const loaded = (path: string) =>
  waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec.endsWith(${JSON.stringify(path)}) && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true);

describe("history noted in the noyau", () => {
  it("two visited pages are in the history, once each", async () => {
    await open(`${base}/a.html`);
    await loaded("/a.html");
    await open(`${base}/b.html`);
    await loaded("/b.html");
    const v = await until(recents, (r) => r.length === 2 && r.every((x) => x.titre.startsWith("Page")));
    expect(v.map((x) => [x.url, x.titre, x.visites]).sort()).toEqual([
      [`${base}/a.html`, "Page A", 1],
      [`${base}/b.html`, "Page B", 1],
    ]);
  });

  it("a redirect notes only its target; an in-page change notes the new URL", async () => {
    const s = await open(`${base}/redirige?vers=${base}/a.html`);
    await loaded("/a.html");
    await until(urls, (u) => u.length === 1);
    expect(await urls()).toEqual([`${base}/a.html`]);
    const id = Object.keys(s.onglets).at(-1)!;
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
    const e = s.espaces.find((x) => x.id === s.fenetres[0]!.espaceActif)!;
    await dispatch(m, { type: "reglerEspace", id: e.id, nom: e.nom, icone: e.icone, prive: true, profil: e.profil } as Action);
    await open(`${base}/b.html`);
    await loaded("/b.html");
    const v = await until(recents, (r) => r.length === 2 && r.every((x) => x.prive));
    expect(v.map((x) => x.prive)).toEqual([true, true]);
  });

  it("a visit is noted with its window's space", async () => {
    const other = await newWindow(m);
    const id = await inWindow(m, other, () => m.execute<string>("return window.webaiosWindow.fenetreId"));
    const s = await dispatch(m, { type: "creerEspace", nom: "B", icone: "🅱", prive: false, profil: "defaut", fenetreId: id });
    const b = s.espaces.at(-1)!.id;
    await open(`${base}/a.html`, id);
    const v = await until(recents, (r) => r.length === 1);
    expect(v[0]!.espaceId).toBe(b);
  });

  it("an invisible read writes nothing in the history", async () => {
    const r = await m.execute<{ ok?: unknown }>(
      `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).readPage(arguments[0], { profil: null }).then((ok) => ({ ok })))();`,
      [`${base}/b.html`],
    );
    expect(r.ok).toBeTruthy();
    expect(await urls()).toEqual([]);
  });

  it("an unreachable page is not noted", async () => {
    await open("http://127.0.0.1:1/injoignable.html");
    await until(async () => (await state(m)).onglets, (o) => Object.values(o).some((t) => t.erreur), 15_000);
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
    const config = join(w.dataDir, "espace", ".webaios", "mcp.json");
    await until(async () => existsSync(config), Boolean, 20_000);
    await open(`${base}/a.html`);
    await loaded("/a.html");
    await until(recents, (r) => r.some((x) => x.titre === "Page A"));
    expect((await callTool(w.dataDir, "chercher_historique", { requete: "Page A" })).texte).toContain(`${base}/a.html`);
  });

  it("a space turned private while the host is down marks its visits once the host is back", async () => {
    await open(`${base}/a.html`);
    await loaded("/a.html");
    await until(recents, (r) => r.some((x) => x.titre === "Page A"));
    const host = (body: string) => m.execute<unknown>(`return (async () => { const h = (await ChromeUtils.importESModule("${STORE}").ready).agent; ${body} })();`);
    await host("await h.stop();");
    await until(() => host("return h.pid;"), (pid) => pid === null);
    const s = await state(m);
    const e = s.espaces.find((x) => x.id === s.fenetres[0]!.espaceActif)!;
    await dispatch(m, { type: "reglerEspace", id: e.id, nom: e.nom, icone: e.icone, prive: true, profil: e.profil } as Action);
    await host("await h.ensure();");
    expect((await until(recents, (r) => r.length === 1))[0]!.prive).toBe(true);
    expect((await callTool(w.dataDir, "chercher_historique", { requete: "Page A" })).texte).not.toContain("a.html");
  });
});
