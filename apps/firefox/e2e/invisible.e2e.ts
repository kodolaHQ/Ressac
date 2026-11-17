import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import { cleanupXpis, installAddon, marker, uninstallAddon, watcher } from "./addons";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { agentPanelReady } from "./ui";

const STORE = "chrome://browser/content/ressac/store.sys.mjs";

// The page server is on 127.0.0.1, declared public for these tests only; the trap is on ::1, reached through the
// public name localtest.me (overridden to ::1 in Firefox's resolver). Nothing may ever reach the trap.
let page: Awaited<ReturnType<typeof startServer>>;
let trap: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
let trapBase: string;
beforeAll(async () => {
  page = await startServer();
  trap = await startServer({ host: "::1" });
  trapBase = `http://localtest.me:${trap.port}`;
  // Honoured by Firefox only under automation (Marionette running).
  w = await launchRessac({ env: { RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow", (v) => v === true);
  // The home page's agent session settles first: quitting during its start-up leaves writers in the data dir.
  await agentPanelReady(m);
  await m.execute(`Cc["@mozilla.org/network/native-dns-override;1"].getService(Ci.nsINativeDNSResolverOverride).addIPOverride("localtest.me", "::1");`);
  // Should a download slip through, it lands in the test's data dir, never in ~/Downloads.
  await m.execute(
    `Services.prefs.setIntPref("browser.download.folderList", 2); Services.prefs.setStringPref("browser.download.dir", arguments[0]);`,
    [w.dataDir],
  );
});
afterAll(async () => {
  await w?.close();
  await cleanupXpis();
  await Promise.all([page?.close(), trap?.close()]);
});
beforeEach(() => {
  trap.paths.length = 0;
  page.paths.length = 0;
});

type Outcome<T> = { ok: T } | { err: string; name: string };
interface Page {
  url: string;
  title: string;
  text: string;
  links: { text: string; url: string }[];
}
const readPage = (url: string, o: object = { profile: null }) =>
  m.execute<Outcome<Page>>(
    `return (async () => {
      const s = await ChromeUtils.importESModule("${STORE}").ready;
      try { return { ok: await s.readPage(arguments[0], arguments[1]) }; } catch (e) { return { err: String(e?.message ?? e), name: String(e?.name) }; }
    })();`,
    [url, o],
  );
const downloads = () =>
  m.execute<string[]>(
    `return (async () => { const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs"); return (await (await Downloads.getList(Downloads.ALL)).getAll()).map((d) => d.source.url); })();`,
  );
const windows = () => m.execute<number>("return [...Services.wm.getEnumerator(null)].length");
async function newSpace(isPrivate: boolean): Promise<string> {
  const before = (await state(m)).spaces.map((e) => e.id);
  const s = await dispatch(m, { type: "createSpace", name: isPrivate ? "Privé" : "Compte", icon: "🔒", private: isPrivate, profile: "new" } as Action);
  return s.spaces.find((e) => !before.includes(e.id))!.profile;
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
  expect((r as { ok: Page }).ok.text).toContain("Texte public");
});

it("with localAddresses (tests only) nothing is guarded: the same frame, image and fetch reach the trap", async () => {
  expect(await readPage(`${page.url}/sous-ressources?vers=${encodeURIComponent(trapBase)}`, { profile: null, localAddresses: true })).toHaveProperty("ok");
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
  expect(r).toMatchObject({ ok: { title: "dialogues" } });
});

it("a public read sees no profile cookie", async () => {
  const profile = await newSpace(false);
  expect(await readPage(`${page.url}/cookie`, { profile: profile })).toHaveProperty("ok");
  expect(await readPage(`${page.url}/lire-cookie`, { profile: profile })).toMatchObject({ ok: { title: "essai=1" } });
  expect(await readPage(`${page.url}/lire-cookie`, { profile: null })).toMatchObject({ ok: { title: "aucun" } });
});

it("a read with a profile used by a private space → ProfileDenied", async () => {
  const profile = await newSpace(true);
  expect(await readPage(`${page.url}/a.html`, { profile: profile })).toMatchObject({ name: "ProfileDenied" });
  expect(page.paths).toEqual([]);
});

it("aborting the signal ends the read and closes the windowless browser", async () => {
  await m.execute(
    `const c = new AbortController();
     window.__reading = { c, p: ChromeUtils.importESModule("${STORE}").ready.then((s) => s.readPage(arguments[0], { profile: null }, c.signal)).then(() => "lue", (e) => e.name) };`,
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
  const r = await readPage(`${page.url}/redirige?vers=${encodeURIComponent(`http://public.test:${page.port}/a.html`)}`, { profile: null, domains: ["127.0.0.1"] });
  expect(r).toMatchObject({ err: "Navigation bloquée : la page mène hors des domaines permis" });
  expect(page.paths).toEqual(["/redirige"]);
});

it("a beacon sent on pagehide never reaches the trap", async () => {
  const profile = await newSpace(false);
  for (const o of [{ profile: null }, { profile: profile }]) expect(await readPage(`${page.url}/balise?vers=${encodeURIComponent(trapBase)}`, o)).toHaveProperty("ok");
  await new Promise((r) => setTimeout(r, 2_000));
  expect(trap.paths).toEqual([]);
});

it("a service worker fetch after the read never reaches the trap", async () => {
  expect(await readPage(`${page.url}/travailleur?vers=${encodeURIComponent(trapBase)}`)).toHaveProperty("ok");
  expect(page.paths).toContain("/sw.js");
  await new Promise((r) => setTimeout(r, 6_000));
  expect(trap.paths).toEqual([]);
});

it("reads a page sent with Cross-Origin-Opener-Policy (Google, YouTube)", async () => {
  expect(await readPage(`${page.url}/coop`)).toMatchObject({ ok: { title: "coop", text: "Page isolée" } });
});

it("window.open from a read opens no window", async () => {
  const before = await windows();
  expect(await readPage(`${page.url}/fenetres`)).toMatchObject({ ok: { title: "fenetres" } });
  expect(await windows()).toBe(before);
  expect(page.paths).not.toContain("/a.html");
});

it("a read never downloads: not the page, nor a frame, nor a download link", async () => {
  expect(await readPage(`${page.url}/telecharge-cadre`)).toMatchObject({ ok: { title: "telecharge" } });
  expect(await readPage(`${page.url}/telecharge`)).toHaveProperty("err");
  await new Promise((r) => setTimeout(r, 1_000));
  expect(await downloads()).toEqual([]);
});

describe("add-ons", () => {
  const seen = () => page.paths.filter((p) => p === "/note/seen").length;
  const pause = () => new Promise((r) => setTimeout(r, 1_000));
  let id: string;
  beforeAll(async () => {
    id = await installAddon(m, watcher(page.url));
  });
  afterAll(() => uninstallAddon(m, id));

  it("a public read is invisible to add-ons: no webRequest, no content script", async () => {
    const mark = await installAddon(m, marker());
    try {
      // Positive control: a normal tab on the same page does get the mark, so its absence below means something.
      await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${page.url}/texte.html` });
      await waitFor(
        m,
        `return (async () => {
          try { return (await gBrowser.selectedBrowser.browsingContext.currentWindowGlobal.getActor("RessacPage").sendQuery("html", { max: 100000 })).includes("addon-mark"); } catch { return false; }
        })();`,
        (v) => v === true,
      );
      await pause();
      const before = seen(); // the control tab's own request was seen
      const r = await readPage(`${page.url}/texte.html`);
      expect(r).toHaveProperty("ok");
      expect((r as { ok: Page }).ok.text).not.toContain("MARQUE-MODULE");
      await pause();
      expect(seen()).toBe(before);
    } finally {
      await uninstallAddon(m, mark);
    }
  });

  it("a login-profile read keeps add-ons (webRequest sees it)", async () => {
    const profile = await newSpace(false);
    expect(await readPage(`${page.url}/texte.html`, { profile: profile })).toHaveProperty("ok");
    await pause();
    expect(seen()).toBeGreaterThan(0);
  });

  it("a public read leaves no cookie behind", async () => {
    expect(await readPage(`${page.url}/cookie`)).toHaveProperty("ok");
    expect(await readPage(`${page.url}/lire-cookie`)).toMatchObject({ ok: { title: "aucun" } });
  });
});
