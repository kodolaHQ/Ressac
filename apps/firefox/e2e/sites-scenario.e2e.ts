import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testActor } from "./agent-extensions";
import { state, waitReady, windowHandles } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { grantSite, inSiteBar, inSiteView, resolveLocalHosts, serveWav, silenceWav, siteWindowCount, siteWindowExpr, startSitesServer, writeSite } from "./sites";
import { missingApi } from "./ui";

// Plan 32 Task 7: the success scenario, end to end, with the examples of AGENTS.md written as they are (only the
// domains become `*.localhost`), a local fake YouTube included.
// Adapted: the headless test Firefox decodes no media (see sites-resume.e2e.ts), so « watch until 1:10 » sets the
// player's time then plays and pauses (trusted events), and a resumed player is checked on its time, not on playing.
// « No window ever shown » has no headless probe: the window and tab counts stand in for it.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const CIS = "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs";
const HOSTS = ["vidola-a.localhost", "vidola-b.localhost", "lecteur.localhost", "images.localhost", "pub.localhost", "adresses.localhost", "youtube.localhost", "accounts.localhost"];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const EPISODE = "/serie/the-bear/saison-2/episode-4";
const READER = "/lecteur.html";
const CARD_TEXT = "the-bear · saison 2, épisode 4 — reprendre à 1:10";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AGENTS = readFileSync(path.join(__dirname, "..", "..", "..", "packages", "kernel", "templates", "AGENTS.md"), "utf8");
/** The first code block of AGENTS.md from `marker` on (the marker may be the block's opening itself). */
const block = (marker: string): string => {
  const i = AGENTS.indexOf(marker);
  expect(i, marker).toBeGreaterThan(-1);
  const opening = AGENTS.indexOf("```", i);
  const start = AGENTS.indexOf("\n", opening) + 1;
  return AGENTS.slice(start, AGENTS.indexOf("\n```", start));
};
const cssOf = (file: string): string => {
  const m = new RegExp("`tweaks/" + file.replace(".", "\\.") + "` : `([^`]+)`").exec(AGENTS);
  expect(m, file).not.toBeNull();
  return m![1]!;
};

let server: Awaited<ReturnType<typeof startSitesServer>>;
let w: LaunchedWebAiOs | undefined;
let m: Marionette;
let dataDir: string;
let profile: string;

const url = (host: string, p: string) => server.url(host, p);
const declarationVidola = () => {
  const d = JSON.parse(block("```json site.json:vidola"));
  d.url = url("vidola-a.localhost", "/");
  d.domains = ["vidola-a.localhost", "images.localhost"];
  d.urlTracking.page = url("adresses.localhost", "/");
  d.tweaks[0].frames = [url("lecteur.localhost", "/*").replace(/^http:/, "https:")];
  return d;
};
const declarationYoutube = () => {
  const d = JSON.parse(block("```json site.json:youtube"));
  d.url = url("youtube.localhost", "/");
  d.domains = ["youtube.localhost"];
  d.login = ["accounts.localhost"];
  return d;
};
const siteVidola = () => ({
  declaration: declarationVidola(),
  files: {
    "home/index.html": block("`home/index.html`, minimal"),
    "home/home.js": block("`home/home.js`"),
    "tweaks/en-cours.js": block("`tweaks/en-cours.js`"),
  },
});
const siteYoutube = () => ({
  declaration: declarationYoutube(),
  files: { "tweaks/sans-shorts.css": cssOf("sans-shorts.css"), "tweaks/sans-shorts.js": block("`tweaks/sans-shorts.js`") },
});

const inStore = <T = unknown>(body: string, args: unknown[] = []) =>
  m.execute<T>(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; ${body} })();`, args);
const openSite = (id: string) => inStore(`await store.agent.request("sites.act", { id: arguments[0], action: "open", window: store.state.windows[0].id });`, [id]);
const viewUrl = (id = "vidola") => m.execute<string | null>(`return ${siteWindowExpr(id)}?.gBrowser?.selectedBrowser.currentURI?.spec ?? null;`);
const view = <T = unknown>(code: string, id = "vidola", frame?: number) => inSiteView<T>(m, id, `return ${code};`, { frame }).catch(() => null);
/** Waits for the view's address; a page with a video stays « interactive » headless (its media never loads). */
async function waitUrl(u: string, id = "vidola") {
  await expect.poll(() => viewUrl(id), { timeout: 20_000 }).toBe(u);
  await expect.poll(() => view("document.readyState", id), { timeout: 15_000 }).not.toBe("loading");
}
/** `code` in the player's frame (the episode's first frame), `v` the video. */
const player = (code: string) => view(`(() => { const v = document.getElementById("v"); return ${code}; })()`, "vidola", 0);
/** Waits for the playback, headless: the player knows its 90 s (the event that settles its resume). */
const waitPlayer = () => expect.poll(() => player("v ? v.duration : 0"), { timeout: 15_000 }).toBe(90);
/** The player at `t`, then a trusted play and pause there. */
const seekThenPause = (t: number) => player(`(v.currentTime = ${t}, v.play().catch(() => {}), v.pause(), v.currentTime)`);
const memory = (): { values: Record<string, { value: Record<string, unknown>; url: string }>; positions: Record<string, { t: number }> } | null => {
  const f = path.join(dataDir, "sites", "vidola", "memory.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};
const bar = <T = unknown>(id: string, body: string) => inSiteBar<T>(m, id, `if (!doc.querySelector('[data-testid="barre-site"]') && !doc.querySelector('[data-testid="carte-accord-site"]')) return null; ${body}`);
const text = (id: string, testid: string) => bar<string | null>(id, `return doc.querySelector('[data-testid="${testid}"]')?.textContent ?? null;`);
/** A trusted click (synthesizeMouseEvent from the bar) on a bar button, once there. */
const barClick = (id: string, testid: string) =>
  inSiteBar(
    m,
    id,
    `for (let i = 0; i < 100 && !doc.querySelector('[data-testid="' + arguments[0] + '"]'); i++) await new Promise((r) => setTimeout(r, 100));
     const r = doc.querySelector('[data-testid="' + arguments[0] + '"]').getBoundingClientRect();
     for (const type of ["mousedown", "mouseup"]) doc.defaultView.synthesizeMouseEvent(type, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1 });
     return true;`,
    [testid],
  );
/** In the home's document (`hd`), once the home shows: null before. */
const inHome = <T = unknown>(body: string) =>
  inSiteBar<T>(
    m,
    "vidola",
    `const home = doc.querySelector('[data-testid="site-cadre-accueil"]');
     const hd = home?.contentDocument;
     if (!hd || !String(hd.documentURI).startsWith("resource://webaios-site-")) return null;
     ${body}`,
  );
const homeList = () => inHome<string | null>(`return hd.getElementById("list")?.textContent ?? null;`);
const seriesCards = () => inHome<{ text: string; src: string | null }[] | null>(`return [...hd.querySelectorAll("#list button")].map((b) => ({ text: b.textContent, src: b.querySelector("img")?.getAttribute("src") ?? null }));`);
/** The home's series card, once there: its text and its image's src (once its data came back). */
async function waitSeriesCard(src: RegExp): Promise<void> {
  await expect.poll(async () => (await seriesCards())?.map((c) => c.text) ?? null, { timeout: 15_000 }).toEqual([CARD_TEXT]);
  await expect.poll(async () => (await seriesCards())?.[0]?.src ?? "", { timeout: 15_000 }).toMatch(src);
}
/** A real WebDriver click on the home's series card (sites-home.e2e.ts realClick): the home's « ouvrir » needs a gesture. */
async function clickSeriesCard(): Promise<void> {
  const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  try {
    let found = false;
    for (const h of await windowHandles(m)) {
      await m.command("WebDriver:SwitchToWindow", { handle: h, focus: false });
      if ((found = (await m.execute<string | null>(`return document.documentElement.getAttribute("webaios-site");`)) === "vidola")) break;
    }
    if (!found) throw new Error("no window for vidola");
    const [x, y] = await m.execute<[number, number]>(
      `const bar = document.getElementById("webaios-site-bar");
       const home = bar.contentDocument.querySelector('[data-testid="site-cadre-accueil"]');
       const b = bar.getBoundingClientRect(), h = home.getBoundingClientRect(), e = home.contentDocument.querySelector("#list button").getBoundingClientRect();
       return [Math.round(b.left + h.left + e.left + e.width / 2), Math.round(b.top + h.top + e.top + e.height / 2)];`,
    );
    await m.command("WebDriver:PerformActions", {
      actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
    });
    await m.command("WebDriver:ReleaseActions");
  } finally {
    await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
  }
}
/** The cookies of app `id`'s container, as name=value. */
const cookies = (id: string) =>
  m.execute<string[]>(
    `const { ContextualIdentityService } = ChromeUtils.importESModule("${CIS}");
     const i = ContextualIdentityService.getPrivateIdentity("userContextIdInternal.webaios-site-" + arguments[0]);
     return i ? Services.cookies.cookies.filter((c) => c.originAttributes.userContextId === i.userContextId).map((c) => c.name + "=" + c.value) : [];`,
    [id],
  );
/** Every cookie outside the site apps' containers. */
const cookiesOutsideSites = () =>
  m.execute<string[]>(
    `const { ContextualIdentityService } = ChromeUtils.importESModule("${CIS}");
     const sites = new Set(["vidola", "youtube"].map((id) => ContextualIdentityService.getPrivateIdentity("userContextIdInternal.webaios-site-" + id)?.userContextId).filter((x) => x !== undefined));
     return Services.cookies.cookies.filter((c) => !sites.has(c.originAttributes.userContextId)).map((c) => c.name + "=" + c.value);`,
  );
const tabUrls = async () => Object.values((await state(m)).tabs).map((o) => o.url);
const browserWindows = () => m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].length;`);
/** Closes the app's windows. */
async function closeSiteWindow(id = "vidola") {
  await inStore(`await store.sites.close(arguments[0]);`, [id]);
  await expect.poll(() => siteWindowCount(m, id), { timeout: 10_000 }).toBe(0);
}

/** Launches on `dataDir`/`profile` (kept: a second launch restarts on the same data). */
async function launch() {
  const actor = testActor(profile);
  w = await launchWebAiOs({ dataDir, profile, env: { WEBAIOS_TEST_LOCAL_ADDRESSES: "1", ...actor.env }, prefs: actor.prefs });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await resolveLocalHosts(m, HOSTS);
}
/** Launches WebAiOs with the Vidola app written, `accord` given or not. */
async function startVidola(grant: boolean) {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
  profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
  const s = siteVidola();
  writeSite(dataDir, "vidola", s);
  if (grant) await grantSite(dataDir, "vidola", s.declaration);
  await launch();
}

/** Opened Vidola (grant given), enter the site, sign in, watch the episode until 1:10 then pause. */
async function watch(host = "vidola-a.localhost") {
  await barClick("vidola", "site-entrer");
  await waitUrl(url(host, "/"));
  await view("(location.href = '/connexion', 1)");
  await expect.poll(() => cookies("vidola"), { timeout: 10_000 }).toContain("session=user");
  await view(`(location.href = ${JSON.stringify(EPISODE)}, 1)`);
  await waitUrl(url(host, EPISODE));
  await waitPlayer();
  await sleep(500);
  // 70.5 s: « 1:10 » even if the position is rounded down, and the resume (5 s before) falls at about 65.5 s.
  expect(await seekThenPause(70.5)).toBeGreaterThanOrEqual(70);
  await expect.poll(() => { const t = memory()?.positions[EPISODE]?.t ?? 0; return t >= 70 && t < 71; }, { timeout: 10_000 }).toBe(true);
  await expect.poll(() => memory()?.values["encours.the-bear"]?.url ?? null, { timeout: 10_000 }).toBe(EPISODE);
}
/** The card's click opened the episode, and its player resumed 5 s before 1:10. */
async function expectResumed(host: string) {
  await waitUrl(url(host, EPISODE));
  await expect.poll(() => player("v && v.currentTime >= 64.9"), { timeout: 15_000 }).toBe(true);
  expect(await player("v.currentTime")).toBeLessThan(69);
}

beforeAll(async () => {
  server = await startSitesServer();
  const wav = silenceWav(90);
  for (const h of ["vidola-a.localhost", "vidola-b.localhost"]) {
    server.define(h, "/", `<title>Vidola ${h}</title><p>liste des séries</p>`);
    server.define(h, "/connexion", (_req, res) => res.writeHead(200, { "Set-Cookie": "session=user; Max-Age=86400; Path=/", "Content-Type": "text/html" }).end("<title>Connecté</title>ok"));
    server.define(
      h,
      EPISODE,
      `<!doctype html><title>The Bear S2E4</title><meta property="og:image" content="${url("images.localhost", "/affiches/the-bear.png")}">
<iframe id="lecteur" src="${url("lecteur.localhost", READER)}"></iframe>
<iframe id="pub" src="${url("pub.localhost", "/pub-ouvre")}"></iframe>
<script>let refus = 0; for (let i = 0; i < 3; i++) if (!window.open(${JSON.stringify(url("pub.localhost", "/popup"))})) refus++; fetch("/balise-page?ouvertures=3&refus=" + refus);</script>`,
    );
  }
  server.define("lecteur.localhost", READER, readFileSync(path.join(__dirname, "pages", "lecteur.html"), "utf8"));
  server.define("lecteur.localhost", "/silence-90.wav", serveWav(wav));
  server.define("images.localhost", "/affiches/the-bear.png", (_req, res) => res.writeHead(200, { "Content-Type": "image/png" }).end(PNG));
  server.define(
    "pub.localhost",
    "/pub-ouvre",
    `<title>Pub</title><script>let refus = 0; for (let i = 0; i < 5; i++) if (!window.open(${JSON.stringify(url("pub.localhost", "/popup"))})) refus++; fetch("/balise?ouvertures=5&refus=" + refus);</script>`,
  );
  server.define("youtube.localhost", "/connexion", (_req, res) => res.writeHead(200, { "Set-Cookie": "SID=abc; Max-Age=86400; Path=/", "Content-Type": "text/html" }).end("<title>Connecté</title>ok"));
  server.define(
    "youtube.localhost",
    "/",
    `<title>YouTube</title>
<ytd-rich-section-renderer id="rayon" class="shorts">Shorts</ytd-rich-section-renderer>
<ytd-reel-shelf-renderer id="reel">reel</ytd-reel-shelf-renderer>
<ytd-guide-entry-renderer id="menu-shorts"><a title="Shorts">Shorts</a></ytd-guide-entry-renderer>
<ytd-guide-entry-renderer id="menu-accueil"><a title="Accueil">Accueil</a></ytd-guide-entry-renderer>`,
  );
}, 30_000);
beforeEach(() => {
  server.cut("vidola-a.localhost", false);
  server.requests.splice(0);
  server.define("adresses.localhost", "/", `<title>Adresses</title><a href="${url("vidola-b.localhost", "/")}">vidola</a>`);
});
afterEach(async () => {
  server.cut("vidola-a.localhost", false);
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close().catch(() => {});
    w = undefined;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (profile) await rm(profile, { recursive: true, force: true });
  }
});
afterAll(() => server?.close());

describe("end to end (AGENTS.md's examples)", () => {
  it("the spec's success: open Vidola, accept the card, enter, sign in, watch episode 4 until 1:10, close; reopen: the home says « reprendre à 1:10 », click: the episode resumes at 1:05 (sites.spec.ts:2006)", { timeout: 150_000 }, async () => {
    await startVidola(false);
    const tabs = await tabUrls();
    const windows = await browserWindows();
    await openSite("vidola");
    await expect.poll(() => text("vidola", "carte-accord-site"), { timeout: 15_000 }).not.toBeNull();
    expect(await text("vidola", "accord-site-domaines")).toContain("images.localhost");
    await inSiteBar(m, "vidola", `doc.querySelector('[data-testid="accorder-site"]').click(); return true;`);
    await expect.poll(homeList, { timeout: 15_000 }).toBe("Aucune série en cours.");
    expect(await seriesCards()).toEqual([]);
    await watch();

    // Close, reopen: no more card, the home shows the series, its image and the minute.
    await closeSiteWindow();
    await openSite("vidola");
    await waitSeriesCard(new RegExp(`^data:image/png;base64,${PNG.toString("base64").replace(/[+/]/g, "\\$&")}$`));
    expect(await text("vidola", "carte-accord-site")).toBeNull();
    await clickSeriesCard();
    await expectResumed("vidola-a.localhost");

    // Nothing leaked: the cookie is the app's own, no tab, no window more than the app's.
    expect(await cookiesOutsideSites()).toEqual([]);
    expect(await tabUrls()).toEqual(tabs);
    expect(await browserWindows()).toBe(windows + 1);
  });

  it("the next day, vidola-a no longer answers: the app opens on vidola-b, says so, and the home reopens the episode on vidola-b (sites.spec.ts:2041)", { timeout: 150_000 }, async () => {
    await startVidola(true);
    await openSite("vidola");
    await watch();
    await closeSiteWindow();

    server.cut("vidola-a.localhost");
    server.requests.splice(0);
    await openSite("vidola");
    await waitSeriesCard(/^data:image\/png;base64,/);
    await barClick("vidola", "site-entrer");
    await expect.poll(() => viewUrl(), { timeout: 30_000 }).toBe(url("vidola-b.localhost", "/"));
    // vidola-a failed first, the reference page was read once and without a cookie, then vidola-b was reached without the sign-in.
    const names = server.requests.map((r) => `${r.host}${r.path}`);
    const firstA = names.indexOf("vidola-a.localhost/");
    const reference = names.indexOf("adresses.localhost/");
    const firstB = names.indexOf("vidola-b.localhost/");
    expect(firstA).toBeGreaterThanOrEqual(0);
    expect(reference).toBeGreaterThan(firstA);
    expect(firstB).toBeGreaterThan(reference);
    expect(server.requests.filter((r) => r.host === "adresses.localhost").map((r) => ({ host: r.host, path: r.path, cookie: r.cookie }))).toEqual([{ host: "adresses.localhost", path: "/", cookie: undefined }]);
    expect(server.requests[firstB]!.cookie).toBeUndefined();
    await expect.poll(() => text("vidola", "site-avis"), { timeout: 15_000 }).toBe("Vidola a changé d'adresse : vidola-b.localhost. Il faudra peut-être te reconnecter.");
    expect(await text("vidola", "site-domaine")).toBe("vidola-b.localhost");
    await barClick("vidola", "site-accueil");
    await expect.poll(() => m.execute<boolean>(`return ${siteWindowExpr("vidola")}.document.documentElement.hasAttribute("webaios-site-home");`)).toBe(true);
    await waitSeriesCard(/^data:image\/png;base64,/);
    await clickSeriesCard();
    await expectResumed("vidola-b.localhost");
  });

  it("YouTube: the Shorts shelves and entry hidden (the example's CSS and JS), the sign-in cookie holds after a restart of WebAiOs (same profile) and exists in no tab (sites.spec.ts:2080)", { timeout: 150_000 }, async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
    writeSite(dataDir, "youtube", siteYoutube());
    await launch();
    const shelves = () =>
      view(
        `[getComputedStyle(document.getElementById("rayon")).display, getComputedStyle(document.getElementById("reel")).display, document.getElementById("menu-shorts"), document.getElementById("menu-accueil") !== null].map((x) => x === null ? "retiré" : x)`,
        "youtube",
      );
    await openSite("youtube");
    await expect.poll(() => text("youtube", "carte-accord-site"), { timeout: 15_000 }).not.toBeNull();
    await inSiteBar(m, "youtube", `doc.querySelector('[data-testid="accorder-site"]').click(); return true;`);
    await waitUrl(url("youtube.localhost", "/"), "youtube");
    await expect.poll(shelves, { timeout: 10_000 }).toEqual(["none", "none", "retiré", true]);
    // The menu is built later: the tweak's observer removes the late entry too.
    await view(`(document.body.insertAdjacentHTML("beforeend", '<ytd-guide-entry-renderer id="tard"><a title="Shorts">Shorts</a></ytd-guide-entry-renderer>'), 1)`, "youtube");
    await expect.poll(() => view('document.getElementById("tard") === null', "youtube")).toBe(true);
    await view("(location.href = '/connexion', 1)", "youtube");
    await expect.poll(() => cookies("youtube"), { timeout: 10_000 }).toContain("SID=abc");
    expect(await cookiesOutsideSites()).toEqual([]);
    expect((await tabUrls()).some((u) => u.includes("youtube"))).toBe(false);
    await w!.close();
    w = undefined;

    // A restart on the same profile: the sign-in holds, the grant too (no card), .shorts stays hidden.
    server.requests.splice(0);
    await launch();
    await openSite("youtube");
    await waitUrl(url("youtube.localhost", "/"), "youtube");
    expect(await text("youtube", "carte-accord-site")).toBeNull();
    await expect.poll(shelves, { timeout: 10_000 }).toEqual(["none", "none", "retiré", true]);
    expect(await cookies("youtube")).toContain("SID=abc");
    expect(server.requests.some((r) => r.host === "youtube.localhost" && r.path === "/" && r.cookie?.includes("SID=abc"))).toBe(true);
    expect(await cookiesOutsideSites()).toEqual([]);
    expect((await tabUrls()).some((u) => u.includes("youtube"))).toBe(false);
  });

  it("the player's adverts: no tab nor window more during the whole scenario (sites.spec.ts:2128)", { timeout: 150_000 }, async () => {
    await startVidola(true);
    const tabs = await tabUrls();
    await openSite("vidola");
    await barClick("vidola", "site-entrer");
    await waitUrl(url("vidola-a.localhost", "/"));
    // The app's own window is made: counted from here, with a probe on every window's tab opens.
    const windows = await browserWindows();
    await m.execute(
      `window.webaiosTestOpened = [];
       for (const x of Services.wm.getEnumerator("navigator:browser")) x.gBrowser.tabContainer.addEventListener("TabOpen", () => window.webaiosTestOpened.push(1));`,
    );
    const beacons = (p: string, refused: number) => server.requests.filter((r) => r.path === `${p}?ouvertures=${p === "/balise" ? 5 : 3}&refus=${refused}`).length;
    const stable = async () => {
      expect(await browserWindows()).toBe(windows);
      expect(await m.execute<number[]>("return window.webaiosTestOpened;")).toEqual([]);
      expect(await tabUrls()).toEqual(tabs);
    };
    await view(`(location.href = ${JSON.stringify(EPISODE)}, 1)`);
    await waitUrl(url("vidola-a.localhost", EPISODE));
    await waitPlayer();
    // The advert scripts did call window.open (5 times in the frame, 3 in the page) and each call was refused (null).
    await expect.poll(() => beacons("/balise", 5), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => beacons("/balise-page", 3), { timeout: 10_000 }).toBe(1);
    await stable();
    // Again: two reloads.
    for (const n of [2, 3]) {
      await view("(location.reload(), 1)");
      await expect.poll(() => beacons("/balise", 5), { timeout: 10_000 }).toBe(n);
      await expect.poll(() => beacons("/balise-page", 3), { timeout: 10_000 }).toBe(n);
      await waitUrl(url("vidola-a.localhost", EPISODE));
      await waitPlayer();
      await stable();
    }
    // One mention, one notice bar.
    await expect.poll(() => bar<number>("vidola", `return doc.querySelectorAll('[data-testid="site-avis"]').length;`), { timeout: 10_000 }).toBe(1);
    const notice = (await text("vidola", "site-avis")) ?? "";
    expect(notice).toContain("Lien vers pub.localhost bloqué");
    expect((notice.match(/Lien vers/g) ?? []).length).toBe(1);
    expect(server.requests.filter((r) => r.host === "pub.localhost" && r.path === "/popup")).toEqual([]);
  });
});
