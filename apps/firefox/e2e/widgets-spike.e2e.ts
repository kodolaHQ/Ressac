import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { readHome } from "../../../packages/kernel/src/home/read";
import { spacePaths } from "../../../packages/kernel/src/paths";
import type { Action } from "../shared/api";
import { dispatch, state, waitFor } from "./firefox";
import { FAKE_TOOLS, launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { inUi } from "./ui";

// Probes of plan "home page and widgets" (docs/superpowers/notes/2026-11-05-accueil-widgets-recherche.md, P1-P7). They
// print what they see rather than assert it: rerun with WEBAIOS_SPIKE=1 after a Firefox version change and compare.
// No product code: the protocol handler and the window actor live in this file, served from a temp folder.
//
// The widget document is loaded in a windowless browser's <browser> element (a content browsing context, the same
// mechanism as the invisible reads): every chrome:// document (the sidebar included) carries `frame-src chrome:`, so an
// <iframe> to the widget scheme is blocked there before the scheme is even consulted (P2).

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const SCHEME = "webaios-widget";
const note = (what: string, v: unknown) => console.log(`[spike] ${what}: ${JSON.stringify(v)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The widget display's CSP.
const CSP_WIDGET =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; require-trusted-types-for 'script'; trusted-types default";

/**
 * What `affichage.html` runs: origin, secure context, Trusted Types, WebRTC, what the actor left in the page world, a
 * postMessage to the embedding document, and one fetch the CSP must block. `bare=1` serves the same page without its
 * meta CSP (to show what enforces the CSP).
 */
const page = (base: string, withCsp: boolean) => `<!doctype html><meta charset="utf-8">
${withCsp ? `<meta http-equiv="Content-Security-Policy" content="${CSP_WIDGET}">` : ""}
<title>loading</title>
<p id="v">v=none</p><button id="go" style="width:120px;height:40px">go</button>
<script>
const q = new URLSearchParams(location.search);
const out = { href: location.href, origin: location.origin, secure: isSecureContext, crypto: typeof (crypto && crypto.subtle), tt: typeof trustedTypes, rtc: typeof RTCPeerConnection };
try { document.getElementById("v").innerHTML = "<b>x</b>"; out.innerHtml = "allowed"; } catch (e) { out.innerHtml = e.name; }
try { const p = trustedTypes.createPolicy("spike", { createHTML: (s) => s }); const el = document.createElement("i"); el.innerHTML = p.createHTML("<b>x</b>"); out.policy = "allowed"; } catch (e) { out.policy = e.name; }
out.actor = window.__spikeInfo || null;
out.exported = typeof window.__spikeFn;
out.v = q.get("v");
document.getElementById("v").textContent = "v=" + (q.get("v") || "none");
document.title = "done:" + JSON.stringify(out);
try { parent.postMessage({ from: "widget", href: location.href, origin: location.origin, v: q.get("v"), actor: window.__spikeInfo || null }, "*"); } catch (e) { window.__postErr = String(e); }
addEventListener("pointerdown", (e) => { window.__pointer = e.isTrusted; }, true);
fetch("${base}/ping").then(() => { window.__fetch = "loaded"; }, (e) => { window.__fetch = e.name; }).then(() => { out.fetch = window.__fetch; document.title = "done:" + JSON.stringify(out); });
</script>`;

/** A page that sets or echoes a cookie, asks for notifications, or frames a URL (P1/P7): its title is the read's answer. */
const cookiePage = `<!doctype html><meta charset="utf-8"><title>loading</title>
<script>
const q = new URLSearchParams(location.search);
if (q.get("frame")) { const f = document.createElement("iframe"); f.src = q.get("frame"); document.documentElement.append(f); }
if (q.get("set")) document.cookie = q.get("set");
if (q.get("notif")) Notification.requestPermission().then((p) => { document.title = "perm:" + p; }, (e) => { document.title = "perm-err:" + e.name; });
else document.title = "cookies:" + document.cookie;
</script>`;

/**
 * The window actor, as a resource:// module written by this probe. `matches` cannot select a custom scheme (P3), so it
 * is registered without one and filters on the document's URL; `allFrames` is needed once the widget is a frame.
 */
const ACTOR_PARENT = `// Spike parent module (never shipped). Its own file: the child side's base class does not exist here.
export class WidgetSpikeParent extends JSWindowActorParent {
  receiveMessage(m) {
    if (m.name !== "created") return;
    let store = { import: "not tried" };
    try {
      const mod = ChromeUtils.importESModule("${STORE}");
      store = { import: "ok", ready: typeof mod.ready };
      mod.ready.then(
        (s) => this.sendAsyncMessage("store", { ok: true, dataDir: s.dataDir, profils: s.state.profils.map((p) => p.id) }),
        (e) => this.sendAsyncMessage("store", { ok: false, err: String(e).slice(0, 200) }),
      );
    } catch (e) {
      store = { import: String(e).slice(0, 200) };
    }
    try {
      Services.prefs.setStringPref("webaios.spike.actor", JSON.stringify({ child: m.data, parent: store, top: this.manager && this.manager.documentPrincipal ? this.manager.documentPrincipal.origin : null }));
    } catch (e) {}
  }
}
`;

const ACTOR_CHILD = `// Spike child module (never shipped). Its own file: the parent side's base class does not exist here.
export class WidgetSpikeChild extends JSWindowActorChild {
  handleEvent(e) {
    const url = this.document ? this.document.documentURI : null;
    if (!url || !(url.startsWith("${SCHEME}:") || url.includes("actor=1"))) return;
    const out = { event: e.type, url, readyState: this.document.readyState };
    try {
      const win = this.contentWindow;
      const pageWin = win && win.wrappedJSObject;
      out.pageWin = typeof pageWin;
      out.exportFunction = typeof Cu.exportFunction;
      out.rtcBefore = typeof (pageWin && pageWin.RTCPeerConnection);
      try { delete pageWin.RTCPeerConnection; out.rtcAfter = typeof pageWin.RTCPeerConnection; } catch (err) { out.rtcErr = String(err).slice(0, 160); }
      try {
        Cu.exportFunction(function (v) { pageWin.__spikeFn = v; }, pageWin, { defineAs: "__spikeFn" });
        out.exported = typeof pageWin.__spikeFn;
      } catch (err) { out.exportErr = String(err).slice(0, 160); }
      try {
        pageWin.addEventListener("pointerdown", (ev) => { pageWin.__spikePointer = ev.isTrusted; }, true);
        out.pointerListener = true;
      } catch (err) { out.pointerErr = String(err).slice(0, 160); }
      try { out.storeInChild = typeof ChromeUtils.importESModule("${STORE}").ready; } catch (err) { out.storeInChild = String(err).slice(0, 160); }
      try { pageWin.__spikeInfo = JSON.stringify(out); } catch (err) { out.writeErr = String(err).slice(0, 160); }
    } catch (err) { out.err = String(err).slice(0, 200); }
    this.sendAsyncMessage("created", out);
  }
  receiveMessage(m) {
    if (m.name !== "store") return;
    try { this.contentWindow.wrappedJSObject.__spikeStore = JSON.stringify(m.data); } catch (e) {}
  }
}
`;

/**
 * The content host: a windowless browser (a remote <browser> in backgroundPageThumbs.xhtml), as the invisible reads
 * build it. Defines window.spikeOpen(url) (load, wait for contentTitle) and window.spikeClose().
 */
const HOST = `
  window.spikeClose = () => { try { window.spikeWindowless && window.spikeWindowless.close(); } catch (e) {} window.spikeWindowless = null; };
  window.spikeOpen = async (url) => {
    window.spikeClose();
    const flags = Ci.nsIWebBrowserChrome.CHROME_REMOTE_WINDOW | Ci.nsIWebBrowserChrome.CHROME_FISSION_WINDOW;
    const windowless = (window.spikeWindowless = Services.appShell.createWindowlessBrowser(true, flags));
    await new Promise((ok) => {
      const progress = windowless.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIWebProgress);
      const listener = { QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener", "nsISupportsWeakReference"]),
        onStateChange(_p, request, state) {
          if (!request || !(state & Ci.nsIWebProgressListener.STATE_STOP) || !(state & Ci.nsIWebProgressListener.STATE_IS_NETWORK)) return;
          progress.removeProgressListener(listener);
          ok();
        } };
      progress.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_STATE_ALL);
      windowless.loadURI(Services.io.newURI("chrome://global/content/backgroundPageThumbs.xhtml"), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    });
    const doc = windowless.document;
    const browser = (window.spikeBrowserEl = doc.createXULElement("browser"));
    for (const [k, v] of Object.entries({ type: "content", remote: "true", maychangeremoteness: "true", disableglobalhistory: "true", manualactiveness: "true" })) browser.setAttribute(k, v);
    browser.style.width = "800px";
    browser.style.height = "600px";
    doc.documentElement.appendChild(browser);
    for (let i = 0; i < 300 && !browser.browsingContext.currentWindowGlobal; i++) await new Promise((r) => setTimeout(r, 10));
    browser.docShellIsActive = true;
    browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    for (let i = 0; i < 120 && (!browser.contentTitle || browser.contentTitle === "loading"); i++) await new Promise((r) => setTimeout(r, 100));
    return { url: browser.currentURI.spec, title: browser.contentTitle, remote: browser.isRemoteBrowser };
  };
  window.spikeLoad = async (url) => {
    const browser = window.spikeBrowserEl;
    const before = browser.contentTitle;
    browser.loadURI(Services.io.newURI(url), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    for (let i = 0; i < 100 && browser.contentTitle === before; i++) await new Promise((r) => setTimeout(r, 100));
    return { url: browser.currentURI.spec, title: browser.contentTitle };
  };
`;

/** An HTTP page the widget must not reach (connect-src 'none'), and the cookie/P7 pages. */
async function startPages(): Promise<{ url: string; paths: string[]; close(): Promise<void> }> {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    paths.push(u.pathname + u.search);
    // `page=1` serves the widget page over http (same HTML, same CSP): a content document the probe can load remotely.
    const html = u.pathname === "/p" ? (u.searchParams.has("page") ? page(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, !u.searchParams.has("bare")) : cookiePage) : "<title>ping</title>";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, paths, close: () => new Promise((ok) => (server.close(() => ok()), server.closeAllConnections())) };
}

const chrome = <T = any>(m: Marionette, body: string, args: unknown[] = []) => m.execute<T>(`return (async () => { ${body} })();`, args);

/** Loads `url` in the content host (a remote <browser>): title, URL, postMessages. */
const openWidget = (m: Marionette, url: string) => chrome<{ url: string; title: string; remote: boolean }>(m, "return await window.spikeOpen(arguments[0]);", [url]);

/** `done:<JSON>` from a page title. */
const done = (title: string | null | undefined) => {
  try {
    return title?.startsWith("done:") ? JSON.parse(title.slice(5)) : { title };
  } catch {
    return { title };
  }
};

/** The last console messages about our scheme or a CSP (what a blocked frame leaves behind). */
const consoleSince = (m: Marionette, from: number) =>
  chrome<any[]>(
    m,
    `return Services.console.getMessageArray().slice(arguments[0]).map((e) => String(e.message || e)).filter((t) => /webaios-widget|Content Security Policy|CSP/i.test(t)).slice(-8);`,
    [from],
  );

describe.skipIf(!process.env.WEBAIOS_SPIKE)("widget home spike", () => {
  let pages: Awaited<ReturnType<typeof startPages>>;
  let w: LaunchedWebAiOs;
  let m: Marionette;
  let tmp: string;
  let notifications: string;

  beforeAll(async () => {
    pages = await startPages();
    tmp = await mkdtemp(path.join(os.tmpdir(), "webaios-spike-widgets-"));
    notifications = path.join(tmp, "notifications.jsonl");
    await writeFile(path.join(tmp, "spike-parent.sys.mjs"), ACTOR_PARENT);
    await writeFile(path.join(tmp, "spike-child.sys.mjs"), ACTOR_CHILD);
    w = await launchWebAiOs({ env: { WEBAIOS_TEST_NOTIFICATIONS: notifications, WEBAIOS_HOST_TEST: "1" } });
    m = w.marionette;
    await m.setContext("chrome");
    await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
    await chrome(m, HOST);

    // P1: the scheme, registered at runtime from the parent (nsIIOService.registerProtocolHandler).
    note(
      "P1 protocol",
      await chrome(
        m,
        `
        const S = (window.spikeWidget = { served: [], handler: null });
        const parse = (s) => { try { const x = Services.io.newURI(s); return { spec: x.spec, scheme: x.scheme, host: (() => { try { return x.host; } catch (e) { return null; } })(), path: x.pathQueryRef }; } catch (e) { return { err: String(e).slice(0, 120) }; } };
        const before = parse("${SCHEME}://demo/affichage.html?v=1");
        const html = arguments[0], bare = arguments[1];
        const handler = {
          scheme: "${SCHEME}",
          allowPort: () => false,
          newChannel(uri, loadInfo) {
            S.served.push(uri.spec);
            let u;
            try { u = new URL(uri.spec); } catch (e) { throw Components.Exception("spike: bad url", Cr.NS_ERROR_MALFORMED_URI); }
            if (u.pathname !== "/affichage.html") throw Components.Exception("spike: nothing at " + u.pathname, Cr.NS_ERROR_FILE_NOT_FOUND);
            const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(Ci.nsIStringInputStream);
            stream.setUTF8Data(u.searchParams.get("bare") ? bare : html);
            const ch = Cc["@mozilla.org/network/input-stream-channel;1"].createInstance(Ci.nsIInputStreamChannel).QueryInterface(Ci.nsIChannel);
            ch.setURI(uri);
            if (loadInfo) ch.loadInfo = loadInfo;
            ch.contentType = "text/html";
            ch.contentCharset = "utf-8";
            ch.contentStream = stream;
            return ch;
          },
          QueryInterface: ChromeUtils.generateQI(["nsIProtocolHandler"]),
        };
        let registered;
        try {
          Services.io.registerProtocolHandler("${SCHEME}", handler, Ci.nsIProtocolHandler.URI_STD | Ci.nsIProtocolHandler.URI_IS_POTENTIALLY_TRUSTWORTHY | Ci.nsIProtocolHandler.URI_DANGEROUS_TO_LOAD | Ci.nsIProtocolHandler.URI_NON_PERSISTABLE, -1);
          registered = "ok";
        } catch (e) { registered = String(e).slice(0, 200); }
        S.handler = handler;
        const httpChannelInJs = (() => { try { const o = { QueryInterface: ChromeUtils.generateQI(["nsIHttpChannel"]) }; return o.QueryInterface(Ci.nsIHttpChannel) ? "generateQI answers yes (nsIHttpChannel is [builtinclass]: no JS implementation, so no response header)" : "no"; } catch (e) { return String(e).slice(0, 160); } })();
        return { registered, httpChannelInJs, before, after: parse("${SCHEME}://demo/affichage.html?v=1") };
        `,
        [page(pages.url, true), page(pages.url, false)],
      ),
    );

    // P3: the actor, served from a resource:// substitution (a temp folder; no build). What `matches` can select.
    note(
      "P3 registration",
      await chrome(
        m,
        `
        const dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        dir.initWithPath(arguments[0]);
        Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler).setSubstitution("webaios-spike", Services.io.newFileURI(dir));
        const uriParent = "resource://webaios-spike/spike-parent.sys.mjs";
        const uriChild = "resource://webaios-spike/spike-child.sys.mjs";
        let imported;
        try { const a = ChromeUtils.importESModule(uriParent); const b = ChromeUtils.importESModule(uriChild); imported = { parent: typeof a.WidgetSpikeParent, child: typeof b.WidgetSpikeChild }; } catch (e) { imported = { err: String(e).slice(0, 200) }; }
        const patterns = {};
        for (const p of ["${SCHEME}://*/*", "${SCHEME}:*", "${SCHEME}://*/affichage.html", "<all_urls>"]) {
          try { patterns[p] = new MatchPattern(p, { restrictSchemes: false }).matches("${SCHEME}://demo/affichage.html?v=1"); } catch (e) { patterns[p] = String(e).slice(0, 120); }
        }
        let registered;
        try {
          ChromeUtils.registerWindowActor("WebAiOsWidgetSpike", { parent: { esModuleURI: uriParent }, child: { esModuleURI: uriChild, events: { DOMWindowCreated: {} } }, allFrames: true, includeChrome: true, safeForUntrustedWebProcess: true });
          registered = "ok (no matches: the child filters on the URL)";
        } catch (e) { registered = String(e).slice(0, 200); }
        return { imported, patterns, registered };
        `,
        [tmp],
      ),
    );
  }, 150_000);

  afterAll(async () => {
    try {
      await chrome(m, "try { window.spikeClose(); } catch (e) {} try { ChromeUtils.unregisterWindowActor('WebAiOsWidgetSpike'); } catch (e) {} try { Services.io.unregisterProtocolHandler('webaios-widget'); } catch (e) {}");
    } catch {
      // the app may be gone already
    }
    await w?.close().catch(() => {});
    await pages?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("P1: webaios-widget: registered from chrome, served by an InputStreamChannel, the CSP, Trusted Types, WebRTC", { timeout: 120_000 }, async () => {
    // The scheme's own document: the channel is created, but a remote content document does not commit (P2).
    const scheme = await openWidget(m, `${SCHEME}://demo/affichage.html?v=1`);
    note("P1 the widget document itself", scheme);

    // The same HTML served over http (same meta CSP): the page reports origin, Trusted Types and its blocked fetch.
    const withMeta = await openWidget(m, `${pages.url}/p?page=1`);
    note("P1 the page's meta CSP at work (served over http)", { ...withMeta, page: done(withMeta.title) });

    const bare = await openWidget(m, `${pages.url}/p?page=1&bare=1`);
    note("P1 the same page without any CSP", { ...bare, page: done(bare.title) });

    const missing = await openWidget(m, `${SCHEME}://demo/other.html`);
    note("P1 another path (404)", missing);

    // The product flags (URI_DANGEROUS_TO_LOAD) refuse a frame from another document: the earlier run showed
    // "Security Error: Content at … may not load or link to webaios-widget://…" (a page framing it crashed the probe's
    // windowless host here, so it is not repeated).
    note(
      "P1 probe flag",
      await chrome(
        m,
        `
        // Probe only, and it stays active for P2/P3 (they run after this probe): P2's served count is measured under
        // URI_LOADABLE_BY_ANYONE, not under the product flags. Never in product code.
        Services.io.unregisterProtocolHandler("${SCHEME}");
        try {
          Services.io.registerProtocolHandler("${SCHEME}", window.spikeWidget.handler, Ci.nsIProtocolHandler.URI_STD | Ci.nsIProtocolHandler.URI_IS_POTENTIALLY_TRUSTWORTHY | Ci.nsIProtocolHandler.URI_LOADABLE_BY_ANYONE | Ci.nsIProtocolHandler.URI_NON_PERSISTABLE, -1);
          return "re-registered with URI_LOADABLE_BY_ANYONE (probe only)";
        } catch (e) { return String(e).slice(0, 160); }`,
      ),
    );
    note("P1 served URLs", await chrome(m, "return window.spikeWidget.served.slice(-6);"));
  });

  it("P2: an iframe in the sidebar (its CSP blocks it); then the widget as a content document: origin, postMessage, ?v", { timeout: 120_000 }, async () => {
    const sidebar = await inUi<{ url: string | null; title: string | null; served: number }>(
      m,
      `
      const f = doc.createElement("iframe");
      f.id = "spike-sidebar-widget";
      f.setAttribute("sandbox", "allow-scripts");
      f.style.cssText = "position:fixed;left:0;top:0;width:320px;height:200px;z-index:99999;background:#fff";
      f.src = "${SCHEME}://demo/affichage.html?v=21";
      doc.body.append(f);
      await new Promise((r) => setTimeout(r, 1200));
      const out = { url: f.contentDocument && f.contentDocument.URL, title: f.contentDocument && f.contentDocument.title, served: window.spikeWidget.served.length };
      f.remove();
      return out;`,
    );
    note("P2 sidebar iframe (sidebar.html CSP: default-src chrome:)", { ...sidebar, page: done(sidebar.title) });
    note("P2 console after the sidebar frame", await consoleSince(m, 0));

    // A chrome:// iframe in the same sidebar loads: an iframe there works, only the scheme is refused.
    const control = await inUi<{ url: string | null; title: string | null }>(
      m,
      `
      const f = doc.createElement("iframe");
      f.id = "spike-sidebar-chrome";
      f.style.cssText = "position:fixed;left:0;top:0;width:320px;height:200px;z-index:99999";
      f.src = "chrome://global/content/aboutSupport.xhtml";
      doc.body.append(f);
      await new Promise((r) => setTimeout(r, 1200));
      const out = { url: f.contentDocument && f.contentDocument.URL, title: f.contentDocument && f.contentDocument.title };
      f.remove();
      return out;`,
    );
    note("P2 sidebar iframe control (a chrome:// page)", control);

    // The widget document itself cannot be committed by a remote content process (the runtime scheme is unknown to it).
    const scheme = await openWidget(m, `${SCHEME}://demo/affichage.html?v=22`);
    note("P2 the scheme in a remote content document", scheme);

    // The same page over http (a content document): origin, postMessage, and a new ?v URL reloading.
    const loaded = await openWidget(m, `${pages.url}/p?page=1&v=22`);
    note("P2 the widget page in a content document (http proxy)", { ...loaded, page: done(loaded.title) });

    const reload = await chrome<{ url: string; title: string }>(m, "return await window.spikeLoad(arguments[0]);", [`${pages.url}/p?page=1&v=23`]);
    note("P2 ?v reload (a distinct URL)", { ...reload, page: done(reload.title) });
  });

  it("P3: the window actor on a widget document: pre-script guard, Trusted Types, WebRTC, the store", { timeout: 120_000 }, async () => {
    // The scheme's own document does not commit remotely; the same page over http exercises the actor (URL filter actor=1).
    const r = await openWidget(m, `${pages.url}/p?page=1&actor=1`);
    await sleep(800);
    const actor = await chrome(m, `try { return JSON.parse(Services.prefs.getStringPref("webaios.spike.actor")); } catch (e) { return String(e).slice(0, 160); }`);
    const diag = await chrome(m, `
      const wg = window.spikeBrowserEl.browsingContext.currentWindowGlobal;
      let parentActor;
      try { parentActor = !!wg.getActor("WebAiOsWidgetSpike"); } catch (e) { parentActor = String(e).slice(0, 240); }
      return { parentActor, console: Services.console.getMessageArray().slice(-8).map((e) => String(e.message || e)).filter((t) => /actor|resource|spike/i.test(t)) };`);
    note("P3 actor", { load: { url: r.url, remote: r.remote }, page: done(r.title), actor, diag });

    // isTrusted does not need the actor: a trusted synthetic click into a sandboxed subframe of the sidebar, the same
    // route a real pointer takes. (Measured in a chrome:// subframe: the widget frame itself needs the CSP change.)
    const pointer = await inUi<{ seen: unknown[]; err?: string }>(
      m,
      `
      const f = doc.createElement("iframe");
      f.id = "spike-pointer"; f.setAttribute("sandbox", "allow-scripts");
      f.style.cssText = "position:fixed;left:0;top:0;width:320px;height:200px;z-index:99999;background:#fff";
      f.src = "chrome://global/content/aboutSupport.xhtml";
      doc.body.append(f);
      await new Promise((r) => setTimeout(r, 1200));
      const seen = [];
      try {
        f.contentWindow.addEventListener("pointerdown", (e) => seen.push({ type: e.type, isTrusted: e.isTrusted }), true);
        f.contentWindow.addEventListener("mousedown", (e) => seen.push({ type: e.type, isTrusted: e.isTrusted }), true);
      } catch (e) { return { seen, err: String(e).slice(0, 200) }; }
      const r = f.getBoundingClientRect();
      for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, r.left + 20, r.top + 20, { button: 0, clickCount: 1 });
      await new Promise((r2) => setTimeout(r2, 600));
      const out = { seen };
      f.remove();
      return out;`,
    );
    note("P3 pointerdown isTrusted in a sandboxed subframe of the sidebar", pointer);
  });

  it("P4: Cc alerts-service in headless (system backend then the XUL fallback), and the test-file path", { timeout: 120_000 }, async () => {
    const alerts = await chrome(
      m,
      `
      const service = () => Cc["@mozilla.org/alerts-service;1"].getService(Ci.nsIAlertsService);
      const show = async () => {
        const n = Cc["@mozilla.org/alert-notification;1"].createInstance(Ci.nsIAlertNotification);
        n.init("webaios-spike", "", "Spike", "nothing visible", false, "cookie-spike");
        const seen = [];
        const obs = { observe: (s, topic) => seen.push(topic), QueryInterface: ChromeUtils.generateQI(["nsIObserver"]) };
        let err = null;
        try { service().showAlert(n, obs); } catch (e) { err = String(e).slice(0, 200); }
        await new Promise((r) => setTimeout(r, 800));
        const wins = [...Services.wm.getEnumerator(null)].map((x) => x.document.documentURI.split("/").pop());
        try { service().closeAlert("webaios-spike"); } catch (e) {}
        return { err, seen, wins };
      };
      const backend = (() => { try { Cc["@mozilla.org/system-alerts-service;1"].getService(Ci.nsIAlertsService); return "present"; } catch (e) { return String(e).slice(0, 120); } })();
      const headless = Services.env.exists("MOZ_HEADLESS");
      const prefDefault = Services.prefs.getBoolPref("alerts.useSystemBackend");
      const system = await show();
      Services.prefs.setBoolPref("alerts.useSystemBackend", false);
      const xul = await show();
      Services.prefs.clearUserPref("alerts.useSystemBackend");
      return { headless, prefDefault, backend, system, xul, after: Services.prefs.getBoolPref("alerts.useSystemBackend") };`,
    );
    note("P4 alerts service", alerts);
    note("P4 test file", { path: notifications, exists: await readFile(notifications, "utf8").then(() => true, () => false) });
    // The e2e path is the host writing the file (task 4): launchWebAiOs passes WEBAIOS_TEST_NOTIFICATIONS to the app.
    await writeFile(notifications, JSON.stringify({ titre: "spike", texte: "P4" }) + "\n", { flag: "a" });
    note("P4 test file after one write", { lines: (await readFile(notifications, "utf8")).trim().split("\n").length });
  });

  it("P5: srcdoc in the sidebar (the CSP it inherits)", { timeout: 120_000 }, async () => {
    const inSidebar = await inUi<{ url: string | null; title: string | null; origin: string; principal: unknown }>(
      m,
      `
      const f = doc.createElement("iframe");
      f.id = "spike-srcdoc"; f.setAttribute("sandbox", "allow-scripts");
      f.style.cssText = "position:fixed;left:0;top:0;width:330px;height:210px;z-index:99999;background:#fff";
      f.srcdoc = arguments[0];
      doc.body.append(f);
      await new Promise((r2) => setTimeout(r2, 1200));
      const out = { url: f.contentDocument && f.contentDocument.URL, title: f.contentDocument && f.contentDocument.title };
      try { out.origin = f.contentWindow.location.origin; } catch (e) { out.origin = String(e).slice(0, 80); }
      try { out.principal = { system: f.contentDocument.nodePrincipal.isSystemPrincipal, origin: f.contentDocument.nodePrincipal.origin }; } catch (e) { out.principal = String(e).slice(0, 80); }
      f.remove();
      return out;`,
      [page(pages.url, true)],
    );
    note("P5 srcdoc in the sidebar (sidebar CSP inherited)", { ...inSidebar, page: done(inSidebar.title) });
  });

  it("P6: the host's folders (espace/accueil, <dataDir>/widgets), read by the shared kernel, symlinks kept inside", { timeout: 120_000 }, async () => {
    const root = path.join(w.dataDir, "espace");
    const home = path.join(root, "accueil");
    const widgets = path.join(home, "widgets");
    const data = path.join(w.dataDir, "widgets");
    const declaration = { nom: "Démo", tailles: { min: { l: 3, h: 2 }, max: { l: 6, h: 4 }, defaut: { l: 3, h: 2 } }, sources: { compte: [], publiques: [], web: false } };
    await mkdir(path.join(widgets, "demo"), { recursive: true });
    await writeFile(path.join(widgets, "demo", "widget.json"), JSON.stringify(declaration));
    await writeFile(path.join(widgets, "demo", "affichage.html"), "<!doctype html><title>démo</title>");
    await writeFile(path.join(widgets, "demo", "exemple.json"), JSON.stringify({ ok: true }));
    await mkdir(path.join(data, "demo"), { recursive: true });
    await writeFile(path.join(data, "demo", "donnees.json"), JSON.stringify({ n: 1 }));
    await writeFile(path.join(data, "demo", "etat.json"), JSON.stringify({ statut: "ok", derniereMaj: null, derniereTentative: null }));
    await writeFile(path.join(home, "disposition.json"), JSON.stringify({ version: 2, widgets: [{ id: "demo", x: 0, y: 0, l: 3, h: 2 }] }));
    await writeFile(path.join(home, "theme.json"), JSON.stringify({ version: 1, fond: "#101014", rayon: 6 }));

    const paths = spacePaths(root);
    const state = await readHome(paths, data);
    note("P6 lireAccueil", {
      cheminWidgets: paths.widgets,
      dossierDonnees: data,
      widgets: state.widgets.map((x) => ("erreur" in x ? { id: x.id, erreur: x.erreur } : { id: x.id, nom: x.declaration.nom, aAffichage: x.aAffichage, donnees: x.donnees, aRecolte: x.aRecolte })),
      disposition: state.disposition,
      themeExists: await readFile(path.join(home, "theme.json"), "utf8").then(() => true, () => false),
      folder: { widgets: await readdir(widgets), donnees: await readdir(data) },
    });

    await mkdir(path.join(widgets, "fuite"));
    await symlink("/etc/hosts", path.join(widgets, "fuite", "widget.json"));
    await mkdir(path.join(widgets, "fuite-affichage"));
    await writeFile(path.join(widgets, "fuite-affichage", "widget.json"), JSON.stringify(declaration));
    await symlink("/etc/hosts", path.join(widgets, "fuite-affichage", "affichage.html"));
    const after = await readHome(paths, data);
    const folder = await realpath(path.join(widgets, "fuite-affichage"));
    const display = await realpath(path.join(widgets, "fuite-affichage", "affichage.html")).catch((e) => String(e));
    note("P6 confinement", {
      symlinkedJson: after.widgets.find((x) => x.id === "fuite"),
      symlinkedAffichage: { dossier: folder, reel: display, allowed: String(display).startsWith(folder + path.sep) },
    });

    note(
      "P6 host",
      await chrome(
        m,
        `
        const s = await ChromeUtils.importESModule("${STORE}").ready;
        return { dataDir: s.dataDir, pid: s.agent.pid, hostStarted: s.agent.pid !== null, profils: s.state.profils.map((p) => p.id) };`,
      ),
    );
    const tree = async (dir: string) => readdir(dir).catch(() => []);
    note("P6 host files", {
      espace: await tree(path.join(root, ".webaios")),
      profils: await tree(path.join(root, ".webaios", "profils")),
      historique: await readFile(path.join(w.dataDir, "historique.sqlite"), "utf8").then(() => true, () => false),
    });
  });

  it("P7: an invisible read with a profile's container, without a permission banner; the Docker atelier", { timeout: 180_000 }, async () => {
    const before = (await state(m)).espaces.map((e) => e.id);
    await dispatch(m, { type: "creerEspace", nom: "Spike", icone: "🧪", prive: false, profil: "nouveau", fenetreId: (await state(m)).fenetres[0]!.id });
    const space = (await state(m)).espaces.filter((e) => !before.includes(e.id));
    const profile = space[0]?.profil;
    const uc = await chrome(m, `return (await ChromeUtils.importESModule("${STORE}").ready).containerFor(arguments[0]);`, [profile]);
    note("P7 profile", { profil: profile, userContextId: uc });

    // A cookie set in the profile's space: the invisible read with that profile must see it, a public read must not.
    await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url: `${pages.url}/p?set=${encodeURIComponent(`spike=${profile}`)}`, espaceId: space[0]!.id, activer: true } as Action);
    await sleep(1500);
    const read = (url: string, o: unknown) =>
      chrome<{ titre?: string; err?: string }>(m, `
        const s = await ChromeUtils.importESModule("${STORE}").ready;
        try { const p = await s.readPage(arguments[0], arguments[1]); return { titre: p.titre }; } catch (e) { return { err: String(e && e.message || e).slice(0, 200) }; }`, [url, o]);
    note("P7 invisible read, same profile", await read(`${pages.url}/p`, { profil: profile, adressesLocales: true }));
    note("P7 invisible read, public container", await read(`${pages.url}/p`, { profil: null, adressesLocales: true }));
    note("P7 permission request in a read, and the banner", {
      page: await read(`${pages.url}/p?notif=1`, { profil: profile, adressesLocales: true }),
      banner: await chrome(m, `
        const b = gBrowser.selectedBrowser;
        const box = gBrowser.getNotificationBox ? gBrowser.getNotificationBox(b) : null;
        return { popup: PopupNotifications._currentNotifications.map((n) => n.id), bars: box ? [...box.allNotifications].length : null };`),
    });

    const fakeDocker = (() => {
      const env = { ...process.env, PATH: `${FAKE_TOOLS}${path.delimiter}${process.env.PATH ?? ""}`, WEBAIOS_RACINE: path.join(w.dataDir, "espace") };
      try {
        return { ok: true, out: execFileSync("docker", ["inspect", "webaios-atelier-firefox"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().slice(0, 120) };
      } catch (e: any) {
        return { ok: false, err: String(e.stdout || e.message).slice(0, 200) };
      }
    })();
    // The starting widgets' scheduled harvests run in the atelier at launch: their state says whether it worked.
    note("P7 Docker atelier", {
      fakeDocker,
      fakeTools: FAKE_TOOLS,
      container: "webaios-atelier-firefox",
      ports: "5300-5319",
      harvestStates: (await readHome(spacePaths(path.join(w.dataDir, "espace")), path.join(w.dataDir, "widgets"))).widgets.flatMap((x) => ("erreur" in x ? [] : [{ id: x.id, etat: x.etat }])),
    });
  });
});
