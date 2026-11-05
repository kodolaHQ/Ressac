import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, inWindow, newWindow, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { waitUi } from "./ui";

// Site permissions through the WebAiOs banner (chrome/window/site-banner.ts, chrome/store/permission-hooks.ts), ported
// from apps/navigateur/e2e/permissions.spec.ts. No network, no real device (spike P1, P7).

/** What `/p?do=<what>` runs as it loads (`&auto`) or on a click of #go; its title is then "done:<json>". */
const PAGE = `<!doctype html><meta charset="utf-8"><title>ready</title>
<button id="go" style="width:300px;height:120px">go</button><div id="frames"></div>
<script>
const ACTIONS = {
  none: async () => null,
  perm: async () => Notification.permission,
  notif: () => Notification.requestPermission(),
  notif2: () => Promise.all([Notification.requestPermission(), Notification.requestPermission()]),
  geo: () => new Promise((ok) => navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude }), (e) => ok({ code: e.code }), { timeout: 20000 })),
  persist: () => navigator.storage.persist(),
  sa: async () => (await document.requestStorageAccess(), "granted"),
  xr: async () => (navigator.xr ? navigator.xr.requestSession("inline").then(() => "granted", (e) => e.name) : "no WebXR"),
  popup: async () => !!window.open("/p?do=notif&auto&popup", "notif", "width=500,height=600"),
};
const q = new URLSearchParams(location.search);
const done = (v) => { document.title = "done:" + JSON.stringify(v); if (parent !== window) parent.postMessage(document.title, "*"); };
const run = async () => { document.title = "pending"; try { done({ ok: await ACTIONS[q.get("do")]() }); } catch (e) { done({ err: e?.name ?? String(e) }); } };
document.getElementById("go").onclick = run;
addEventListener("message", (e) => (document.title = "frame:" + e.data));
if (q.get("frame")) document.getElementById("frames").innerHTML = '<iframe allow="storage-access" style="width:400px;height:200px" src="' + q.get("frame") + '"></iframe>';
if (q.has("auto")) run();
</script>`;

const PREFS = {
  // Test geolocation provider on a data: URL, never CoreLocation (a macOS prompt).
  "geo.provider.testing": true,
  "geo.provider.use_corelocation": false,
  "geo.provider.network.scan": false,
  "geo.provider.network.timeToWaitBeforeSending": 10,
  "geo.provider.network.url": 'data:application/json,{"location":{"lat":48.8566,"lng":2.3522},"accuracy":42}',
};

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
const BANNER = '[data-testid="demande-permission"]';

/** A server of PAGE: each test takes fresh origins, so no earlier decision answers for it. */
async function startPages(): Promise<{ url: string; port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/p") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, close: () => new Promise((ok) => (server.close(() => ok()), server.closeAllConnections())) };
}

describe("site permissions", () => {
  const servers: Awaited<ReturnType<typeof startPages>>[] = [];
  let dirs: { dataDir: string; profile: string };
  let w: LaunchedWebAiOs;
  let m: Marionette;
  let opened = 0;

  const chrome = <T = any>(body: string, args: unknown[] = []) => m.execute<T>(`return (async () => { ${body} })();`, args);
  const origin = async () => {
    const s = await startPages();
    servers.push(s);
    return s.url;
  };

  async function launch(first = true): Promise<void> {
    w = await launchWebAiOs({ ...dirs, prefs: PREFS });
    m = w.marionette;
    await m.setContext("chrome");
    await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
    // The home page's agent session settles first: quitting during its start-up leaves writers in the data dir. A
    // restart shows the restored tabs, not the home page.
    if (first) await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
  }

  /** Opens `/p?do=<what>` (made unique) of `base` in a WebAiOs tab of the first window; returns its tab id once loaded. */
  async function open(base: string, what: string, o: { auto?: boolean; extra?: string } = { auto: true }): Promise<string> {
    const url = `${base}/p?do=${what}${o.auto ? "&auto" : ""}${o.extra ?? ""}&k=${++opened}`;
    const s = await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url });
    const id = Object.entries(s.onglets).find(([, t]) => t.url === url)![0];
    await waitFor(m, `return !!${browser(id)}?.contentTitle`, (v) => v === true);
    return id;
  }
  const browser = (id: string) => `gBrowser.tabs.find((t) => t.getAttribute("webaios-tab-id") === ${JSON.stringify(id)})?.linkedBrowser`;
  /** The page's result: its title once "done:…" (or "frame:done:…"). */
  async function result(id: string): Promise<unknown> {
    const t = await waitFor<string>(m, `return ${browser(id)}.contentTitle`, (t) => /^(frame:)?done:/.test(t), 20_000);
    return JSON.parse(t.replace(/^(frame:)?done:/, ""));
  }
  /** The banner's text in the current window, or null when it is not shown. */
  const banner = () => m.execute<string | null>(`const b = document.querySelector('${BANNER}'); return b?.checkVisibility() ? b.querySelector("span").textContent : null;`);
  const waitBanner = (ok: (t: string | null) => boolean) => waitFor(m, `const b = document.querySelector('${BANNER}'); return b?.checkVisibility() ? b.querySelector("span").textContent : null;`, ok);
  const answer = (label: "Refuser" | "Autoriser") =>
    m.execute(`[...document.querySelector('${BANNER}').querySelectorAll("button")].find((b) => b.textContent === arguments[0]).click();`, [label]);
  const pending = () => chrome<unknown[]>(`return (await ChromeUtils.importESModule("${STORE}").ready).questions.pending();`);
  /** The decisions kept for the default profile (Electron's permissions.json). */
  const saved = () => readFile(path.join(dirs.dataDir, "permissions.json"), "utf8").then((t) => JSON.parse(t) as Record<string, string>, () => ({}));
  const reload = async (id: string) => {
    await m.execute(`${browser(id)}.reload();`);
    await waitFor<string>(m, `return ${browser(id)}.contentTitle`, (t) => t === "ready" || t === "pending" || t.startsWith("done:"));
  };

  /** A trusted click (WebDriver actions: a user gesture) on #go of the tab's page, or of its first frame. */
  async function clickGo(id: string, inFrame = false): Promise<void> {
    const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    const handle = await m.execute<string>(`return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(${browser(id)});`);
    await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
    await m.setContext("content");
    try {
      if (inFrame) await m.command("WebDriver:SwitchToFrame", { id: 0 });
      const found = await m.command<{ value: Record<string, string> }>("WebDriver:FindElement", { using: "css selector", value: "#go" });
      await m.command("WebDriver:PerformActions", {
        actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: found.value, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
      });
      await m.command("WebDriver:ReleaseActions");
    } finally {
      if (inFrame) await m.command("WebDriver:SwitchToFrame", {}).catch(() => {});
      await m.setContext("chrome");
      await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
    }
  }

  beforeAll(async () => {
    dirs = { dataDir: await mkdtemp(path.join(os.tmpdir(), "webaios-data-")), profile: await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-")) };
    await launch();
  }, 90_000);
  afterAll(async () => {
    await w?.close();
    await Promise.all(servers.map((s) => s.close()));
    if (dirs) await Promise.all([rm(dirs.dataDir, { recursive: true, force: true }), rm(dirs.profile, { recursive: true, force: true })]);
  });
  afterEach(async () => {
    // Never a Firefox prompt for a site permission, in any window.
    const firefox = await m.execute(
      `return [...Services.wm.getEnumerator("navigator:browser")].map((w) => ({ panel: w.PopupNotifications.panel.state, notifications: w.PopupNotifications._currentNotifications.map((n) => n.id) }));`,
    );
    // Back to one window on the first space, no question left over.
    await chrome(`
      const s = await ChromeUtils.importESModule("${STORE}").ready;
      for (const q of s.questions.pending()) s.questions.answer(q.id, "refuser");
      for (const w of [...Services.wm.getEnumerator("navigator:browser")]) if (w !== window) w.close();
      s.dispatch({ type: "activerEspace", fenetreId: s.state.fenetres[0].id, id: s.state.espaces[0].id });`);
    for (const f of firefox as unknown[]) expect(f).toEqual({ panel: "closed", notifications: [] });
  });

  it("une page qui demande les notifications affiche le bandeau ; Autoriser → Notification.permission === 'granted'", { timeout: 120_000 }, async () => {
    const base = await origin();
    const id = await open(base, "notif");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
    await answer("Autoriser");
    await waitBanner((t) => t === null);
    expect(await result(id)).toEqual({ ok: "granted" });
    expect(await result(await open(base, "perm"))).toEqual({ ok: "granted" });
    // Kept: after a restart, no question.
    await w.close();
    await launch(false);
    expect(await result(await open(base, "notif"))).toEqual({ ok: "granted" });
    expect(await banner()).toBeNull();
    expect(await result(await open(base, "perm"))).toEqual({ ok: "granted" });
  });

  it("Refuser → la page reçoit 'denied'", async () => {
    const id = await open(await origin(), "notif");
    await waitBanner((t) => t !== null);
    await answer("Refuser");
    expect(await result(id)).toEqual({ ok: "denied" });
  });

  it("la question d'une popup s'affiche sur l'onglet qui l'a ouverte, pas dans les autres fenêtres", { timeout: 60_000 }, async () => {
    const other = await newWindow(m);
    await open(await origin(), "popup");
    await waitFor(m, `return [...Services.wm.getEnumerator("navigator:browser")].some((w) => w.gBrowser.selectedBrowser.currentURI.spec.includes("&popup"))`, (v) => v === true);
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
    await new Promise((r) => setTimeout(r, 300));
    expect(await inWindow(m, other, banner)).toBeNull();
  });

  it("la position : demandée une fois, retenue après un rechargement", async () => {
    const base = await origin();
    const id = await open(base, "geo");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut connaître votre position$/);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: { lat: 48.8566 } });
    await reload(id);
    expect(await result(id)).toEqual({ ok: { lat: 48.8566 } });
    expect(await banner()).toBeNull();
    expect(await saved()).toMatchObject({ [`${base} geolocation`]: "autoriser" });
  });

  it("la même origine dans un espace d'un autre profil est redemandée", async () => {
    const base = await origin();
    const first = await open(base, "notif");
    await waitBanner((t) => t !== null);
    await answer("Autoriser");
    expect(await result(first)).toEqual({ ok: "granted" });
    await dispatch(m, { type: "creerEspace", nom: "Autre", icone: "🅰", prive: false, profil: "nouveau", fenetreId: (await state(m)).fenetres[0]!.id });
    const id = await open(base, "notif");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
    await answer("Refuser");
    expect(await result(id)).toEqual({ ok: "denied" });
  });

  it("fermer l'onglet pendant la question : refusé, redemandé au prochain chargement", async () => {
    const base = await origin();
    const id = await open(base, "notif");
    await waitBanner((t) => t !== null);
    await dispatch(m, { type: "fermerOnglet", id });
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).questions.pending().length)();`, (n) => n === 0);
    expect(await saved()).not.toHaveProperty(`${base} notifications`);
    await open(base, "notif");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
  });

  it("l'onglet change de site pendant la question : le bandeau disparaît, rien n'est retenu", async () => {
    const base = await origin();
    const id = await open(base, "geo");
    await waitBanner((t) => t !== null);
    // Another site: localhost instead of 127.0.0.1.
    const elsewhere = `${base.replace("127.0.0.1", "localhost")}/p?do=none`;
    await m.execute(`${browser(id)}.fixupAndLoadURIString(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [elsewhere]);
    await waitBanner((t) => t === null);
    expect(await pending()).toEqual([]);
    expect(await saved()).not.toHaveProperty(`${base} geolocation`);
  });

  it("deux demandes en même temps : un seul bandeau", async () => {
    const id = await open(await origin(), "notif2");
    await waitBanner((t) => t !== null);
    await new Promise((r) => setTimeout(r, 500));
    expect(await pending()).toHaveLength(1);
    expect(await m.execute(`return document.querySelectorAll('${BANNER}').length`)).toBe(1);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: ["granted", "granted"] });
  });

  it("storage-access, xr, persistent-storage : refusés sans bandeau", { timeout: 60_000 }, async () => {
    const base = await origin();
    const port = new URL(base).port;
    await m.execute(`Cc["@mozilla.org/network/native-dns-override;1"].getService(Ci.nsINativeDNSResolverOverride).addIPOverride("site2.localhost", "127.0.0.1");`);
    const sa = await open(base, "none", { extra: `&frame=${encodeURIComponent(`http://site2.localhost:${port}/p?do=sa`)}` });
    await clickGo(sa, true);
    expect(await result(sa)).toEqual({ err: "NotAllowedError" });
    const persist = await open(base, "persist", {});
    await clickGo(persist);
    expect(await result(persist)).toEqual({ ok: false });
    // No WebXR in this build (spike P1): never asked; refused like any type off the list if it comes back.
    expect(await result(await open(base, "xr"))).toMatchObject({ ok: expect.stringMatching(/no WebXR|NotAllowedError|NotSupportedError/) });
    expect(await pending()).toEqual([]);
    expect(await banner()).toBeNull();
  });

  it("une lecture invisible qui demande les notifications : refusée, sans bandeau", async () => {
    const base = await origin();
    const read = await chrome<{ titre: string }>(
      `const s = await ChromeUtils.importESModule("${STORE}").ready; return s.readPage(arguments[0], { profil: null, adressesLocales: true });`,
      [`${base}/p?do=notif&auto`],
    );
    expect(read.titre).toBe('done:{"ok":"default"}');
    expect(await pending()).toEqual([]);
    expect(await banner()).toBeNull();
    expect(await saved()).not.toHaveProperty(`${base} notifications`);
  });

  it("le bandeau ne couvre pas la page : le haut de la page est sous le bandeau", async () => {
    const top = "return gBrowser.selectedBrowser.getBoundingClientRect().top";
    const base = await origin();
    await open(base, "none");
    const before = await m.execute<number>(top);
    const id = await open(base, "notif");
    await waitBanner((t) => t !== null);
    const r = await m.execute<{ banner: number[]; page: number }>(
      `const b = document.querySelector('${BANNER}').getBoundingClientRect(); return { banner: [b.top, b.bottom], page: gBrowser.selectedBrowser.getBoundingClientRect().top };`,
    );
    expect(r.banner[0]).toBe(0);
    expect(r.banner[1]).toBeGreaterThan(20);
    expect(r.page).toBeGreaterThanOrEqual(r.banner[1]! - 0.5);
    await answer("Refuser");
    await result(id);
    // The page goes back up once the banner is gone.
    await waitFor(m, top, (t: number) => t === before);
  });

  it("un espace privé : mêmes questions, retenues par son profil", async () => {
    const base = await origin();
    await dispatch(m, { type: "creerEspace", nom: "Privé", icone: "🔒", prive: true, profil: "nouveau", fenetreId: (await state(m)).fenetres[0]!.id });
    const s = await state(m);
    const profil = s.espaces.find((e) => e.nom === "Privé")!.profil;
    const id = await open(base, "notif");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: "granted" });
    await reload(id);
    expect(await result(id)).toEqual({ ok: "granted" });
    expect(await banner()).toBeNull();
    const kept = await readFile(path.join(dirs.dataDir, `permissions-${profil}.json`), "utf8").then(JSON.parse);
    expect(kept).toEqual({ [`${base} notifications`]: "autoriser" });
    expect(await saved()).not.toHaveProperty(`${base} notifications`);
  });

  it("le bandeau suit l'onglet : caché sur un autre onglet, revenu en y revenant", async () => {
    const base = await origin();
    const asking = await open(base, "notif");
    await waitBanner((t) => t !== null);
    await open(base, "none");
    await waitBanner((t) => t === null);
    await dispatch(m, { type: "activerOnglet", id: asking });
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
  });
});
