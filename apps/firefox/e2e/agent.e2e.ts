import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { waitUi } from "./ui";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const TEXTE_PRIVE = "Cet onglet est dans un espace privé : l'agent n'y a pas accès.";

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
  // The noyau is up once its MCP config is written.
  const config = join(w.dataDir, "espace", ".webaios", "mcp.json");
  for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the noyau did not write its MCP config");
  // The home page's panel starts the agent's session, which takes back every access: tools are called after it.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
});
afterEach(() => w?.close());

const call = (name: string, args: Record<string, unknown> = {}) => callTool(w.dataDir, name, args);
const loaded = (path: string) =>
  waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec.endsWith(${JSON.stringify(path)}) && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true);
async function poll<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function setActiveSpacePrivate(prive: boolean): Promise<void> {
  const s = await state(m);
  const e = s.espaces.find((x) => x.id === s.fenetres[0]!.espaceActif)!;
  await dispatch(m, { type: "reglerEspace", id: e.id, nom: e.nom, icone: e.icone, prive, profil: e.profil } as Action);
}

it("at startup the noyau prepares its space in the data dir and MCP answers", async () => {
  expect(existsSync(join(w.dataDir, "espace", "AGENTS.md"))).toBe(true);
  expect(await call("lister_onglets")).toEqual({ texte: "Aucun onglet ouvert.", erreur: false });
});

it("lister_onglets shows a tab not shared yet as « onglet non partagé »", async () => {
  await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url: `${server.url}/a.html` });
  await loaded("/a.html");
  const { texte } = await call("lister_onglets");
  expect(texte).toContain("onglet non partagé");
  expect(texte).not.toContain("a.html");
});

it("ouvrir_onglet opens an active agent tab, readable and capturable", async () => {
  const { texte: id, erreur } = await call("ouvrir_onglet", { url: `${server.url}/texte.html` });
  expect(erreur).toBe(false);
  const s = await state(m);
  expect(s.onglets[id]?.ouvertParAgent).toBe(true);
  expect(s.fenetres[0]!.actif[s.fenetres[0]!.espaceActif]).toBe(id);
  const lu = await call("lire_onglet", { id });
  expect(lu.texte).toContain(`URL : ${server.url}/texte.html`);
  expect(lu.texte).toContain("Le chat dort");
  const capture = await call("capture_ecran", { id });
  expect(capture.image?.startsWith("iVBOR")).toBe(true);
  expect(capture.image!.length).toBeGreaterThan(1000);
});

it("an agent tab sent to the background stays readable and capturable", async () => {
  const { texte: first } = await call("ouvrir_onglet", { url: `${server.url}/texte.html` });
  const { texte: second } = await call("ouvrir_onglet", { url: `${server.url}/b.html` });
  const s = await state(m);
  expect(s.fenetres[0]!.actif[s.fenetres[0]!.espaceActif]).toBe(second);
  expect((await call("lire_onglet", { id: first })).texte).toContain("Le chat dort");
  expect((await call("capture_ecran", { id: first })).image!.length).toBeGreaterThan(1000);
});

it("naviguer loads the agent tab and leaves the keyboard where it was", async () => {
  const { texte: id } = await call("ouvrir_onglet", { url: `${server.url}/a.html` });
  await loaded("/a.html");
  await m.execute("document.getElementById('webaios-sidebar').focus()");
  expect((await call("naviguer", { id, url: `${server.url}/b.html` })).erreur).toBe(false);
  await loaded("/b.html");
  expect(await m.execute("return document.activeElement?.id")).toBe("webaios-sidebar");
});

it("private space: the tab disappears from lister_onglets, lire_onglet / capture_ecran / page_courante answer TEXTE_PRIVE, ouvrir_onglet is refused", async () => {
  const { texte: id } = await call("ouvrir_onglet", { url: `${server.url}/texte.html` });
  expect((await call("lire_onglet", { id })).texte).toContain("Le chat dort");
  await setActiveSpacePrivate(true);
  await poll(async () => (await call("lister_onglets")).texte, (t) => t === "Aucun onglet ouvert.");
  for (const name of ["lire_onglet", "capture_ecran"]) expect(await call(name, { id })).toEqual({ texte: TEXTE_PRIVE, erreur: false });
  expect(await call("page_courante")).toEqual({ texte: TEXTE_PRIVE, erreur: false });
  const opened = await call("ouvrir_onglet", { url: `${server.url}/b.html` });
  expect(opened.texte).toContain("Impossible d'ouvrir un onglet ici : l'espace actif est privé.");
  expect(Object.keys((await state(m)).onglets)).toEqual([id]);
  // Shared again: the tab is back in the list, but access has to be asked for again.
  await setActiveSpacePrivate(false);
  await poll(async () => (await call("lister_onglets")).texte, (t) => t.includes(`${id} · onglet non partagé`));
});

it("quitting stops the host", async () => {
  const pid = await m.execute<number>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`);
  expect(pid).toBeGreaterThan(0);
  process.kill(pid, 0); // alive
  await w.close();
  await poll(
    async () => {
      try {
        process.kill(pid, 0);
        return "alive";
      } catch (e) {
        return (e as NodeJS.ErrnoException).code;
      }
    },
    (c) => c === "ESRCH",
    5_000,
  );
});
