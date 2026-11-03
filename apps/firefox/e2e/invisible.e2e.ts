import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { waitUi } from "./ui";

const STORE = "chrome://browser/content/webaios/store.sys.mjs";

// The page server is on 127.0.0.1, declared public for these tests only; the trap is on ::1, reached through the
// public name localtest.me (overridden to ::1 in Firefox's resolver). Nothing may ever reach the trap.
let page: Awaited<ReturnType<typeof startServer>>;
let trap: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let trapBase: string;
beforeAll(async () => {
  page = await startServer();
  trap = await startServer({ host: "::1" });
  trapBase = `http://localtest.me:${trap.port}`;
  w = await launchWebAiOs({ env: { WEBAIOS_TEST_ADRESSES_PUBLIQUES: "127.0.0.1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow", (v) => v === true);
  // The home page's agent session settles first: quitting during its start-up leaves writers in the data dir.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
  await m.execute(`Cc["@mozilla.org/network/native-dns-override;1"].getService(Ci.nsINativeDNSResolverOverride).addIPOverride("localtest.me", "::1");`);
});
afterAll(async () => {
  await w?.close();
  await Promise.all([page?.close(), trap?.close()]);
});
beforeEach(() => {
  trap.paths.length = 0;
  page.paths.length = 0;
});

type Outcome<T> = { ok: T } | { err: string; name: string };
interface Page {
  url: string;
  titre: string;
  texte: string;
  liens: { texte: string; url: string }[];
}
const readPage = (url: string, o: object = { profil: null }) =>
  m.execute<Outcome<Page>>(
    `return (async () => {
      const s = await ChromeUtils.importESModule("${STORE}").ready;
      try { return { ok: await s.readPage(arguments[0], arguments[1]) }; } catch (e) { return { err: String(e?.message ?? e), name: String(e?.name) }; }
    })();`,
    [url, o],
  );
const windows = () => m.execute<number>("return [...Services.wm.getEnumerator(null)].length");
async function newSpace(prive: boolean): Promise<string> {
  const before = (await state(m)).espaces.map((e) => e.id);
  const s = await dispatch(m, { type: "creerEspace", nom: prive ? "Privé" : "Compte", icone: "🔒", prive, profil: "nouveau" } as Action);
  return s.espaces.find((e) => !before.includes(e.id))!.profil;
}

it("refuses a page on a public name resolving to ::1, nothing reaches the trap", async () => {
  const r = await readPage(`${trapBase}/a.html`);
  expect(r).toHaveProperty("err");
  expect(trap.paths).toEqual([]);
});

it("reads a public page but its frame, image and fetch to localtest.me never reach the trap", async () => {
  const r = await readPage(`${page.url}/sous-ressources?vers=${encodeURIComponent(trapBase)}`);
  expect(r).toHaveProperty("ok");
  expect(trap.paths).toEqual([]);
  expect((r as { ok: Page }).ok.texte).toContain("Texte public");
});

it("with adressesLocales (tests only) nothing is guarded: the same frame, image and fetch reach the trap", async () => {
  expect(await readPage(`${page.url}/sous-ressources?vers=${encodeURIComponent(trapBase)}`, { profil: null, adressesLocales: true })).toHaveProperty("ok");
  expect([...trap.paths].sort()).toEqual(["/cadre", "/fetch", "/image"]);
});

it("a redirect to localtest.me is refused", async () => {
  const r = await readPage(`${page.url}/redirige?vers=${encodeURIComponent(`${trapBase}/cible`)}`);
  expect(r).toHaveProperty("err");
  expect(page.paths).toContain("/redirige");
  expect(trap.paths).toEqual([]);
});

it("print() and alert() open no window and the title comes back under 15 s", async () => {
  const before = await windows();
  const start = Date.now();
  const r = await readPage(`${page.url}/dialogues`);
  expect(Date.now() - start).toBeLessThan(15_000);
  expect(await windows()).toBe(before);
  expect(r).toMatchObject({ ok: { titre: "dialogues" } });
});

it("a public read sees no profile cookie", async () => {
  const profil = await newSpace(false);
  expect(await readPage(`${page.url}/cookie`, { profil })).toHaveProperty("ok");
  expect(await readPage(`${page.url}/lire-cookie`, { profil })).toMatchObject({ ok: { titre: "essai=1" } });
  expect(await readPage(`${page.url}/lire-cookie`, { profil: null })).toMatchObject({ ok: { titre: "aucun" } });
});

it("a read with a profile used by a private space → ProfilRefuse", async () => {
  const profil = await newSpace(true);
  expect(await readPage(`${page.url}/a.html`, { profil })).toMatchObject({ name: "ProfilRefuse" });
  expect(page.paths).toEqual([]);
});

it("aborting the signal ends the read and closes the windowless browser", async () => {
  await m.execute(
    `const c = new AbortController();
     window.__reading = { c, p: ChromeUtils.importESModule("${STORE}").ready.then((s) => s.readPage(arguments[0], { profil: null }, c.signal)).then(() => "lue", (e) => e.name) };`,
    [`${page.url}/lent`],
  );
  for (const deadline = Date.now() + 10_000; !page.paths.includes("/lent"); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the slow page was never asked");
  const start = Date.now();
  expect(await m.execute("window.__reading.c.abort(); return window.__reading.p;")).toBe("AbortError");
  expect(Date.now() - start).toBeLessThan(2_000);
  // Closing the browser stops its load: the connection to the slow page goes.
  for (const deadline = Date.now() + 5_000; !page.paths.includes("/lent:fermée"); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the slow page's connection stayed open");
});

it("a redirect outside the allowed domains stops the read", async () => {
  await m.execute(`Cc["@mozilla.org/network/native-dns-override;1"].getService(Ci.nsINativeDNSResolverOverride).addIPOverride("public.test", "127.0.0.1");`);
  const r = await readPage(`${page.url}/redirige?vers=${encodeURIComponent(`http://public.test:${page.port}/a.html`)}`, { profil: null, domaines: ["127.0.0.1"] });
  expect(r).toMatchObject({ err: "Navigation bloquée : public.test est hors des domaines permis" });
  expect(page.paths).toEqual(["/redirige"]);
});
