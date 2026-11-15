import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, inWindow, newWindow, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { waitUi } from "./ui";

// Site permissions through the Ressac banner (chrome/window/site-banner.ts, chrome/store/permission-hooks.ts). No
// network, no real device (spike P1, P7).

/** What `/p?do=<what>` runs as it loads (`&auto`) or on a click of #go; its title is then "done:<json>". */
const PAGE = `<!doctype html><meta charset="utf-8"><title>ready</title>
<button id="go" style="width:300px;height:120px">go</button><div id="frames"></div>
<script>
const gum = async (c) => { const s = await navigator.mediaDevices.getUserMedia(c); const r = s.getTracks().map((t) => t.kind); s.getTracks().forEach((t) => t.stop()); return r; };
const ACTIONS = {
  none: async () => null,
  perm: async () => Notification.permission,
  notif: () => Notification.requestPermission(),
  notif2: () => Promise.all([Notification.requestPermission(), Notification.requestPermission()]),
  geo: () => new Promise((ok) => navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude }), (e) => ok({ code: e.code }), { timeout: 20000 })),
  persist: () => navigator.storage.persist(),
  sa: async () => (await document.requestStorageAccess(), "granted"),
  xr: async () => (navigator.xr ? navigator.xr.requestSession("inline").then(() => "granted", (e) => e.name) : "no WebXR"),
  cam: () => gum({ video: true }),
  both: () => gum({ video: true, audio: true }),
  screen: async () => { const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); s.getTracks().forEach((t) => t.stop()); return "shared"; },
  midi: async () => { const a = await navigator.requestMIDIAccess(); return { inputs: a.inputs.size }; },
  drm: () => navigator.requestMediaKeySystemAccess("org.w3.clearkey", [{ initDataTypes: ["webm"], videoCapabilities: [{ contentType: 'video/webm; codecs="vp8"' }] }]).then((a) => a.keySystem),
  audio: async () => { const n = 8000, b = new DataView(new ArrayBuffer(44 + n * 2)); const s = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
    s(0, "RIFF"); b.setUint32(4, 36 + n * 2, true); s(8, "WAVEfmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
    b.setUint32(24, 8000, true); b.setUint32(28, 16000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); s(36, "data"); b.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.sin(i / 3) * 8000, true);
    const a = new Audio(URL.createObjectURL(new Blob([b], { type: "audio/wav" })));
    // A refused play() rejects (NotAllowedError); in a background tab an allowed one may stay pending, so only the policy and the absence of a rejection count.
    await Promise.race([a.play(), new Promise((ok) => setTimeout(ok, 1500))]); a.pause(); return navigator.getAutoplayPolicy("mediaelement"); },
  blocked: async () => window.open("/p?do=none", "_blank") === null,
  fs: async () => (await document.documentElement.requestFullscreen(), "full"),
  clipr: () => navigator.clipboard.readText(),
  proto: async () => { location.href = "ressac-test:hello"; return "navigated"; },
  popup: async () => !!window.open("/p?do=notif&auto&popup", "notif", "width=500,height=600"),
};
const q = new URLSearchParams(location.search);
const done = (v) => { document.title = "done:" + JSON.stringify(v); if (parent !== window) parent.postMessage(document.title, "*"); };
const run = async () => { document.title = "pending"; try { done({ ok: await ACTIONS[q.get("do")]() }); } catch (e) { done({ err: e?.name ?? String(e) }); } };
document.getElementById("go").onclick = run;
addEventListener("message", (e) => (document.title = "frame:" + e.data));
if (q.get("frame")) document.getElementById("frames").innerHTML = '<iframe allow="storage-access;camera;microphone" style="width:400px;height:200px" src="' + q.get("frame") + '"></iframe>';
if (q.has("auto")) run();
</script>`;

const PREFS = {
  // Fake camera and microphone: no device, no macOS question (spike P2).
  "media.navigator.streams.fake": true,
  // Test geolocation provider on a data: URL, never CoreLocation (a macOS prompt).
  // A test MIDI port, no real device (spike P1).
  "midi.testing": true,
  "geo.provider.testing": true,
  "geo.provider.use_corelocation": false,
  "geo.provider.network.scan": false,
  "geo.provider.network.timeToWaitBeforeSending": 10,
  "geo.provider.network.url": 'data:application/json,{"location":{"lat":48.8566,"lng":2.3522},"accuracy":42}',
};

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
const BANNER = '[data-testid="permission-request"]';

/** A server of PAGE: each test takes fresh origins, so no earlier decision answers for it. */
async function startPages(): Promise<{ url: string; port: number; handled: string[]; close(): Promise<void> }> {
  const handled: string[] = [];
  const server = createServer((req, res) => {
    // The test scheme's web handler lands here.
    if (new URL(req.url ?? "/", "http://x").pathname === "/handled") return handled.push(req.url!), res.writeHead(200, { "Content-Type": "text/html" }).end("<title>handled</title>");
    if (new URL(req.url ?? "/", "http://x").pathname === "/p") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, handled, close: () => new Promise((ok) => (server.close(() => ok()), server.closeAllConnections())) };
}

describe("site permissions", () => {
  const servers: Awaited<ReturnType<typeof startPages>>[] = [];
  let dirs: { dataDir: string; profile: string };
  let w: LaunchedRessac;
  let m: Marionette;
  let opened = 0;

  const chrome = <T = any>(body: string, args: unknown[] = []) => m.execute<T>(`return (async () => { ${body} })();`, args);
  const origin = async () => {
    const s = await startPages();
    servers.push(s);
    return s.url;
  };

  async function launch(first = true): Promise<void> {
    w = await launchRessac({ ...dirs, prefs: PREFS });
    m = w.marionette;
    await m.setContext("chrome");
    await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
    // The home page's agent session settles first: quitting during its start-up leaves writers in the data dir. A
    // restart shows the restored tabs, not the home page.
    if (first) await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
  }

  /** Opens `/p?do=<what>` (made unique) of `base` in a Ressac tab of the first window; returns its tab id once loaded. */
  async function open(base: string, what: string, o: { auto?: boolean; extra?: string } = { auto: true }): Promise<string> {
    const url = `${base}/p?do=${what}${o.auto ? "&auto" : ""}${o.extra ?? ""}&k=${++opened}`;
    const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url });
    const id = Object.entries(s.tabs).find(([, t]) => t.url === url)![0];
    await waitFor(m, `return !!${browser(id)}?.contentTitle`, (v) => v === true);
    return id;
  }
  const browser = (id: string) => `gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === ${JSON.stringify(id)})?.linkedBrowser`;
  /** The page's result: its title once "done:…" (or "frame:done:…"). */
  async function result(id: string): Promise<unknown> {
    const t = await waitFor<string>(m, `return ${browser(id)}.contentTitle`, (t) => /^(frame:)?done:/.test(t), 20_000);
    return JSON.parse(t.replace(/^(frame:)?done:/, ""));
  }
  /** The banner's text in the current window, or null when it is not shown. */
  const banner = () => m.execute<string | null>(`const b = document.querySelector('${BANNER}'); return b?.checkVisibility() ? b.querySelector("span").textContent : null;`);
  const waitBanner = (ok: (t: string | null) => boolean) => waitFor(m, `const b = document.querySelector('${BANNER}'); return b?.checkVisibility() ? b.querySelector("span").textContent : null;`, ok);
  const press = (label: "Refuser" | "Autoriser") =>
    m.execute(`[...document.querySelector('${BANNER}').querySelectorAll("button")].find((b) => b.textContent === arguments[0]).click();`, [label]);
  /** « Autoriser » takes a click only once armed (ARM_MS after the request shows), as for a person. */
  const answer = async (label: "Refuser" | "Autoriser") => {
    if (label === "Autoriser") await waitFor(m, `return document.querySelector('${BANNER} button.allow')?.dataset.armed !== undefined;`, (x) => x === true);
    await press(label);
  };
  const pending = () => chrome<unknown[]>(`return (await ChromeUtils.importESModule("${STORE}").ready).questions.pending();`);
  /** The decisions kept for the default profile (permissions.json). */
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
    dirs = { dataDir: await mkdtemp(path.join(os.tmpdir(), "ressac-data-")), profile: await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-")) };
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
      for (const q of s.questions.pending()) s.questions.answer(q.id, "deny");
      for (const w of [...Services.wm.getEnumerator("navigator:browser")]) if (w !== window) w.close();
      s.dispatch({ type: "activateSpace", windowId: s.state.windows[0].id, id: s.state.spaces[0].id });`);
    for (const f of firefox as unknown[]) expect(f).toEqual({ panel: "closed", notifications: [] });
  });

  it("a page that asks for notifications shows the banner; Autoriser → Notification.permission === 'granted'", { timeout: 120_000 }, async () => {
    const base = await origin();
    const id = await open(base, "notif");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
    // Right as it shows, a click meant for the page grants nothing.
    await press("Autoriser");
    expect(await banner()).not.toBeNull();
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

  it("Refuser → the page receives 'denied'", async () => {
    const id = await open(await origin(), "notif");
    await waitBanner((t) => t !== null);
    await answer("Refuser");
    expect(await result(id)).toEqual({ ok: "denied" });
  });

  it("a popup's question shows on the tab that opened it, not in the other windows", { timeout: 60_000 }, async () => {
    const other = await newWindow(m);
    await open(await origin(), "popup");
    await waitFor(m, `return [...Services.wm.getEnumerator("navigator:browser")].some((w) => w.gBrowser.selectedBrowser.currentURI.spec.includes("&popup"))`, (v) => v === true);
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
    await new Promise((r) => setTimeout(r, 300));
    expect(await inWindow(m, other, banner)).toBeNull();
  });

  it("location: asked once, kept after a reload", async () => {
    const base = await origin();
    const id = await open(base, "geo");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut connaître votre position$/);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: { lat: 48.8566 } });
    await reload(id);
    expect(await result(id)).toEqual({ ok: { lat: 48.8566 } });
    expect(await banner()).toBeNull();
    expect(await saved()).toMatchObject({ [`${base} geolocation`]: "allow" });
  });

  it("the same origin in a space of another profile is asked again", async () => {
    const base = await origin();
    const first = await open(base, "notif");
    await waitBanner((t) => t !== null);
    await answer("Autoriser");
    expect(await result(first)).toEqual({ ok: "granted" });
    await dispatch(m, { type: "createSpace", name: "Autre", icon: "🅰", private: false, profile: "new", windowId: (await state(m)).windows[0]!.id });
    const id = await open(base, "notif");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
    await answer("Refuser");
    expect(await result(id)).toEqual({ ok: "denied" });
  });

  it("closing the tab during the question: denied, asked again at the next load", async () => {
    const base = await origin();
    const id = await open(base, "notif");
    await waitBanner((t) => t !== null);
    await dispatch(m, { type: "closeTab", id });
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).questions.pending().length)();`, (n) => n === 0);
    expect(await saved()).not.toHaveProperty(`${base} notifications`);
    await open(base, "notif");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
  });

  it("the tab changes site during the question: the banner disappears, nothing is kept", async () => {
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

  it("two requests at the same time: a single banner", async () => {
    const id = await open(await origin(), "notif2");
    await waitBanner((t) => t !== null);
    await new Promise((r) => setTimeout(r, 500));
    expect(await pending()).toHaveLength(1);
    expect(await m.execute(`return document.querySelectorAll('${BANNER}').length`)).toBe(1);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: ["granted", "granted"] });
  });

  it("storage-access, xr, persistent-storage: denied without a banner", { timeout: 60_000 }, async () => {
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

  it("an invisible read that asks for notifications: denied, without a banner", async () => {
    const base = await origin();
    const read = await chrome<{ title: string }>(
      `const s = await ChromeUtils.importESModule("${STORE}").ready; return s.readPage(arguments[0], { profile: null, localAddresses: true });`,
      [`${base}/p?do=notif&auto`],
    );
    expect(read.title).toBe('done:{"ok":"default"}');
    expect(await pending()).toEqual([]);
    expect(await banner()).toBeNull();
    expect(await saved()).not.toHaveProperty(`${base} notifications`);
  });

  it("the banner does not cover the page: the top of the page is under the banner", async () => {
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

  it("a private space: same questions, kept by its profile", async () => {
    const base = await origin();
    await dispatch(m, { type: "createSpace", name: "Privé", icon: "🔒", private: true, profile: "new", windowId: (await state(m)).windows[0]!.id });
    const s = await state(m);
    const profile = s.spaces.find((e) => e.name === "Privé")!.profile;
    const id = await open(base, "notif");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
    // Right as it shows, a click meant for the page grants nothing.
    await press("Autoriser");
    expect(await banner()).not.toBeNull();
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: "granted" });
    await reload(id);
    expect(await result(id)).toEqual({ ok: "granted" });
    expect(await banner()).toBeNull();
    const kept = await readFile(path.join(dirs.dataDir, `permissions-${profile}.json`), "utf8").then(JSON.parse);
    expect(kept).toEqual({ [`${base} notifications`]: "allow" });
    expect(await saved()).not.toHaveProperty(`${base} notifications`);
  });

  it("the banner follows the tab: hidden on another tab, back when coming back to it", async () => {
    const base = await origin();
    const asking = await open(base, "notif");
    await waitBanner((t) => t !== null);
    await open(base, "none");
    await waitBanner((t) => t === null);
    await dispatch(m, { type: "activateTab", id: asking });
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut vous envoyer des notifications$/);
  });

  it("a site's camera request stays a banner, not a modal: the page stays displayed", async () => {
    const id = await open(await origin(), "cam");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut utiliser votre caméra$/);
    expect(await m.execute(`return gBrowser.selectedBrowser.checkVisibility() && gBrowser.getTabDialogBox(gBrowser.selectedBrowser)._tabDialogManager._dialogs.length`)).toBe(0);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: ["video"] });
  });

  it("camera and microphone together: a single banner « utiliser votre caméra et votre micro », kept; a reload does not ask again", async () => {
    const base = await origin();
    const id = await open(base, "both");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut utiliser votre caméra et votre micro$/);
    expect(await pending()).toHaveLength(1);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: ["audio", "video"] });
    await reload(id);
    expect(await result(id)).toEqual({ ok: ["audio", "video"] });
    expect(await banner()).toBeNull();
    expect(await saved()).toMatchObject({ [`${base} media-camera`]: "allow", [`${base} media-micro`]: "allow" });
    // Refused: NotAllowedError, kept too.
    const other = await open(await origin(), "both");
    await waitBanner((t) => t !== null);
    await answer("Refuser");
    expect(await result(other)).toEqual({ err: "NotAllowedError" });
  });

  it("a frame from another site asks for the camera: the banner names the frame, the decision is kept for it", { timeout: 60_000 }, async () => {
    const base = await origin();
    const port = new URL(base).port;
    await m.execute(`Cc["@mozilla.org/network/native-dns-override;1"].getService(Ci.nsINativeDNSResolverOverride).addIPOverride("site2.localhost", "127.0.0.1");`);
    const frame = `http://site2.localhost:${port}`;
    const id = await open(base, "none", { extra: `&frame=${encodeURIComponent(`${frame}/p?do=cam&auto`)}` });
    expect(await waitBanner((t) => t !== null)).toBe(`site2.localhost:${port} veut utiliser votre caméra`);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: ["video"] });
    expect(await saved()).toMatchObject({ [`${frame} media-camera`]: "allow" });
    expect(await saved()).not.toHaveProperty(`${base} media-camera`);
  });

  it("screen sharing: the banner every time", { timeout: 60_000 }, async () => {
    const id = await open(await origin(), "screen", {});
    for (let i = 0; i < 2; i++) {
      await clickGo(id);
      expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut partager votre écran$/);
      await answer("Refuser");
      await waitBanner((t) => t === null);
      expect(await result(id)).toEqual({ err: "NotAllowedError" });
      await reload(id);
    }
    expect(Object.keys(await saved()).filter((k) => /screen|partage/.test(k))).toEqual([]);
  });

  it("a link to another application: the banner with the link, every time", { timeout: 60_000 }, async () => {
    const base = await origin();
    const handler = await origin();
    const handled = servers[servers.length - 1]!.handled;
    // A web handler for ressac-test:, so Firefox knows an application for it (spike P5).
    await chrome(
      `const eps = Cc["@mozilla.org/uriloader/external-protocol-service;1"].getService(Ci.nsIExternalProtocolService);
       const info = eps.getProtocolHandlerInfo("ressac-test");
       const app = Cc["@mozilla.org/uriloader/web-handler-app;1"].createInstance(Ci.nsIWebHandlerApp);
       app.name = "test"; app.uriTemplate = arguments[0] + "/handled?u=%s";
       info.possibleApplicationHandlers.appendElement(app);
       info.preferredApplicationHandler = app; info.preferredAction = Ci.nsIHandlerInfo.useHelperApp; info.alwaysAskBeforeHandling = false;
       Cc["@mozilla.org/uriloader/handler-service;1"].getService(Ci.nsIHandlerService).store(info);`,
      [handler],
    );
    const id = await open(base, "proto", {});
    await clickGo(id);
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut ouvrir un lien dans une autre application : ressac-test:hello$/);
    await answer("Refuser");
    await waitBanner((t) => t === null);
    await new Promise((r) => setTimeout(r, 500));
    expect(handled).toEqual([]);
    // Asked again, and this time allowed: the handler's page loads.
    await clickGo(id);
    await waitBanner((t) => t !== null);
    await answer("Autoriser");
    await waitFor(m, `return ${browser(id)}.currentURI.spec`, (u: string) => u.includes("/handled?u="));
    expect(handled).toHaveLength(1);
    expect(Object.keys(await saved()).filter((k) => /ouvrir|application/.test(k))).toEqual([]);
  });

  it("DRM: the banner, then navigator.requestMediaKeySystemAccess('org.w3.clearkey', …) succeeds; kept", { timeout: 60_000 }, async () => {
    const base = await origin();
    const id = await open(base, "drm");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut lire des contenus protégés \(DRM\)$/);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: "org.w3.clearkey" });
    await reload(id);
    expect(await result(id)).toEqual({ ok: "org.w3.clearkey" });
    expect(await banner()).toBeNull();
    expect(await saved()).toMatchObject({ [`${base} drm`]: "allow" });
  });

  it("MIDI: the banner, then navigator.requestMIDIAccess() succeeds; no module in about:addons", { timeout: 60_000 }, async () => {
    const id = await open(await origin(), "midi");
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut utiliser vos appareils MIDI$/);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: { inputs: 1 } });
    const addons = await chrome(`const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"); return (await AddonManager.getAllAddons()).filter((a) => a.type === "sitepermission").map((a) => a.id);`);
    expect(addons).toEqual([]);
  });

  it("a sound plays without a click (autoplay allowed)", async () => {
    const id = await open(await origin(), "audio");
    expect(await result(id)).toEqual({ ok: "allowed" });
  });

  const until = async (ok: () => Promise<boolean>) => {
    for (const end = Date.now() + 10_000; !(await ok()); await new Promise((r) => setTimeout(r, 100))) if (Date.now() > end) throw new Error("timed out");
  };
  /** Triggers the « Navigation » menu entry of the current window by its command, as a click on it does. */
  const forgetFromMenu = () => m.execute(`document.getElementById("ressac-forget-permissions").doCommand();`);

  it("Oublier les autorisations de ce site: the page asks again, Notification.permission goes back to 'default'", { timeout: 60_000 }, async () => {
    const base = await origin();
    const id = await open(base, "notif");
    await waitBanner((t) => t !== null);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: "granted" });
    expect(await saved()).toHaveProperty(`${base} notifications`);
    expect(await m.execute<string>(`return document.getElementById("main-menubar").querySelector("menu[label='Navigation']").label;`)).toBe("Navigation");
    await forgetFromMenu();
    await until(async () => !(`${base} notifications` in (await saved())));
    expect(await result(await open(base, "perm"))).toEqual({ ok: "default" });
    const again = await open(base, "notif");
    expect(await waitBanner((t) => t !== null)).toMatch(/veut vous envoyer des notifications$/);
    await answer("Refuser");
    expect(await result(again)).toEqual({ ok: "denied" });
  });

  it("a deleted profile: its permissions.json and its decisions in Firefox disappear", { timeout: 60_000 }, async () => {
    const base = await origin();
    const windowId = (await state(m)).windows[0]!.id;
    await dispatch(m, { type: "createSpace", name: "Jetable", icon: "🗑", private: false, profile: "new", windowId: windowId });
    const space = (await state(m)).spaces.find((e) => e.name === "Jetable")!;
    const file = path.join(dirs.dataDir, `permissions-${space.profile}.json`);
    const id = await open(base, "notif");
    await waitBanner((t) => t !== null);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: "granted" });
    const inFirefox = () => chrome<number>(`return Services.perms.all.filter((p) => p.type === "desktop-notification" && p.principal.originNoSuffix === arguments[0] && p.principal.originAttributes.userContextId > 0).length;`, [base]);
    expect(await inFirefox()).toBe(1);
    expect(await readFile(file, "utf8").then(JSON.parse)).toHaveProperty(`${base} notifications`);
    await dispatch(m, { type: "deleteSpace", id: space.id });
    await until(() => access(file).then(() => false, () => true));
    expect(await inFirefox()).toBe(0);
  });

  it("an answer stored in Firefox before this block is removed at startup: the site asks again through the banner", { timeout: 90_000 }, async () => {
    const base = await origin();
    await chrome(`Services.perms.addFromPrincipal(Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(arguments[0]), {}), "desktop-notification", Services.perms.ALLOW_ACTION, Services.perms.EXPIRE_NEVER);`, [base]);
    await w.close();
    await launch(false);
    const id = await open(base, "notif");
    expect(await waitBanner((t) => t !== null)).toMatch(/veut vous envoyer des notifications$/);
    await answer("Refuser");
    expect(await result(id)).toEqual({ ok: "denied" });
  });

  it("permissions.json survives the restart, and Firefox applies it again", { timeout: 90_000 }, async () => {
    const base = await origin();
    const id = await open(base, "notif");
    await waitBanner((t) => t !== null);
    await answer("Autoriser");
    expect(await result(id)).toEqual({ ok: "granted" });
    await w.close();
    await launch(false);
    expect(await saved()).toMatchObject({ [`${base} notifications`]: "allow" });
    // Firefox answers before any question: the page reads it without asking.
    expect(await result(await open(base, "perm"))).toEqual({ ok: "granted" });
    expect(await banner()).toBeNull();
  });

  it("a link to another application typed in the address bar: the banner in the displayed site's name", { timeout: 60_000 }, async () => {
    // The ressac-test: handler registered by the previous test stays known to this profile.
    const id = await open(await origin(), "none", {});
    // As the address bar does: a load with the system principal, no page behind it.
    await m.execute(`${browser(id)}.fixupAndLoadURIString("ressac-test:typed", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`);
    expect(await waitBanner((t) => t !== null)).toMatch(/^127\.0\.0\.1:\d+ veut ouvrir un lien dans une autre application : ressac-test:typed$/);
    await answer("Refuser");
    await waitBanner((t) => t === null);
  });

  it("DRM modules are requested from Mozilla under Firefox's version, not Ressac's", async () => {
    // Under the app's own version (0.1.0) Mozilla's update server offers no Widevine, so no DRM ever works.
    const url = await chrome<string>(`Services.prefs.clearUserPref("media.gmp-manager.url");
      const { GMPInstallManager } = ChromeUtils.importESModule("resource://gre/modules/GMPInstallManager.sys.mjs");
      return new GMPInstallManager()._getURL();`);
    expect(url).toContain(`/GMP/${await m.execute<string>("return Services.appinfo.platformVersion;")}/`);
  });

  it("fullscreen: granted without a question, without a Firefox warning on the page", { timeout: 60_000 }, async () => {
    const id = await open(await origin(), "fs", {});
    await clickGo(id);
    try {
      expect(await result(id)).toEqual({ ok: "full" });
      await new Promise((r) => setTimeout(r, 500));
      expect(await m.execute(`const w = document.getElementById("fullscreen-warning"); return !w || w.hidden || !w.hasAttribute("onscreen");`)).toBe(true);
      expect(await banner()).toBeNull();
    } finally {
      await chrome(`if (document.fullscreenElement) await document.exitFullscreen(); window.fullScreen = false;`);
    }
  });

  it("reading the clipboard: denied without a question, without Firefox's « Coller » menu", { timeout: 60_000 }, async () => {
    // Headless Firefox keeps its own in-memory clipboard: the machine's is not touched.
    await m.execute(`Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("from-elsewhere");`);
    const id = await open(await origin(), "clipr", {});
    await clickGo(id);
    expect(await result(id)).toEqual({ err: "NotAllowedError" });
    expect(await m.execute(`return document.getElementById("clipboardReadPasteMenuPopup")?.state ?? "closed";`)).toBe("closed");
    expect(await banner()).toBeNull();
  });

  it("a blocked popup shows no Firefox bar", { timeout: 60_000 }, async () => {
    // Marionette turns the popup blocker off: on again for this test, as for a person.
    await m.execute("Services.prefs.setBoolPref('dom.disable_open_during_load', true);");
    try {
      const id = await open(await origin(), "blocked");
      expect(await result(id)).toEqual({ ok: true });
      await new Promise((r) => setTimeout(r, 1000));
      expect(await m.execute(`return gBrowser.getNotificationBox(${browser(id)}).allNotifications.map((n) => n.getAttribute("value"));`)).toEqual([]);
    } finally {
      await m.execute("Services.prefs.setBoolPref('dom.disable_open_during_load', false);");
    }
  });
});
