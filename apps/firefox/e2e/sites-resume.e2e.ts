import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { testActor } from "./agent-extensions";
import { waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { grantSite, inBrowser, inSiteBar, inSiteView, resolveLocalHosts, serveWav, silenceWav, siteWindowExpr, startSitesServer, writeSite } from "./sites";
import { missingApi } from "./ui";

// Plan 32 Task 3: the video resume in the frames of a site app's view, plus an about:srcdoc
// player, untrusted events, the sign-in window and a host restart.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const HOSTS = ["vidola-a.localhost", "pub.localhost", "lecteur.localhost", "compte.localhost"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs | undefined;
let m: Marionette;
let dataDir: string;
let profile: string;

const url = (p: string, host = "vidola-a.localhost") => server.url(host, p);
const declaration = (start = "/episode/4", extra: object = {}) => ({ nom: "Vidola", adresse: url(start), domaines: ["vidola-a.localhost"], connexion: ["compte.localhost"], reprise: true, ...extra });

const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
const memoryFile = (id = "vidola") => path.join(dataDir, "sites", id, "memoire.json");
/** memoire.json's positions (written 500 ms after a change), or null. */
const positions = (id = "vidola"): Record<string, { t: number; duree: number }> | null => (existsSync(memoryFile(id)) ? JSON.parse(readFileSync(memoryFile(id), "utf8")).positions : null);
const viewUrl = (id: string) => m.execute<string | null>(`return ${siteWindowExpr(id)}?.gBrowser?.selectedBrowser.currentURI?.spec ?? null;`);
const view = <T = unknown>(code: string, o: { frame?: number } = {}) => inSiteView<T>(m, "vidola", `return ${code};`, { frame: o.frame }).catch(() => null);
/** In the `frame`-th frame of the view: `code`, with `v` the video. */
const player = (code: string, frame = 0) => view(`(() => { const v = document.getElementById("v"); return ${code}; })()`, { frame });
/**
 * Waits for the video of that frame to know its duration (loadedmetadata, the event that settles its resume). The headless
 * test browser decodes nothing (no media pipeline: readyState stays 1, a seek never completes, play() stays pending), so
 * no test relies on playback: the position is `currentTime` as set, and the browser's own `play` and `pause` events (which
 * it dispatches, trusted, whatever the decoder does) carry it.
 */
const waitDuration = (duration: number, frame = 0) => expect.poll(() => player("v ? v.duration : 0", frame), { timeout: 15_000 }).toBe(duration);
/** The player is put at `t` and paused (play then pause: the browser dispatches a trusted `pause` at `t`). */
const seekThenPause = (t: number, frame = 0) => player(`(v.currentTime = ${t}, v.play().catch(() => {}), v.pause(), v.currentTime)`, frame);
const openSite = (id: string) => inStore(`await store.agent.request("sites.agir", { id: arguments[0], action: "ouvrir", fenetre: store.state.fenetres[0].id });`, [id]);
async function openAndWait(path: string, id = "vidola") {
  await openSite(id);
  await expect.poll(() => viewUrl(id), { timeout: 20_000 }).toBe(url(path));
  await expect.poll(() => view("document.readyState"), { timeout: 15_000 }).not.toBe("loading");
}

/** A fresh app and browser (each test: the memory is the host's, read once). `accord: false` leaves the card up. */
async function start(o: { accord?: boolean; decl?: object; positions?: Record<string, { t: number; duree: number }> } = {}) {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  const decl = o.decl ?? declaration();
  writeSite(dataDir, "vidola", { declaration: decl });
  if (o.accord !== false) await grantSite(dataDir, "vidola", decl);
  if (o.positions) {
    const quand = new Date().toISOString();
    mkdirSync(path.dirname(memoryFile()), { recursive: true });
    writeFileSync(memoryFile(), JSON.stringify({ version: 1, valeurs: {}, positions: Object.fromEntries(Object.entries(o.positions).map(([k, v]) => [k, { ...v, quand }])) }));
  }
  const actor = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_ADRESSES_LOCALES: "1", ...actor.env }, prefs: actor.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, HOSTS);
}

beforeAll(async () => {
  server = await startSitesServer();
  const lecteurPage = '<title>Lecteur</title><video id="v" muted autoplay preload="auto" src="/silence-90.wav"></video>';
  server.definir("lecteur.localhost", "/lecteur.html", lecteurPage);
  server.definir("lecteur.localhost", "/silence-90.wav", serveWav(silenceWav(90)));
  server.definir("vidola-a.localhost", "/episode/4", `<title>Épisode 4</title><iframe id="lecteur" src="${url("/lecteur.html", "lecteur.localhost")}"></iframe>`);
  // An advert of 75 s (another domain, another duration) before the player of the episode.
  server.definir(
    "vidola-a.localhost",
    "/episode/7",
    `<title>Épisode 7</title><iframe id="pub" src="${url("/pub-video", "pub.localhost")}"></iframe><iframe id="lecteur" src="${url("/lecteur.html", "lecteur.localhost")}"></iframe>`,
  );
  server.definir("pub.localhost", "/pub-video", '<title>Pub</title><video id="v" muted autoplay preload="auto" src="/pub-75.wav"></video>');
  server.definir("pub.localhost", "/pub-75.wav", serveWav(silenceWav(75)));
  // The player is an about:srcdoc frame (a player that writes its own frame).
  server.definir(
    "vidola-a.localhost",
    "/srcdoc",
    `<title>Srcdoc</title><iframe id="lecteur" srcdoc='<video id="v" muted autoplay preload="auto" src="${url("/silence-90.wav", "lecteur.localhost")}"></video>'></iframe>`,
  );
  // A video the page starts itself: no autoplay, so the test decides which events happen.
  server.definir("vidola-a.localhost", "/manuel", `<title>Manuel</title><video id="v" muted preload="auto" src="${url("/silence-90.wav", "lecteur.localhost")}"></video>`);
  server.definir("compte.localhost", "/connexion", "<title>Connexion</title>");
}, 30_000);
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close().catch(() => {});
    w = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (profile) await rm(profile, { recursive: true, force: true });
  }
});
afterAll(() => server?.fermer());

describe("video resume", () => {
  it('the test seeks the video to 70 s then pauses: positions["/episode/4"].t is about 70, nothing under the player\'s address; reloading: the video starts and currentTime is about 65 (sites.spec.ts:1256)', async () => {
    await start();
    await openAndWait("/episode/4");
    await waitDuration(90);
    // The first event settled the resume (no position kept: nothing); a pause is noted.
    await sleep(500);
    expect(await seekThenPause(70)).toBeCloseTo(70, 0);
    await expect.poll(() => positions()?.["/episode/4"]?.t ?? null, { timeout: 10_000 }).toBeCloseTo(70, 0);
    const p = positions()!;
    expect(Object.keys(p)).toEqual(["/episode/4"]);
    expect(p["/episode/4"]!.duree).toBeCloseTo(90, 0);
    // The page reloaded: the player, loaded again in its frame, resumes 5 s before. (The player is asked only once the
    // page has loaded, frames included: a frame that goes away during a call never answers.)
    await view("(window.marque = 1, location.reload(), 1)");
    await expect.poll(() => view("window.marque === undefined && document.readyState !== 'loading'"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => player("v && v.currentTime >= 64.9"), { timeout: 15_000 }).toBe(true);
    expect(await player("v.currentTime")).toBeLessThan(69);
  });

  it("at 88 s then pause: the position is forgotten (sites.spec.ts:1275)", async () => {
    await start({ positions: { "/episode/4": { t: 70, duree: 90 } } });
    await openAndWait("/episode/4");
    // Resumed at 65 from the kept position.
    await expect.poll(() => player("v && v.currentTime >= 64.9"), { timeout: 15_000 }).toBe(true);
    expect(await seekThenPause(88)).toBeCloseTo(88, 0);
    await expect.poll(() => positions()?.["/episode/4"] ?? null, { timeout: 10_000 }).toBeNull();
    expect(positions()).toEqual({});
  });

  it("without accord (Ouvrir sans retouches): no position noted, nothing resumed (sites.spec.ts:1286)", async () => {
    await start({ accord: false, positions: { "/episode/4": { t: 70, duree: 90 } } });
    await openSite("vidola");
    await expect.poll(() => inStore<string | null>(`return store.sites.viewOf("vidola");`), { timeout: 15_000 }).toBe("accord");
    await inSiteBar(m, "vidola", `doc.querySelector('[data-testid="refuser-site"]').click(); return true;`);
    await expect.poll(() => viewUrl("vidola"), { timeout: 20_000 }).toBe(url("/episode/4"));
    await waitDuration(90);
    await sleep(1000);
    // Not resumed: the video stayed at 0.
    expect(await player("v.currentTime")).toBeLessThan(10);
    expect(await seekThenPause(40)).toBeCloseTo(40, 0);
    await sleep(1200);
    expect(positions()).toEqual({ "/episode/4": { t: 70, duree: 90, quand: expect.any(String) } });
  });

  it("an advert of 75 s in another frame: it does not take the position, neither replaces nor erases it by reaching its end; the 90 s player resumes (sites.spec.ts:1301)", async () => {
    await start({ decl: declaration("/episode/7"), positions: { "/episode/7": { t: 70, duree: 90 } } });
    await openAndWait("/episode/7");
    await expect.poll(() => player("v ? v.duration : 0", 0), { timeout: 15_000 }).toBe(75);
    // The player resumes at 65; the advert stays at 0.
    await expect.poll(() => player("v && v.currentTime >= 64.9", 1), { timeout: 15_000 }).toBe(true);
    await sleep(500);
    expect(await player("v.currentTime", 0)).toBeLessThan(10);
    // The episode paused a little later: noted.
    expect(await seekThenPause(67, 1)).toBeCloseTo(67, 0);
    await expect.poll(() => positions()?.["/episode/7"]?.t ?? null, { timeout: 10_000 }).toBeCloseTo(67, 0);
    // The advert paused in the middle, then near its end: neither replaces nor erases the position (another duration).
    expect(await seekThenPause(30, 0)).toBeCloseTo(30, 0);
    expect(await seekThenPause(74.9, 0)).toBeCloseTo(74.9, 0);
    await sleep(2000);
    expect(positions()).toEqual({ "/episode/7": { t: expect.closeTo(67, 0), duree: expect.closeTo(90, 0), quand: expect.any(String) } });
    // The episode is still noted afterwards.
    expect(await seekThenPause(75, 1)).toBeCloseTo(75, 0);
    await expect.poll(() => positions()?.["/episode/7"]?.t ?? null, { timeout: 10_000 }).toBeCloseTo(75, 0);
  });

  it("a video in an about:srcdoc player frame resumes when the app declares no cadres", async () => {
    await start({ decl: declaration("/srcdoc"), positions: { "/srcdoc": { t: 70, duree: 90 } } });
    await openAndWait("/srcdoc");
    await expect.poll(() => player("location.href", 0), { timeout: 15_000 }).toBe("about:srcdoc");
    await waitDuration(90, 0);
    await expect.poll(() => player("v && v.currentTime >= 64.9", 0), { timeout: 15_000 }).toBe(true);
    await sleep(500);
    expect(await seekThenPause(75, 0)).toBeCloseTo(75, 0);
    await expect.poll(() => positions()?.["/srcdoc"]?.t ?? null, { timeout: 10_000 }).toBeCloseTo(75, 0);
  });

  it("events dispatched by the page (isTrusted false) note nothing", async () => {
    await start({ decl: declaration("/manuel") });
    await openAndWait("/manuel");
    const v = 'document.getElementById("v")';
    await expect.poll(() => view(`${v}.duration`), { timeout: 15_000 }).toBe(90);
    await sleep(500);
    // The page fakes the events that would note a position (pause and ended bypass the 10 s step).
    await view(`(${v}.currentTime = 40, ["play", "timeupdate", "pause", "ended"].forEach((t) => ${v}.dispatchEvent(new Event(t, { bubbles: true }))), 1)`);
    await sleep(1800);
    expect(positions()?.["/manuel"] ?? null).toBeNull();
    // A real pause notes it: the faked ones were not holding it back.
    await view(`(${v}.play().catch(() => {}), ${v}.pause(), 1)`);
    await expect.poll(() => positions()?.["/manuel"]?.t ?? null, { timeout: 10_000 }).toBeCloseTo(40, 0);
  });

  it("the sign-in window of the same container notes and resumes nothing", async () => {
    server.definir("vidola-a.localhost", "/vide", "<title>Vide</title>");
    await start({ decl: declaration("/vide"), positions: { "/episode/4": { t: 70, duree: 90 } } });
    await openAndWait("/vide");
    await inStore(`store.sites.routeOpen("vidola", arguments[0]);`, [url("/connexion", "compte.localhost")]);
    const small = `[...Services.wm.getEnumerator("navigator:browser")].find((x) => x.document.documentElement.getAttribute("webaios-site-small") === "vidola")?.gBrowser.selectedBrowser`;
    await expect.poll(() => m.execute(`return ${small}?.currentURI?.spec ?? null;`), { timeout: 10_000 }).toBe(url("/connexion", "compte.localhost"));
    // A page of the app, with its player, in the small window (the same container).
    await inBrowser(m, small, `location.href = ${JSON.stringify(url("/episode/4"))}; return 1;`);
    const inPlayer = (code: string) => inBrowser(m, small, `return ${code};`, { frame: 0 }).catch(() => null);
    await expect.poll(() => inPlayer('document.getElementById("v")?.duration ?? 0'), { timeout: 15_000 }).toBe(90);
    await sleep(1500);
    // Not resumed (it stayed at 0; the view's own player would be at 65).
    expect(await inPlayer('document.getElementById("v").currentTime')).toBeLessThan(40);
    // A pause at 50 notes nothing over the kept 70.
    await inPlayer('(document.getElementById("v").currentTime = 50, document.getElementById("v").play().catch(() => {}), document.getElementById("v").pause(), 1)');
    await sleep(1800);
    expect(positions()).toEqual({ "/episode/4": { t: 70, duree: 90, quand: expect.any(String) } });
  });

  it("after a host restart memory and resume still work in the open app (Review Focus 5)", async () => {
    await start({ decl: declaration("/episode/4", { retouches: [{ correspond: ["/episode/*"], js: ["m.js"] }] }), positions: { "/episode/4": { t: 70, duree: 90 } } });
    writeSite(dataDir, "vidola", {
      declaration: declaration("/episode/4", { retouches: [{ correspond: ["/episode/*"], js: ["m.js"] }] }),
      fichiers: {
        "retouches/m.js": 'document.addEventListener("essai", () => webaiosSite.retenir("k", 1).then(() => (document.documentElement.dataset.r = "ok"), (e) => (document.documentElement.dataset.r = "refus:" + e.message)));',
      },
    });
    await openAndWait("/episode/4");
    await expect.poll(() => player("v && v.currentTime >= 64.9"), { timeout: 15_000 }).toBe(true);
    // « Réessayer »: the host stops, then starts again on the same data. No pause for it to catch up: a window where
    // it refused would show here.
    await inStore(`await store.agent.stop(); await store.agent.ensure();`);
    const retenir = async () => {
      await view('(document.documentElement.dataset.r = "", document.dispatchEvent(new Event("essai")), 1)');
      await expect.poll(() => view("document.documentElement.dataset.r"), { timeout: 10_000 }).not.toBe("");
      return view("document.documentElement.dataset.r");
    };
    expect(await retenir()).toBe("ok");
    await expect.poll(() => JSON.parse(readFileSync(memoryFile(), "utf8")).valeurs.k?.valeur ?? null, { timeout: 10_000 }).toBe(1);
    // Resume: a player created now (the page reloaded) is told the kept position by the new host.
    await view("(window.marque = 1, location.reload(), 1)");
    await expect.poll(() => view("window.marque === undefined && document.readyState !== 'loading'"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => player("v && v.currentTime >= 64.9 && v.currentTime < 69"), { timeout: 15_000 }).toBe(true);
    // And a note after the restart is written.
    expect(await seekThenPause(80)).toBeCloseTo(80, 0);
    await expect.poll(() => positions()?.["/episode/4"]?.t ?? null, { timeout: 10_000 }).toBeCloseTo(80, 0);
    // The tweaks' console is the chrome's: still there.
    expect(await inStore<unknown[]>(`return store.sites.errors("vidola");`)).toEqual([]);
  });
});
