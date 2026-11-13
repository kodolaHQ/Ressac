import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { Action } from "../shared/api";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { waitUi } from "./ui";

// Probes of plan 26's unknowns (docs/superpowers/notes/2026-11-05-permissions-sites-recherche.md, P1-P9). They print
// what they see rather than assert it: rerun them with RESSAC_SPIKE=1 after a Firefox version change and compare.
// No network, no real device: fake media, test geolocation provider, test MIDI ports, ClearKey, a web protocol handler.

const note = (what: string, v: unknown) => console.log(`[spike] ${what}: ${JSON.stringify(v)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- The pages ----------------------------------------------------------------------------------------------------

/** A short sine WAV, built in the page (autoplay probe). */
const WAV = `() => { const n = 8000, b = new DataView(new ArrayBuffer(44 + n * 2)); const s = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); b.setUint32(4, 36 + n * 2, true); s(8, "WAVEfmt "); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, 8000, true); b.setUint32(28, 16000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); s(36, "data"); b.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.sin(i / 3) * 8000, true); return URL.createObjectURL(new Blob([b], { type: "audio/wav" })); }`;

/** What `/p?do=<what>` runs: on a click of #go (a user gesture), or as it loads with `&auto`. */
const ACTIONS = `{
  none: async () => null,
  notif: () => Notification.requestPermission(),
  notif2: () => Promise.all([Notification.requestPermission(), Notification.requestPermission()]),
  geo: () => new Promise((ok) => navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), (e) => ok({ code: e.code, message: e.message }), { timeout: 20000 })),
  midi: async () => { const a = await navigator.requestMIDIAccess(); return { inputs: a.inputs.size, outputs: a.outputs.size, sysex: a.sysexEnabled }; },
  midisysex: async () => { const a = await navigator.requestMIDIAccess({ sysex: true }); return { inputs: a.inputs.size, outputs: a.outputs.size, sysex: a.sysexEnabled }; },
  persist: () => navigator.storage.persist(),
  xr: async () => ({ xr: typeof navigator.xr, getVRDisplays: typeof navigator.getVRDisplays, vr: navigator.getVRDisplays ? await navigator.getVRDisplays().then((d) => d.length, (e) => e.name) : null }),
  cam: () => gum({ video: true }),
  mic: () => gum({ audio: true }),
  both: () => gum({ video: true, audio: true }),
  both2: () => Promise.all([gum({ video: true, audio: true }), gum({ video: true, audio: true })]),
  screen: async () => { const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); const r = s.getTracks().map((t) => t.kind + ":" + t.label); s.getTracks().forEach((t) => t.stop()); return r; },
  drm: async () => {
    const a = await navigator.requestMediaKeySystemAccess("org.w3.clearkey", [
      { initDataTypes: ["webm"], videoCapabilities: [{ contentType: 'video/webm; codecs="vp8"' }] },
      { initDataTypes: ["cenc"], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] },
      { initDataTypes: ["keyids"], audioCapabilities: [{ contentType: 'audio/webm; codecs="opus"' }] },
    ]);
    const keys = await Promise.race([a.createMediaKeys().then((k) => !!k, (e) => e.name), new Promise((ok) => setTimeout(() => ok("createMediaKeys() pending after 5 s"), 5000))]);
    return { keySystem: a.keySystem, config: a.getConfiguration().initDataTypes, keys };
  },
  drm2: async () => Promise.all([ACTIONS.drm(), ACTIONS.drm()]),
  clipw: async () => (await navigator.clipboard.writeText("ressac-spike"), "written"),
  clipr: () => navigator.clipboard.readText(),
  fs: async () => (await document.documentElement.requestFullscreen(), !!document.fullscreenElement),
  autoplay: async () => { const a = new Audio((${WAV})()); const policy = navigator.getAutoplayPolicy?.("mediaelement") ?? "no getAutoplayPolicy"; const r = await Promise.race([a.play().then(() => "played"), new Promise((ok) => setTimeout(() => ok("play() still pending after 3 s"), 3000))]); a.pause(); return { policy, play: r }; },
  popup: async () => !!window.open("/p?do=none", "_blank"),
  proto: async () => { location.href = "ressac-spike:hello-from-page"; return "navigated"; },
  query: async () => {
    const out = { notification: Notification.permission };
    for (const name of ["notifications", "geolocation", "camera", "microphone", "midi", "persistent-storage", "storage-access", "xr"]) {
      try { out[name] = (await navigator.permissions.query({ name })).state; } catch (e) { out[name] = e.name; }
    }
    try { out["midi-sysex"] = (await navigator.permissions.query({ name: "midi", sysex: true })).state; } catch (e) { out["midi-sysex"] = e.name; }
    return out;
  },
  sa: async () => (await document.requestStorageAccess(), "granted"),
}`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>ready</title>
<button id="go" style="width:300px;height:120px">go</button><div id="frames"></div>
<script>
const gum = async (c) => { const s = await navigator.mediaDevices.getUserMedia(c); const r = s.getTracks().map((t) => t.kind + ":" + t.label); s.getTracks().forEach((t) => t.stop()); return r; };
const ACTIONS = ${ACTIONS};
const q = new URLSearchParams(location.search);
const done = (v) => { document.title = "done:" + JSON.stringify(v); if (parent !== window) parent.postMessage(document.title, "*"); };
const run = async () => { document.title = "pending"; try { done({ ok: await ACTIONS[q.get("do")]() }); } catch (e) { done({ err: e?.name ?? String(e), message: String(e?.message ?? e) }); } };
document.getElementById("go").onclick = run;
addEventListener("message", (e) => (document.title = "frame:" + e.data));
if (q.get("frame")) document.getElementById("frames").innerHTML = '<iframe allow="' + (q.get("allow") ?? "") + '" style="width:400px;height:200px" src="' + q.get("frame") + '"></iframe>';
if (q.has("auto")) run();
</script>`;

/** The probe pages: /p (see PAGE); /handled notes the web protocol handler's launch. `paths` lists every path asked. */
async function startPages(): Promise<{ url: string; port: number; paths: string[]; close(): Promise<void> }> {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    paths.push(u.pathname + u.search);
    if (u.pathname === "/p") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE);
    res.writeHead(200, { "Content-Type": "text/html" }).end(`<title>${u.pathname}</title>`);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, port, paths, close: () => new Promise((ok) => (server.close(() => ok()), server.closeAllConnections())) };
}

// --- Firefox side -------------------------------------------------------------------------------------------------

const PREFS = {
  // Test geolocation provider (network provider on a data: URL), never CoreLocation (a macOS prompt).
  "geo.provider.testing": true,
  "geo.provider.use_corelocation": false,
  "geo.provider.network.scan": false,
  "geo.provider.network.timeToWaitBeforeSending": 10,
  "geo.provider.network.url": 'data:application/json,{"location":{"lat":48.8566,"lng":2.3522},"accuracy":42}',
  // Fake camera and microphone (no OS permission asked for fakes, WebRTCParent.checkOSPermission).
  "media.navigator.streams.fake": true,
  // Test MIDI ports (TestMIDIPlatformService).
  "midi.testing": true,
  // DRM goes through a content permission request (MediaKeySystemAccessPermissionRequest).
  "media.eme.require-app-approval": true,
};

/**
 * The hooks under test, installed in the chrome: an Integration.contentPermission override, a wrap of
 * WebRTCParent.receiveMessage and of nsContentDispatchChooser.handleURI. Each logs what it receives in window.spike.log
 * and answers per window.spike.answer[<type>] ("allow", "cancel", "hold" = keep the request, "pass" = Firefox's own).
 * Requests from the invisible reads' browsers (messagemanagergroup ressac-reading) are always cancelled.
 */
const HOOKS = `
  if (window.spike) return "already";
  const spike = (window.spike = { log: [], held: [], answer: {} });
  const group = (el) => el?.getAttribute?.("messagemanagergroup") ?? null;
  const tabOf = (el) => { const g = el?.ownerDocument?.defaultView?.gBrowser; return g ? (g.getTabForBrowser(el)?.getAttribute("ressac-tab-id") ?? "no tab id") : "no gBrowser"; };
  const { Integration } = ChromeUtils.importESModule("resource://gre/modules/Integration.sys.mjs");
  spike.factory = (base) => ({
    __proto__: base,
    createPermissionPrompt(type, request) {
      const t = request.types.queryElementAt(0, Ci.nsIContentPermissionType);
      const options = [];
      for (let i = 0; i < t.options.length; i++) options.push(t.options.queryElementAt(i, Ci.nsISupportsString).data);
      const p = request.principal;
      const entry = {
        hook: "contentPermission", type, options, origin: p.origin, top: request.topLevelPrincipal?.origin ?? null,
        userContextId: p.originAttributes.userContextId, privateBrowsingId: p.originAttributes.privateBrowsingId,
        element: request.element?.localName ?? null, group: group(request.element), tab: tabOf(request.element),
        gesture: request.hasValidTransientUserGestureActivation, delegated: request.isRequestDelegatedToUnsafeThirdParty, window: !!request.window,
      };
      const answer = entry.group === "ressac-reading" ? "cancel" : (spike.answer[type] ?? "hold");
      entry.answer = answer;
      if (answer === "pass") { spike.log.push(entry); return base.createPermissionPrompt.call(this, type, request); }
      return {
        prompt() {
          spike.log.push(entry);
          if (answer === "allow") request.allow();
          else if (answer === "cancel") request.cancel();
          else spike.held.push({ entry, request });
        },
      };
    },
  });
  Integration.contentPermission.register(spike.factory);

  const { WebRTCParent } = ChromeUtils.importESModule("resource:///actors/WebRTCParent.sys.mjs");
  const receive = WebRTCParent.prototype.receiveMessage;
  WebRTCParent.prototype.receiveMessage = function (msg) {
    if (msg.name === "webrtc:CancelRequest") spike.log.push({ hook: "webrtc", cancel: msg.data });
    if (msg.name !== "webrtc:Request") return receive.call(this, msg);
    const d = msg.data;
    const el = this.browsingContext.top.embedderElement;
    const dev = (l) => l.map((x) => ({ deviceIndex: x.deviceIndex, mediaSource: x.mediaSource, osPrompt: x.canRequestOsLevelPrompt, scary: !!x.scary }));
    const entry = {
      hook: "webrtc", callID: d.callID, requestTypes: d.requestTypes, sharingScreen: d.sharingScreen, secure: d.secure, gesture: d.isHandlingUserInput,
      frame: this.manager.documentPrincipal.origin, top: this.manager.topWindowContext.documentPrincipal.origin, secondOrigin: d.secondOrigin ?? null,
      userContextId: this.manager.documentPrincipal.originAttributes.userContextId, group: group(el), tab: tabOf(el),
      video: dev(d.videoInputDevices), audio: dev(d.audioInputDevices),
    };
    const answer = entry.group === "ressac-reading" ? "deny" : (spike.answer[d.sharingScreen ? "screen" : "media"] ?? "hold");
    entry.answer = answer;
    spike.log.push(entry);
    if (answer === "pass") return receive.call(this, msg);
    if (answer === "deny") return this.denyRequest(d);
    if (answer === "hold") return void spike.held.push({ entry, actor: this, data: d });
    // Firefox's allow (WebRTCParent prompt's mainAction): first device of each kind, the one-shot camera grant, the OS check.
    const devices = [d.videoInputDevices[0]?.deviceIndex, d.audioInputDevices[0]?.deviceIndex].filter((x) => x !== undefined);
    if (d.videoInputDevices.length)
      Services.perms.addFromPrincipal(Services.scriptSecurityManager.createContentPrincipalFromOrigin(entry.top), "MediaManagerVideo", Services.perms.ALLOW_ACTION, Services.perms.EXPIRE_SESSION);
    this.checkOSPermission(!d.sharingScreen && d.videoInputDevices.length > 0, d.audioInputDevices.length > 0, d.sharingScreen).then((ok) =>
      ok ? this.sendAsyncMessage("webrtc:Allow", { callID: d.callID, windowID: d.windowID, devices }) : this.denyRequestNoPermission(d));
  };

  const { nsContentDispatchChooser } = ChromeUtils.importESModule("resource://gre/modules/ContentDispatchChooser.sys.mjs");
  const handle = nsContentDispatchChooser.prototype.handleURI;
  nsContentDispatchChooser.prototype.handleURI = async function (handler, uri, principal, bc, external, gesture) {
    const el = bc?.top?.embedderElement;
    const entry = { hook: "dispatch", scheme: handler.type, uri: uri.spec, origin: principal?.origin ?? null, userContextId: principal?.originAttributes?.userContextId ?? null,
      group: group(el), tab: tabOf(el), external, gesture, preferredAction: handler.preferredAction, alwaysAsk: handler.alwaysAskBeforeHandling };
    const answer = entry.group === "ressac-reading" ? "cancel" : (spike.answer.protocol ?? "cancel");
    entry.answer = answer;
    spike.log.push(entry);
    if (answer === "pass") return handle.apply(this, arguments);
    if (answer === "allow") handler.launchWithURI(uri, bc);
  };
  return "installed";`;

/** What Firefox shows of its own: prompts (PopupNotifications), the tab's notification bars and tab dialogs, other windows. */
const FIREFOX_UI = `
  const b = window.spikeBrowser ?? gBrowser.selectedBrowser;
  const box = gBrowser.readNotificationBox?.(b) ?? null;
  return {
    popupNotifications: PopupNotifications._currentNotifications.map((n) => n.id),
    panel: PopupNotifications.panel.state,
    bars: box ? [...box.allNotifications].map((n) => ({ value: n.getAttribute("value"), height: Math.round(n.getBoundingClientRect().height), visible: n.checkVisibility(), box: Math.round(box.stack?.getBoundingClientRect?.().height ?? -1) })) : [],
    tabDialogs: gBrowser.getTabDialogBox(b)._tabDialogManager._dialogs.length,
    windows: [...Services.wm.getEnumerator(null)].map((w) => w.document.documentURI.replace(/^chrome:\\/\\/browser\\/content\\//, "")),
  };`;

async function ready(m: Marionette): Promise<void> {
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  // The home page's agent session settles first: quitting during its start-up leaves writers in the data dir.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
}

const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
const chrome = <T = any>(m: Marionette, body: string, args: unknown[] = []) => m.execute<T>(`return (async () => { ${body} })();`, args);

let opened = 0;
/** Opens `url` (made unique: earlier tabs stay open) in a Ressac tab of the first window, waits until it is loaded; its browser is window.spikeBrowser. */
async function open(m: Marionette, page: string): Promise<void> {
  const url = `${page}${page.includes("?") ? "&" : "?"}k=${++opened}`;
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url });
  await waitFor(
    m,
    // The title, not isLoadingDocument: a page that plays a sound stays "loading".
    `const b = gBrowser.browsers.findLast((b) => b.currentURI.spec === ${JSON.stringify(url)} && b.contentTitle); if (b) window.spikeBrowser = b; return !!b;`,
    (v) => v === true,
  );
}

/** A trusted click (WebDriver actions: a user gesture) on #go of window.spikeBrowser's page, or of its first frame. */
async function clickGo(m: Marionette, inFrame = false): Promise<void> {
  const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
  const handle = await m.execute<string>(`return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(window.spikeBrowser);`);
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

/** The selected page's result: its title once it is "done:…" or "frame:done:…" (or what it is after `ms`). */
async function result(m: Marionette, ms = 15_000): Promise<unknown> {
  const deadline = Date.now() + ms;
  for (;;) {
    const t = await m.execute<string>("return window.spikeBrowser.contentTitle");
    const done = t.replace(/^frame:/, "");
    if (done.startsWith("done:")) return JSON.parse(done.slice(5));
    if (Date.now() > deadline) return { title: t };
    await sleep(100);
  }
}

/** Loads `/p?do=<what>` (plus `extra`), runs it on a click (or as it loads with `auto`), returns the page's result. */
async function run(m: Marionette, base: string, what: string, o: { auto?: boolean; extra?: string; frame?: boolean; ms?: number } = {}): Promise<unknown> {
  await open(m, `${base}/p?do=${what}${o.auto ? "&auto" : ""}${o.extra ?? ""}`);
  if (!o.auto) await clickGo(m, o.frame);
  return result(m, o.ms);
}

/** Navigates window.spikeBrowser itself (same tab) to `url` and waits for it. */
async function navigate(m: Marionette, url: string): Promise<void> {
  await m.execute("window.spikeBrowser.fixupAndLoadURIString(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });", [url]);
  await waitFor(m, `return window.spikeBrowser.currentURI.spec === ${JSON.stringify(url)} && !!window.spikeBrowser.contentTitle;`, (v) => v === true);
}

/** Closes window.spikeBrowser's Ressac tab. */
const closeTab = (m: Marionette) =>
  m.execute("return gBrowser.getTabForBrowser(window.spikeBrowser).getAttribute('ressac-tab-id');").then((id) => dispatch(m, { type: "closeTab", id: id as string }));

/** The hook log since `from`, and the requests held. */
const logSince = (m: Marionette, from: number) => chrome<any[]>(m, `return window.spike.log.slice(arguments[0]);`, [from]);
const logLength = (m: Marionette) => chrome<number>(m, "return window.spike.log.length;");
const setAnswers = (m: Marionette, a: Record<string, string>) => chrome(m, "Object.assign(window.spike.answer, arguments[0]);", [a]);
/** Answers every held request (`allow` or `cancel`/`deny`), returns what each answer threw. */
const release = (m: Marionette, how: "allow" | "cancel") =>
  chrome<string[]>(m, `
    const out = [];
    for (const h of window.spike.held.splice(0)) {
      try {
        if (h.request) arguments[0] === "allow" ? h.request.allow() : h.request.cancel();
        else if (arguments[0] === "allow") h.actor.sendAsyncMessage("webrtc:Allow", { callID: h.data.callID, windowID: h.data.windowID, devices: [h.data.videoInputDevices[0]?.deviceIndex, h.data.audioInputDevices[0]?.deviceIndex].filter((x) => x !== undefined) });
        else h.actor.denyRequest(h.data);
        out.push("ok");
      } catch (e) { out.push(String(e)); }
    }
    return out;`, [how]);
const firefoxUi = (m: Marionette) => chrome(m, FIREFOX_UI);

describe.skipIf(!process.env.RESSAC_SPIKE)("site permissions spike", () => {
  let pages: Awaited<ReturnType<typeof startPages>>;
  let other: Awaited<ReturnType<typeof startPages>>;
  let w: LaunchedRessac;
  let m: Marionette;
  beforeAll(async () => {
    pages = await startPages();
    other = await startPages();
    w = await launchRessac({ prefs: PREFS });
    m = w.marionette;
    await ready(m);
    note("hooks", await chrome(m, HOOKS));
  }, 90_000);
  afterAll(async () => {
    await w?.close();
    await Promise.all([pages?.close(), other?.close()]);
  });

  it("P1: Integration.contentPermission, the types it receives, allow and cancel without PopupNotifications", { timeout: 240_000 }, async () => {
    await setAnswers(m, { "desktop-notification": "allow", geolocation: "allow", midi: "allow", "persistent-storage": "cancel", "storage-access": "cancel", xr: "cancel" });
    for (const [label, what, o] of [
      ["notifications, click", "notif", {}],
      ["geolocation, click", "geo", {}],
      ["midi, click", "midi", {}],
      ["midi sysex, click", "midisysex", {}],
      ["persistent-storage, click", "persist", {}],
      ["xr", "xr", { auto: true }],
    ] as const) {
      const from = await logLength(m);
      const r = await run(m, pages.url, what, o);
      note(`P1 ${label}`, { page: r, hooks: await logSince(m, from) });
    }
    note("P1 query after allow() only (nothing written to Services.perms)", await run(m, pages.url, "query", { auto: true }));
    note("P1 Services.perms after allow()", await chrome(m, `return Services.perms.all.filter((p) => p.principal.origin.startsWith(arguments[0])).map((p) => [p.principal.origin, p.type, p.capability, p.expireType]);`, [pages.url]));

    // Without a gesture, on another origin (no decision there yet).
    for (const [label, what] of [["notifications, no gesture", "notif"], ["geolocation, no gesture", "geo"], ["midi, no gesture", "midi"]] as const) {
      const from = await logLength(m);
      const r = await run(m, other.url, what, { auto: true });
      note(`P1 ${label}`, { page: r, hooks: await logSince(m, from) });
    }

    // Two requests at once, held: how many reach the hook.
    await setAnswers(m, { "desktop-notification": "hold" });
    let from = await logLength(m);
    await open(m, `${other.url}/p?do=notif2&extra=1`);
    await clickGo(m);
    await sleep(1500);
    note("P1 two notification requests at once, held", { hooks: (await logSince(m, from)).map((e) => e.type), firefox: await firefoxUi(m) });
    note("P1 cancel() of the held ones", await release(m, "cancel"));
    note("P1 two requests: page", await result(m));

    // A held request whose page navigates away: does anything tell us, and what does allow() do then.
    await setAnswers(m, { geolocation: "hold" });
    from = await logLength(m);
    await open(m, `${other.url}/p?do=geo&nav=1`);
    await clickGo(m);
    await sleep(1000);
    const heldBefore = await chrome(m, "return window.spike.held.length;");
    await navigate(m, `${other.url}/p?do=none&after=1`);
    await sleep(1000);
    note("P1 held geolocation, then the tab navigates", {
      heldBefore, hooks: await logSince(m, from),
      requestAfter: await chrome(m, "const h = window.spike.held[0]; return { element: h?.request.element?.localName ?? null, sameBrowser: h?.request.element === window.spikeBrowser, wgp: !!window.spikeBrowser.browsingContext.currentWindowGlobal };"),
      allowAfter: await release(m, "allow"), firefox: await firefoxUi(m),
    });
    from = await logLength(m);
    await open(m, `${other.url}/p?do=geo&close=1`);
    await clickGo(m);
    await sleep(1000);
    await closeTab(m);
    await sleep(1000);
    note("P1 held geolocation, then the tab closes", { hooks: (await logSince(m, from)).map((e) => e.type), requestAfter: await chrome(m, "const h = window.spike.held[0]; try { return { element: h?.request.element ? (h.request.element.isConnected ? 'connected' : 'detached') : null }; } catch (e) { return { elementThrows: String(e).slice(0, 120) }; }"), allowAfter: await release(m, "allow") });
    await setAnswers(m, { geolocation: "allow", "desktop-notification": "allow" });

    // storage-access: a third-party frame (site2.localhost) asks on a click inside it.
    await chrome(m, `Cc["@mozilla.org/network/native-dns-override;1"].getService(Ci.nsINativeDNSResolverOverride).addIPOverride("site2.localhost", "127.0.0.1");`);
    from = await logLength(m);
    const frameUrl = `http://site2.localhost:${other.port}/p?do=sa`;
    const sa = await run(m, pages.url, "none", { extra: `&frame=${encodeURIComponent(frameUrl)}&allow=storage-access`, frame: true });
    note("P1 storage-access from a third-party frame", { page: sa, hooks: await logSince(m, from) });

    note("P1 Firefox UI after all", await firefoxUi(m));
    note(
      "P1 site permission add-ons",
      await chrome(m, `const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"); return (await AddonManager.getAddonsByTypes(["sitepermission"])).map((a) => a.id);`),
    );
    note("P1 prefs", await chrome(m, `return Object.fromEntries(["dom.sitepermsaddon-provider.enabled", "dom.webmidi.gated", "dom.webnotifications.requireuserinteraction", "permissions.desktop-notification.postPrompt.enabled"].map((k) => [k, Services.prefs.getBoolPref(k, null)]));`));
  });

  it("P2: camera and microphone through WebRTCParent, fake media", { timeout: 180_000 }, async () => {
    await setAnswers(m, { media: "allow" });
    for (const what of ["both", "cam", "mic"]) {
      const from = await logLength(m);
      const r = await run(m, pages.url, what, { auto: true });
      note(`P2 ${what}, allowed, no gesture`, { page: r, hooks: await logSince(m, from) });
    }
    note("P2 Firefox UI and windows after a grant", await firefoxUi(m));
    note("P2 Services.perms after our allow", await chrome(m, `return Services.perms.all.filter((p) => p.principal.origin.startsWith(arguments[0])).map((p) => [p.type, p.capability, p.expireType]);`, [pages.url]));
    note("P2 webrtcUI state", await chrome(m, `const { webrtcUI } = ChromeUtils.importESModule("resource:///modules/webrtcUI.sys.mjs"); return { streams: webrtcUI._streams.length, showGlobalIndicator: webrtcUI.showGlobalIndicator, sharing: gBrowser.selectedTab.getAttribute("sharing") };`));

    await setAnswers(m, { media: "deny" });
    let from = await logLength(m);
    note("P2 both, denied", { page: await run(m, other.url, "both", { auto: true }), hooks: await logSince(m, from) });

    // A frame of another origin asks (allow="camera; microphone").
    await setAnswers(m, { media: "allow" });
    from = await logLength(m);
    const frame = `${other.url}/p?do=both`;
    note("P2 frame of another origin", { page: await run(m, pages.url, "none", { extra: `&frame=${encodeURIComponent(frame)}&allow=camera;microphone`, frame: true }), hooks: await logSince(m, from) });

    // Two at once, held: does Firefox queue the second (MediaManager mPendingGUMRequest)?
    await setAnswers(m, { media: "hold" });
    from = await logLength(m);
    await open(m, `${other.url}/p?do=both2&auto`);
    await sleep(1500);
    note("P2 two at once, held", { hooks: (await logSince(m, from)).map((e) => e.callID ?? e.cancel) });
    note("P2 allow of the first", await release(m, "allow"));
    await sleep(1500);
    note("P2 after the first answer", { hooks: (await logSince(m, from)).map((e) => e.callID ?? e.cancel) });
    await release(m, "allow");
    note("P2 two at once: page", await result(m));

    // Held, then the tab navigates.
    from = await logLength(m);
    await open(m, `${other.url}/p?do=both&auto&nav=1`);
    await sleep(1000);
    await navigate(m, `${other.url}/p?do=none&after=2`);
    await sleep(1000);
    note("P2 held, then the tab navigates", { hooks: await logSince(m, from), allowAfter: await release(m, "allow") });
    from = await logLength(m);
    await open(m, `${other.url}/p?do=both&auto&close=1`);
    await sleep(1000);
    await closeTab(m);
    await sleep(1000);
    note("P2 held, then the tab closes", { hooks: await logSince(m, from), allowAfter: await release(m, "allow") });
    await setAnswers(m, { media: "allow" });
  });

  it("P3: screen sharing, default prefs (ScreenCaptureKit picker)", { timeout: 120_000 }, async () => {
    await setAnswers(m, { screen: "deny" });
    const from = await logLength(m);
    const r = await run(m, pages.url, "screen");
    note("P3 getDisplayMedia, picker pref default", { page: r, hooks: await logSince(m, from) });
    note("P3 macOS screen capture state (read only)", await chrome(m, `
      const os = Cc["@mozilla.org/ospermissionrequest;1"].getService(Ci.nsIOSPermissionRequest);
      const s = {}; os.getScreenCapturePermissionState(s);
      return { state: s.value, denied: os.PERMISSION_STATE_DENIED, authorized: os.PERMISSION_STATE_AUTHORIZED, picker: Services.prefs.getBoolPref("media.getdisplaymedia.screencapturekit.picker.enabled"), sck: Services.prefs.getBoolPref("media.getdisplaymedia.screencapturekit.enabled") };`));
  });

  it("P4: DRM: media.eme.require-app-approval, ClearKey, Widevine", { timeout: 120_000 }, async () => {
    await setAnswers(m, { "media-key-system-access": "pass" });
    let from = await logLength(m);
    note("P4 ClearKey, Firefox's own integration (pass)", { page: await run(m, pages.url, "drm", { auto: true }), hooks: await logSince(m, from), firefox: await firefoxUi(m) });
    await setAnswers(m, { "media-key-system-access": "allow" });
    from = await logLength(m);
    note("P4 ClearKey, allowed", { page: await run(m, pages.url, "drm", { auto: true, extra: "&n=2" }), hooks: await logSince(m, from) });
    from = await logLength(m);
    note("P4 ClearKey twice in one page, allowed", { page: await run(m, pages.url, "drm2", { auto: true }), hooks: await logSince(m, from) });
    await setAnswers(m, { "media-key-system-access": "cancel" });
    from = await logLength(m);
    note("P4 ClearKey, cancelled", { page: await run(m, other.url, "drm", { auto: true }), hooks: await logSince(m, from), firefox: await firefoxUi(m) });
    await sleep(12_000); // GMP_CHECK_DELAY is 10 s: what Firefox does on its own about Widevine.
    note("P4 GMP and prefs (no Widevine request made)", await chrome(m, `
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const plugins = (await AddonManager.getAddonsByTypes(["plugin"])).map((a) => ({ id: a.id, version: a.version, isActive: a.isActive, installed: !!a.installDate }));
      const p = (k) => { const t = Services.prefs.getPrefType(k); return t === 32 ? Services.prefs.getStringPref(k) : t === 64 ? Services.prefs.getIntPref(k) : t === 128 ? Services.prefs.getBoolPref(k) : null; };
      return { now: Math.round(Date.now() / 1000), plugins, prefs: Object.fromEntries(["media.eme.enabled", "media.gmp-widevinecdm.enabled", "media.gmp-widevinecdm.visible", "media.gmp-widevinecdm.version", "media.gmp-manager.lastCheck", "media.gmp-manager.url", "media.gmp-gmpopenh264.version", "media.gmp-provider.enabled"].map((k) => [k, p(k)])) };`));
  });

  it("P5: a link to another application (ContentDispatchChooser)", { timeout: 120_000 }, async () => {
    // A web handler for ressac-spike:, so Firefox knows an "application" for it (else NS_ERROR_UNKNOWN_PROTOCOL).
    note("P5 handler", await chrome(m, `
      const eps = Cc["@mozilla.org/uriloader/external-protocol-service;1"].getService(Ci.nsIExternalProtocolService);
      const before = eps.externalProtocolHandlerExists("ressac-spike");
      const info = eps.getProtocolHandlerInfo("ressac-spike");
      const app = Cc["@mozilla.org/uriloader/web-handler-app;1"].createInstance(Ci.nsIWebHandlerApp);
      app.name = "spike"; app.uriTemplate = arguments[0] + "/handled?u=%s";
      info.possibleApplicationHandlers.appendElement(app);
      info.preferredApplicationHandler = app; info.preferredAction = Ci.nsIHandlerInfo.useHelperApp; info.alwaysAskBeforeHandling = false;
      Cc["@mozilla.org/uriloader/handler-service;1"].getService(Ci.nsIHandlerService).store(info);
      return { before, after: eps.externalProtocolHandlerExists("ressac-spike") };`, [other.url]));
    for (const [answer, auto] of [["pass", false], ["cancel", false], ["allow", false], ["allow", true]] as const) {
      await setAnswers(m, { protocol: answer });
      const from = await logLength(m);
      other.paths.length = 0;
      const url = `${pages.url}/p?do=proto${auto ? "&auto" : ""}&a=${answer}`;
      if (!auto) {
        await open(m, url);
        await clickGo(m);
      } else {
        // The page leaves at once (to the handler's page): no load to wait for.
        await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url });
        await m.execute("window.spikeBrowser = gBrowser.selectedBrowser;");
      }
      await sleep(2000);
      const ui = await firefoxUi(m);
      note(`P5 ${answer}${auto ? ", no gesture" : ", click"}`, { hooks: await logSince(m, from), handled: other.paths.filter((p) => p.startsWith("/handled")), url: await m.execute("return window.spikeBrowser.currentURI.spec"), firefox: ui });
      // Firefox's own permission dialog (pass): closed before the next probe.
      await chrome(m, "for (const d of gBrowser.getTabDialogBox(window.spikeBrowser)._tabDialogManager._dialogs) d.close();");
    }
  });

  it("P6: Services.perms per container: what the page sees, removal by type", { timeout: 180_000 }, async () => {
    const TYPES = ["desktop-notification", "geo", "camera", "microphone", "midi", "midi-sysex", "persistent-storage", "storage-access", "xr"];
    const origin = `${other.url}`;
    await open(m, `${origin}/p?do=none&p6`);
    const uc = await m.execute<number>("return window.spikeBrowser.contentPrincipal.originAttributes.userContextId");
    note("P6 container of the first space's tab", { userContextId: uc, isolate: await m.execute("return Services.prefs.getBoolPref('permissions.isolateBy.userContext')") });
    note("P6 query before", await run(m, origin, "query", { auto: true }));
    await chrome(m, `
      const p = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(arguments[0]), { userContextId: arguments[1] });
      for (const t of arguments[2]) Services.perms.addFromPrincipal(p, t, Services.perms.ALLOW_ACTION);`, [origin, uc, TYPES]);
    note("P6 query after ALLOW in this container", await run(m, origin, "query", { auto: true, extra: "&n=2" }));
    await setAnswers(m, { media: "hold", geolocation: "hold", "desktop-notification": "hold", midi: "hold" });
    let from = await logLength(m);
    const asked = { geo: await run(m, origin, "geo", { auto: true, ms: 5000 }), notif: await run(m, origin, "notif", { auto: true, ms: 5000 }), both: await run(m, origin, "both", { auto: true, ms: 5000 }), midi: await run(m, origin, "midi", { auto: true, ms: 5000 }) };
    note("P6 requests with ALLOW in Services.perms (hooks held)", { page: asked, hooks: (await logSince(m, from)).map((e) => e.type ?? e.requestTypes) });
    await release(m, "cancel");

    // The same origin in a space of another profile (another container).
    const before = (await state(m)).spaces.map((e) => e.id);
    await dispatch(m, { type: "createSpace", name: "Autre", icon: "🧪", private: false, profile: "new", windowId: (await state(m)).windows[0]!.id } as Action);
    note("P6 new space", (await state(m)).spaces.filter((e) => !before.includes(e.id)).map((e) => e.profile));
    await open(m, `${origin}/p?do=none&p6b`);
    const uc2 = await m.execute<number>("return window.spikeBrowser.contentPrincipal.originAttributes.userContextId");
    note("P6 other container, isolateBy.userContext false (default)", { userContextId: uc2, query: await run(m, origin, "query", { auto: true, extra: "&n=3" }) });
    await m.execute("Services.prefs.getDefaultBranch('').setBoolPref('permissions.isolateBy.userContext', true)");
    note("P6 other container, isolateBy.userContext true at runtime", await run(m, origin, "query", { auto: true, extra: "&n=4" }));
    await dispatch(m, { type: "activateSpace", windowId: (await state(m)).windows[0]!.id, id: before[0]! } as Action);
    note("P6 first container again, isolateBy.userContext true", await run(m, origin, "query", { auto: true, extra: "&n=5" }));
    note("P6 Services.perms entries", await chrome(m, `return Services.perms.getAllByTypes(arguments[0]).map((p) => [p.principal.origin, p.type]);`, [TYPES]));

    // Removal by type, for every origin and container.
    await chrome(m, `
      const p = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(arguments[0]), { userContextId: arguments[1] });
      Services.perms.addFromPrincipal(p, "geo", Services.perms.ALLOW_ACTION);
      for (const t of arguments[2]) Services.perms.removeByType(t);`, [origin, uc2, TYPES]);
    note("P6 after removeByType", { left: await chrome(m, `return Services.perms.getAllByTypes(arguments[0]).length;`, [TYPES]), query: await run(m, origin, "query", { auto: true, extra: "&n=6" }) });
    from = await logLength(m);
    await setAnswers(m, { "desktop-notification": "cancel" });
    note("P6 asked again after removal", { page: await run(m, origin, "notif", { auto: true, extra: "&n=7" }), hooks: (await logSince(m, from)).map((e) => e.type) });
    await setAnswers(m, { media: "allow", geolocation: "allow", "desktop-notification": "allow", midi: "allow" });
  });

  it("P7: an invisible read's requests: how each hook recognises its browser", { timeout: 180_000 }, async () => {
    const STORE = "chrome://browser/content/ressac/store.sys.mjs";
    for (const what of ["notif", "geo", "both", "midi", "drm", "proto"]) {
      const from = await logLength(m);
      const r = await chrome(m, `
        const s = await ChromeUtils.importESModule("${STORE}").ready;
        try { const p = await s.readPage(arguments[0], { profile: null, localAddresses: true }); return { title: p.title }; } catch (e) { return { err: String(e?.message ?? e) }; }`, [`${pages.url}/p?do=${what}&auto&read`]);
      await sleep(2000);
      note(`P7 read ${what}`, { read: r, hooks: await logSince(m, from), firefox: await firefoxUi(m) });
    }
  });

  it("P8: popup blocker bar, fullscreen warning, autoplay, clipboard", { timeout: 180_000 }, async () => {
    // The popups' pages (/p?do=none) open as tabs or windows: count them, the selected tab may have moved.
    const popups = async () => (await sleep(1000), chrome(m, `return { tabs: gBrowser.browsers.filter((b) => b.currentURI.spec.endsWith("/p?do=none")).length, windows: [...Services.wm.getEnumerator("navigator:browser")].length, selected: gBrowser.selectedBrowser.currentURI.spec };`));
    // Marionette's recommended prefs turn the popup blocker off (dom.disable_open_during_load false): back on, as for a person.
    note("P8 dom.disable_open_during_load under Marionette", await m.execute("return [Services.prefs.getBoolPref('dom.disable_open_during_load'), Services.prefs.prefHasUserValue('dom.disable_open_during_load')]"));
    await m.execute("Services.prefs.setBoolPref('dom.disable_open_during_load', true)");
    note("P8 popup without a gesture", { page: await run(m, pages.url, "popup", { auto: true }), popups: await popups(), firefox: await firefoxUi(m), after3s: await sleep(2000).then(() => firefoxUi(m)), showBrowserMessage: await m.execute("return Services.prefs.getBoolPref('privacy.popups.showBrowserMessage')") });
    await m.execute("Services.prefs.setBoolPref('privacy.popups.showBrowserMessage', false)");
    note("P8 popup without a gesture, showBrowserMessage false", { page: await run(m, pages.url, "popup", { auto: true, extra: "&n=2" }), popups: await popups(), firefox: await firefoxUi(m) });
    await m.execute("Services.prefs.clearUserPref('privacy.popups.showBrowserMessage')");
    note("P8 popup on a click", { page: await run(m, pages.url, "popup"), popups: await popups(), firefox: await firefoxUi(m) });

    const fs = await run(m, pages.url, "fs");
    await sleep(500);
    note("P8 fullscreen on a click", {
      page: fs,
      chrome: await chrome(m, `const w = document.getElementById("fullscreen-warning"); return { fullScreen: window.fullScreen, inDOMFullscreen: document.documentElement.hasAttribute("inDOMFullscreen"), warning: w ? { hidden: w.hidden, onscreen: w.hasAttribute("onscreen"), height: Math.round(w.getBoundingClientRect().height) } : null };`),
      firefox: await firefoxUi(m),
    });
    await chrome(m, "if (document.fullscreenElement) await document.exitFullscreen(); window.fullScreen = false;");
    await sleep(1000);
    await m.execute("Services.prefs.setIntPref('full-screen-api.warning.timeout', 0)");
    const fs0 = await run(m, pages.url, "fs", { extra: "&n=2" });
    await sleep(500);
    note("P8 fullscreen on a click, full-screen-api.warning.timeout 0", {
      page: fs0,
      chrome: await chrome(m, `const w = document.getElementById("fullscreen-warning"); return { fullScreen: window.fullScreen, warning: w ? { hidden: w.hidden, onscreen: w.hasAttribute("onscreen"), height: Math.round(w.getBoundingClientRect().height) } : null };`),
    });
    await chrome(m, "if (document.fullscreenElement) await document.exitFullscreen(); window.fullScreen = false;");
    await m.execute("Services.prefs.clearUserPref('full-screen-api.warning.timeout')");

    note("P8 autoplay without a gesture, default", { page: await run(m, pages.url, "autoplay", { auto: true }), pref: await m.execute("return Services.prefs.getIntPref('media.autoplay.default')"), firefox: await firefoxUi(m),
      icons: await chrome(m, `return [...document.querySelectorAll("#blocked-permissions-container [showing], #permission-popup-container")].map((e) => e.id); `), navbar: await chrome(m, `const r = document.getElementById("nav-bar")?.getBoundingClientRect(); return r ? Math.round(r.height) : null;`) });
    await m.execute("Services.prefs.getDefaultBranch('').setIntPref('media.autoplay.default', 0)");
    note("P8 autoplay without a gesture, media.autoplay.default 0 (default branch)", { page: await run(m, pages.url, "autoplay", { auto: true, extra: "&n=2" }), userValue: await m.execute("return Services.prefs.prefHasUserValue('media.autoplay.default')") });

    note("P8 clipboard write, no gesture", { page: await run(m, pages.url, "clipw", { auto: true }), firefox: await firefoxUi(m) });
    note("P8 clipboard write, click", { page: await run(m, pages.url, "clipw"), firefox: await firefoxUi(m) });
    // Clipboard content from elsewhere (not this page): Firefox's paste confirmation.
    await m.execute(`Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("from-chrome");`);
    await open(m, `${pages.url}/p?do=clipr`);
    await clickGo(m);
    await sleep(1000);
    note("P8 clipboard read, click", {
      paste: await chrome(m, `const p = document.getElementById("clipboardReadPasteMenuPopup"); const s = p?.state ?? null; p?.hidePopup?.(); return s;`),
      page: await result(m, 3000),
      firefox: await firefoxUi(m),
    });
    // The paste confirmation is ClipboardContextMenu.confirmUserPaste (Prompter): answered "no" without its menu.
    await m.execute(`
      const { ClipboardContextMenu } = ChromeUtils.importESModule("resource://gre/modules/ClipboardContextMenu.sys.mjs");
      const { PromptUtils } = ChromeUtils.importESModule("resource://gre/modules/PromptUtils.sys.mjs");
      window.spikePaste = 0;
      ClipboardContextMenu.confirmUserPaste = () => (window.spikePaste++, Promise.resolve(PromptUtils.objectToPropBag({ ok: false })));`);
    await open(m, `${pages.url}/p?do=clipr&n=2`);
    await clickGo(m);
    note("P8 clipboard read, click, confirmUserPaste answered no", { page: await result(m, 3000), asked: await m.execute("return window.spikePaste"), paste: await chrome(m, `return document.getElementById("clipboardReadPasteMenuPopup")?.state ?? null;`) });
  });

  it("P9: a « Navigation » menu in #main-menubar from the window bundle", { timeout: 60_000 }, async () => {
    note("P9 menubar", await chrome(m, `
      const bar = document.getElementById("main-menubar");
      if (!bar) return { bar: null };
      const ids = [...bar.children].map((c) => c.id + (c.hidden ? " (hidden)" : ""));
      const menu = document.createXULElement("menu");
      menu.id = "ressac-spike-menu"; menu.setAttribute("label", "Navigation");
      const popup = document.createXULElement("menupopup");
      const item = document.createXULElement("menuitem");
      item.setAttribute("label", "Oublier les autorisations de ce site");
      let fired = 0;
      item.addEventListener("command", () => fired++);
      popup.append(item); menu.append(popup);
      bar.insertBefore(menu, document.getElementById("windowMenu"));
      item.doCommand();
      const r = { headless: Services.env.exists("MOZ_HEADLESS") || Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo).isHeadless, hiddenBar: bar.hidden, collapsed: bar.collapsed, nativeMenubar: Services.appinfo.OS === "Darwin", ids, after: [...bar.children].map((c) => c.id), fired, label: menu.label };
      menu.remove();
      return r;`));
  });

  it("P3b: screen sharing with the ScreenCaptureKit picker turned off (mirror once: a launch of its own)", { timeout: 120_000 }, async () => {
    const w2 = await launchRessac({ prefs: { ...PREFS, "media.getdisplaymedia.screencapturekit.picker.enabled": false } });
    try {
      const m2 = w2.marionette;
      await ready(m2);
      await chrome(m2, HOOKS);
      await setAnswers(m2, { screen: "deny" });
      const r = await run(m2, pages.url, "screen");
      const hooks = await logSince(m2, 0);
      // Counts by kind only: the window names are the person's open windows.
      const kinds = (l: any[] = []) => {
        const n: Record<string, number> = {};
        for (const d of l) n[`${d.mediaSource} osPrompt=${d.osPrompt} scary=${d.scary}`] = (n[`${d.mediaSource} osPrompt=${d.osPrompt} scary=${d.scary}`] ?? 0) + 1;
        return n;
      };
      note("P3b getDisplayMedia, picker off", { page: r, hooks: hooks.map((e) => ({ ...e, video: kinds(e.video) })) });
    } finally {
      await w2.close();
    }
  });
});
