import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DeclarationSite, type TweaksRead } from "../../../packages/kernel/src/index";
import { HOME_BRIDGE } from "../chrome/store/site-home";
import { displayServed } from "../chrome/window/widget-frame";
import { testActor } from "./agent-extensions";
import { state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { SITE_HOME, inBrowser, inSiteBar, inSiteView, resolveLocalHosts, siteWindowCount, siteWindowExpr, startSitesServer } from "./sites";

// Plan 31's spike (docs/superpowers/notes/2026-11-06-applis-de-site-firefox-spike.md): the site app window, routing
// without a request, the Xray sandbox, the test home page. The probes print what they see rather than assert it:
// rerun with RESSAC_SPIKE=1 after a Firefox version change and compare.

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const HOSTS = ["vidola-a.localhost", "vidola-b.localhost", "pub.localhost", "compte.localhost", "lecteur.localhost"];
const note = (what: string, v: unknown) => console.log(`[spike] ${what}: ${JSON.stringify(v)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A WebDriver script that runs `code` in the page world (a <script>): Marionette's own sandbox may not set a cross-origin location. */
const pageWorld = (code: string) => `const s = document.createElement("script"); s.textContent = ${JSON.stringify(code)}; document.documentElement.append(s); s.remove(); return 1;`;

/** The probe script of (c): what the sandbox sees, then the password field's value when the test asks. */
const PROBE = `
const seen = { Components: typeof Components, ChromeUtils: typeof ChromeUtils, Services: typeof Services, require: typeof require, process: typeof process,
  secret: typeof secret, windowSecret: typeof window.secret, portee: typeof __ressacScope, href: location.href };
window.probeVar = 1;
var probeGlobal = 2;
document.documentElement.setAttribute("data-probe", JSON.stringify(seen));
// The same-origin Xray door (the guard's comment: accepted, the inline-script twin): wrappedJSObject, and an
// inline <script> put in the page by the sandbox.
const injected = document.createElement("script");
injected.textContent = "window.injectedBySandbox = 1";
document.documentElement.append(injected);
document.addEventListener("probe-read", () => {
  const waived = (f) => { try { return f(); } catch (e) { return String(e); } };
  document.documentElement.setAttribute("data-pw", JSON.stringify(document.getElementById("pw").value));
  document.documentElement.setAttribute("data-door", JSON.stringify({
    secretWaived: waived(() => window.wrappedJSObject.secret),
    pwWaivedLength: waived(() => document.getElementById("pw").wrappedJSObject.value.length),
  }));
});
`;

/** A page for (c): a page-world secret, DOMContentLoaded stopped in capture, a password field, optionally a frame. */
const probePage = (frame: string) => `<!doctype html><title>Sonde</title>
<script>
  window.secret = "s3cret";
  for (const t of [window, document]) t.addEventListener("DOMContentLoaded", (e) => e.stopImmediatePropagation(), true);
  document.addEventListener("probe-check", () => document.documentElement.setAttribute("data-page", JSON.stringify({
    probeVar: typeof window.probeVar, probeGlobal: typeof window.probeGlobal, injectedBySandbox: typeof window.injectedBySandbox, portee: typeof window.__ressacScope, pwLength: document.getElementById("pw").value.length })));
</script>
<input type="password" id="pw">${frame ? `<iframe src="${frame}"></iframe>` : ""}`;

describe.skipIf(!process.env.RESSAC_SPIKE)("site app spike", () => {
  let server: Awaited<ReturnType<typeof startSitesServer>>;
  let w: LaunchedRessac;
  let m: Marionette;
  let profile: string;
  const pub = (p: string) => server.url("pub.localhost", p);
  const rules = (domains = ["vidola-a.localhost"], tweaks: object[] = []) => ({ id: "vidola", name: "Vidola", url: server.url("vidola-a.localhost", "/"), domains: domains, login: ["compte.localhost"], tweaks: tweaks });
  const view = `${siteWindowExpr("vidola")}.gBrowser.selectedBrowser`;
  const viewUrl = () => m.execute<string>(`return ${view}.currentURI.spec;`);
  const toPub = () => server.requests.filter((r) => r.host === "pub.localhost" && r.path !== "/cadre").map((r) => `${r.method} ${r.path}`);
  const blocked = () => m.execute<string[]>(`return ChromeUtils.importESModule("${STORE}").sites.blocked("vidola").slice();`);
  const browserWindows = () => m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].length;`);
  // As the host's SiteChrome (host/sites.ts preparer), granted.
  const openSite = (r = rules(), tweaks: TweaksRead = { js: {}, css: {} }) =>
    m.execute(`ChromeUtils.importESModule("${STORE}").sites.open(arguments[0], null, arguments[1]);`, [
      { id: r.id, declaration: DeclarationSite.parse({ name: r.name, url: r.url, domains: r.domains, login: r.login, tweaks: r.tweaks }), hasHome: false, domains: r.domains, start: r.url, grantRequired: false },
      tweaks,
    ]);
  /** Waits until the view has loaded `url`. */
  const viewAt = (url: string) => waitFor(m, `const b = ${view}; return !!b && b.currentURI.spec === arguments[0] && !b.webProgress.isLoadingDocument;`.replace("arguments[0]", JSON.stringify(url)), (v) => v === true, 15_000);
  /** Runs `act`, waits, then notes the view's URL, what reached pub.localhost, the mentions and the window count. */
  async function measure(what: string, act: () => Promise<unknown>, wait = 1000) {
    const before = (await blocked()).length;
    server.requests.splice(0);
    const result = await act().catch((e) => `threw: ${String(e).slice(0, 160)}`);
    await sleep(wait);
    const r = {
      result,
      url: await viewUrl(),
      toPublic: toPub(),
      requests: server.requests.map((q) => `${q.method} ${q.host}${q.path}`),
      blocked: (await blocked()).slice(before),
      windows: await browserWindows(),
      tabs: Object.keys((await state(m)).tabs).length,
    };
    note(what, r);
    // Security: nothing ever reaches pub.localhost (its ad frame on the home page aside).
    expect(r.toPublic, what).toEqual([]);
    return r;
  }

  beforeAll(async () => {
    server = await startSitesServer();
    const d = (p: string, body: Parameters<typeof server.define>[2], host = "vidola-a.localhost") => server.define(host, p, body);
    d("/", `<title>Vidola A</title>
<a id="pub" href="${pub("/x")}">pub</a>
<a id="aller-pub" href="/aller-pub">aller</a>
<a id="film" href="/film/2" target="_blank">film</a>
<a id="compte" href="${server.url("compte.localhost", "/connexion")}" target="_blank">compte</a>
<iframe id="cadre" src="${pub("/cadre")}"></iframe>`);
    d("/aller-pub", (_q, res) => res.writeHead(302, { Location: pub("/arrivee") }).end());
    d("/film/2", "<title>Film 2</title>");
    d("/refresh", `<title>Refresh</title><meta http-equiv="refresh" content="0;url=${pub("/meta")}">`);
    d("/formulaire", `<title>Formulaire</title><form id="f" method="post" action="${pub("/post")}"><input name="q" value="secret"><button id="envoyer">ok</button></form>`);
    d("/sonde", probePage(server.url("lecteur.localhost", "/sonde-cadre")));
    d("/sonde-cadre", probePage(""), "lecteur.localhost");
    d("/x", "<title>Pub</title>", "pub.localhost");
    d("/cadre", "<title>Cadre pub</title><p>pub</p>", "pub.localhost");
    d("/connexion", "<title>Connexion</title>", "compte.localhost");
    d("/", "<title>Vidola B</title>", "vidola-b.localhost");
    profile = await mkdtemp(path.join(os.tmpdir(), "ressac-firefox-"));
    const actor = testActor(profile);
    w = await launchRessac({ profile, env: { RESSAC_TEST_LOCAL_ADDRESSES: "1", ...actor.env }, prefs: actor.prefs });
    m = w.marionette;
    await m.setContext("chrome");
    await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
    await resolveLocalHosts(m, HOSTS);
    await openSite();
    await viewAt(server.url("vidola-a.localhost", "/"));
  }, 90_000);
  afterAll(async () => {
    await w?.close();
    await server?.close();
    if (profile) await rm(profile, { recursive: true, force: true });
  });
  beforeEach(() => void server.requests.splice(0));

  it("(a) the window: marked before claim, one browser in its container, out of the registry", async () => {
    const r = await m.execute(
      `return (async () => {
        const store = await ChromeUtils.importESModule("${STORE}").ready;
        const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");
        const { ContextualIdentityService } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
        const win = ${siteWindowExpr("vidola")};
        const main = [...Services.wm.getEnumerator("navigator:browser")].find((x) => x.document.documentElement.hasAttribute("ressac-main"));
        win.focus();
        await new Promise((r) => setTimeout(r, 300));
        const browser = win.gBrowser.selectedBrowser;
        const toolbox = win.document.getElementById("navigator-toolbox");
        const opts = win.arguments[1];
        return {
          markerArgument: opts instanceof Ci.nsIPropertyBag2 && opts.getPropertyAsAString("ressac-site"),
          markerAttribute: win.document.documentElement.getAttribute("ressac-site"),
          mainAttribute: win.document.documentElement.hasAttribute("ressac-main"),
          controller: typeof win.ressacWindow,
          toolbarVisible: win.toolbar.visible,
          tabs: win.gBrowser.tabs.length,
          browsers: win.document.querySelectorAll("browser[type=content]").length,
          toolboxHidden: toolbox.hidden, toolboxHeight: toolbox.getBoundingClientRect().height,
          tabsToolbarHeight: win.document.getElementById("TabsToolbar")?.getBoundingClientRect().height ?? null,
          userContextId: browser.getAttribute("usercontextid"),
          identity: ContextualIdentityService.getPrivateIdentity("userContextIdInternal.webaios-site-vidola")?.userContextId ?? null,
          barSrc: win.document.getElementById("ressac-site-bar")?.src,
          fenetres: store.state.windows.length,
          focusIsSite: Services.focus.activeWindow === win,
          activeIsMain: store.windows.get(store.windows.active())?.window === main,
          topWindowIsSite: BrowserWindowTracker.getTopWindow() === win,
          topWindowIsMain: BrowserWindowTracker.getTopWindow() === main,
          topWithPopupsIsSite: BrowserWindowTracker.getTopWindow({ allowPopups: true }) === win,
          title: win.document.title,
        };
      })();`,
    );
    note("(a) window", r);
    note("(a) count", await siteWindowCount(m, "vidola"));
    await openSite();
    await sleep(500);
    note("(a) reopen: count", await siteWindowCount(m, "vidola"));
  }, 60_000);

  it("(b) routing: zero request to pub.localhost", async () => {
    const home = server.url("vidola-a.localhost", "/");
    const back = async () => {
      await m.execute(`${view}.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, [home]);
      await viewAt(home);
    };
    await measure("(b) link click", () => inSiteView(m, "vidola", "document.getElementById('pub').click()", { gesture: true }));
    await measure("(b) 302 redirect", () => inSiteView(m, "vidola", "document.getElementById('aller-pub').click()", { gesture: true }));
    note("(b) frame process", await m.execute(`const b = ${view}.browsingContext; return { top: b.currentWindowGlobal.osPid, frame: b.children[0]?.currentWindowGlobal?.osPid, frameUrl: b.children[0]?.currentURI?.spec };`));
    await measure("(b) top.location from the pub frame", () => inSiteView(m, "vidola", `top.location = ${JSON.stringify(pub("/haut"))}; return 1;`, { gesture: true, frame: 0 }));
    await measure("(b) meta refresh", async () => {
      await inSiteView(m, "vidola", "location.href = '/refresh'");
      await viewAt(server.url("vidola-a.localhost", "/refresh"));
    });
    await back();
    await measure("(b) form POST", async () => {
      await inSiteView(m, "vidola", "location.href = '/formulaire'");
      await viewAt(server.url("vidola-a.localhost", "/formulaire"));
      await inSiteView(m, "vidola", "document.getElementById('envoyer').click()", { gesture: true });
    });
    await back();
    await measure("(b) window.open('') then location", () => inSiteView(m, "vidola", `const w = window.open(""); if (!w) return "null"; w.location = ${JSON.stringify(pub("/x"))}; return "opened";`, { gesture: true }));
    await measure("(b) window.open('', features) then location", () => inSiteView(m, "vidola", `const w = window.open("", "x", "width=400,height=400"); if (!w) return "null"; w.location = ${JSON.stringify(pub("/x2"))}; return "opened";`, { gesture: true }), 2000);
    await measure("(b) ten window.open to pub, from the page and its pub frame, plus about:blank and ''", async () => {
      const ten = `for (let i = 0; i < 10; i++) window.open(${JSON.stringify(pub("/x"))} + "?n=" + i); return 1;`;
      await inSiteView(m, "vidola", ten, { gesture: true });
      await inSiteView(m, "vidola", ten, { gesture: true, frame: 0 });
      await inSiteView(m, "vidola", "window.open('about:blank'); window.open(''); return 1;", { gesture: true });
    }, 2000);
    await measure("(b) window.open to the site's own page with features", () => inSiteView(m, "vidola", `window.open("/film/2", "f", "width=400,height=400"); return 1;`, { gesture: true }), 2000);
    await back();
    await measure("(b) target=_blank to /film/2", () => inSiteView(m, "vidola", "document.getElementById('film').click()", { gesture: true }));
    await back();

    // The sign-in window: window.open with features (Firefox opens a window itself), then target=_blank (browserDOMWindow).
    const login = server.url("compte.localhost", "/connexion");
    const small = `[...Services.wm.getEnumerator("navigator:browser")].find((w) => w.document.documentElement.getAttribute("ressac-site-small") === "vidola" && w.gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(login)})`;
    const smallInfo = () =>
      m.execute(`const w = ${small}; if (!w) return null; const b = w.gBrowser.selectedBrowser;
        return { outer: [w.outerWidth, w.outerHeight], inner: [w.innerWidth, w.innerHeight], content: [b.clientWidth, b.clientHeight], toolbarVisible: w.toolbar.visible,
          userContextId: b.getAttribute("usercontextid"), viewUserContextId: ${view}.getAttribute("usercontextid"), opener: !!b.browsingContext.opener, toolboxHidden: w.document.getElementById("navigator-toolbox").hidden };`);
    await measure("(b) window.open to compte.localhost with features", () => inSiteView(m, "vidola", `window.open(${JSON.stringify(login)}, "connexion", "width=500,height=650"); return 1;`, { gesture: true }), 2000);
    note("(b) sign-in window", await waitFor(m, `return !!(${small}) && !(${small}).gBrowser.selectedBrowser.webProgress.isLoadingDocument;`, (v) => v === true).then(smallInfo, (e) => String(e)));
    note("(b) sign-in window reached compte", server.requests.some((r) => r.host === "compte.localhost"));
    // With a gesture, from the page world; what the assignment did is written on the page.
    const opener = await measure("(b) opener.location from the sign-in window", async () => {
      await inBrowser(m, `(${small}).gBrowser.selectedBrowser`, pageWorld(`const u = ${JSON.stringify(pub("/opener"))}; const r = [];
        for (const [name, f] of [["opener.location =", () => { opener.location = u; }], ["opener.location.href =", () => { opener.location.href = u; }], ["opener.location.replace", () => opener.location.replace(u)]]) {
          try { f(); r.push(name + " assigned"); break; } catch (e) { r.push(name + " " + e.name + ": " + e.message); }
        }
        for (const [name, f] of [["opener.closed", () => opener.closed], ["opener.postMessage", () => opener.postMessage("x", "*")], ["opener.frames.length", () => opener.frames.length]]) {
          try { r.push(name + " = " + String(f())); } catch (e) { r.push(name + " " + e.name); }
        }
        document.documentElement.dataset.r = r.join(" | ");`), { gesture: true });
      return inBrowser(m, `(${small}).gBrowser.selectedBrowser`, "return document.documentElement.dataset.r;");
    });
    expect(opener.url).toBe(home);
    await measure("(b) the sign-in window navigates to pub", () => inBrowser(m, `(${small}).gBrowser.selectedBrowser`, `location.href = ${JSON.stringify(pub("/petite"))}; return 1;`));
    note("(b) sign-in window after", await smallInfo());
    await m.execute(`(${small})?.close();`);
    await sleep(500);
    await measure("(b) target=_blank to compte.localhost", () => inSiteView(m, "vidola", "document.getElementById('compte').click()", { gesture: true }), 2000);
    note("(b) target=_blank sign-in window", await smallInfo());
    note("(b) target=_blank: getTopWindow is a sign-in window", await m.execute(`const { BrowserWindowTracker } = ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs"); const w = BrowserWindowTracker.getTopWindow(); return !!w && w.document.documentElement.hasAttribute("ressac-site-small");`));
    await m.execute(`(${small})?.close();`);

    // history.back() to an entry of a domain removed since the visit.
    await openSite(rules(["vidola-a.localhost", "vidola-b.localhost"]));
    await inSiteView(m, "vidola", `location.href = ${JSON.stringify(server.url("vidola-b.localhost", "/"))}`);
    await viewAt(server.url("vidola-b.localhost", "/"));
    await inSiteView(m, "vidola", `location.href = ${JSON.stringify(server.url("vidola-a.localhost", "/film/2"))}`);
    await viewAt(server.url("vidola-a.localhost", "/film/2"));
    await openSite(rules());
    const r = await measure("(b) history.back() to vidola-b, removed", () => inSiteView(m, "vidola", "history.back(); return 1;"));
    note("(b) history.back(): requests to vidola-b", server.requests.filter((q) => q.host === "vidola-b.localhost").length);
    expect(server.requests.filter((q) => q.host === "vidola-b.localhost")).toEqual([]);
    expect(r.url).toBe(server.url("vidola-a.localhost", "/film/2"));
    note("(b) history.back(): url", r.url);
    await back();
  }, 240_000);

  it("(c) the sandbox: no chrome, no page world, password hidden, after a stopped DOMContentLoaded", async () => {
    // Plan 32: the probe is the app's tweak, in the page and in the lecteur.localhost frame (its `cadres`).
    const reader = server.url("lecteur.localhost", "/*").replace(/^http:/, "https:");
    await openSite(rules(undefined, [{ matches: ["/sonde"], js: ["sonde.js"], frames: [reader] }]), { js: { "sonde.js": PROBE }, css: {} });
    const probe = server.url("vidola-a.localhost", "/sonde");
    await inSiteView(m, "vidola", `location.href = ${JSON.stringify(probe)}`);
    await viewAt(probe);
    note("(c) processes", await m.execute(`const b = ${view}.browsingContext; return { top: b.currentWindowGlobal.osPid, frame: b.children[0]?.currentWindowGlobal?.osPid, frameUrl: b.children[0]?.currentURI?.spec };`));
    const read = `document.getElementById("pw").value = "hunter2";
      document.dispatchEvent(new Event("probe-read"));
      document.dispatchEvent(new Event("probe-check"));
      const e = document.documentElement;
      return { probe: JSON.parse(e.getAttribute("data-probe")), pw: e.getAttribute("data-pw"), door: JSON.parse(e.getAttribute("data-door")), page: JSON.parse(e.getAttribute("data-page")) };`;
    for (const [where, frame] of [["main document", undefined], ["lecteur.localhost frame", 0]] as const) {
      const got = await inSiteView<any>(m, "vidola", read, { frame });
      note(`(c) ${where}`, got);
      // Security: through its Xray view the sandbox sees no chrome, nothing of the page, and no password.
      for (const k of ["Components", "ChromeUtils", "Services", "require", "process", "secret", "windowSecret"]) expect(got.probe[k], k).toBe("undefined");
      expect(got.pw).toBe('""');
      expect(got.page).toMatchObject({ probeVar: "undefined", probeGlobal: "undefined", scope: "undefined", pwLength: 7 });
    }
    // An ordinary tab with the same page: the actor does nothing there.
    note(
      "(c) ordinary tab",
      await m.execute(
        `return (async () => {
          const t = gBrowser.addTrustedTab(arguments[0]);
          for (let i = 0; i < 100 && (t.linkedBrowser.currentURI.spec !== arguments[0] || t.linkedBrowser.webProgress.isLoadingDocument); i++) await new Promise((r) => setTimeout(r, 100));
          const { NavigableManager } = ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs");
          window.__spikeTab = NavigableManager.getIdForBrowser(t.linkedBrowser);
          return t.linkedBrowser.getAttribute("usercontextid");
        })();`,
        [probe],
      ),
    );
    const handle = await m.execute<string>("return window.__spikeTab;");
    const main = (await m.command<{ value: string }>("WebDriver:GetWindowHandle")).value;
    await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
    await m.setContext("content");
    note("(c) ordinary tab probe", await m.execute(`return document.documentElement.getAttribute("data-probe");`));
    await m.setContext("chrome");
    await m.command("WebDriver:SwitchToWindow", { handle: main, focus: false });
    await m.execute(`gBrowser.removeTab(gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec === arguments[0]));`, [probe]);
    await openSite();
  }, 90_000);

  it("(d) the test home page: unchanged, served by resource://, parent.postMessage both ways", async () => {
    // The served copy: the widget display's CSP and guard, then the bridge, then the home page as is.
    const served = displayServed(SITE_HOME).replace("<title>Accueil</title>", `${HOME_BRIDGE}<title>Accueil</title>`);
    const dir = path.join(w.dataDir, "ressac-sites", "vidola");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), served);
    const memory = { type: "memory", values: { "encours.the-bear": { value: { titre: "The Bear", episode: "S2E4" }, url: "/serie/the-bear?e=4", when: new Date().toISOString() } }, positions: {}, domain: "vidola-a.localhost" };
    note(
      "(d) frame",
      await inSiteBar(
        m,
        "vidola",
        `const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
        Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler).setSubstitution("ressac-site-vidola", Services.io.newFileURI(new FileUtils.File(arguments[0])));
        // The bar's frame covers the window in the home view (plan 31): the home frame on top of it.
        win.document.getElementById("ressac-site-bar").style.height = "600px";
        const home = doc.createElement("iframe");
        home.setAttribute("sandbox", "allow-scripts");
        home.style.cssText = "position: fixed; left: 0; top: 0; width: 800px; height: 500px; border: none";
        const got = (win.__spikeHome = { root: [], frameWindow: [] });
        // Listened above the frame (the window root sees events of the chrome window's in-process frames), before it loads.
        win.windowRoot.addEventListener("ressac-home", (e) => {
          const fromFrame = e.target === home.contentWindow;
          got.root.push({ detail: e.detail, fromFrame });
          let m;
          try { m = JSON.parse(e.detail); } catch {}
          if (fromFrame && m?.type === "ready") home.contentWindow.postMessage(arguments[1], "*");
        }, true, true);
        doc.documentElement.append(home);
        home.src = "resource://ressac-site-vidola/index.html";
        for (let i = 0; i < 100 && home.contentDocument?.readyState !== "complete"; i++) await new Promise((r) => setTimeout(r, 100));
        home.contentDocument.defaultView.addEventListener("ressac-home", (e) => got.frameWindow.push(e.detail), true, true);
        await new Promise((r) => setTimeout(r, 500));
        const fd = home.contentDocument;
        return { src: home.src, sandbox: home.getAttribute("sandbox"), origin: fd.defaultView.origin, rtc: typeof fd.defaultView.wrappedJSObject.RTCPeerConnection, xslt: typeof fd.defaultView.wrappedJSObject.XSLTProcessor, ressac: typeof fd.defaultView.wrappedJSObject.ressac,
          series: fd.getElementById("series")?.textContent, domaine: fd.getElementById("domaine")?.textContent, received: got.root, barUrl: doc.documentURI };`,
        [dir, memory],
      ),
    );
    // A real click on « Reprendre »: its parent.postMessage({type: "open"}) reaches the chrome, a trusted pointerdown with it.
    note(
      "(d) click",
      await inSiteBar(
        m,
        "vidola",
        `const home = doc.querySelector("iframe[sandbox]");
        const fw = home.contentDocument.defaultView;
        const trusted = [];
        fw.addEventListener("pointerdown", (e) => trusted.push(e.isTrusted), true);
        const r = home.contentDocument.getElementById("ouvrir").getBoundingClientRect();
        const f = home.getBoundingClientRect();
        const ui = doc.defaultView;
        for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, f.left + r.left + r.width / 2, f.top + r.top + r.height / 2, { button: 0, clickCount: 1 });
        await new Promise((r) => setTimeout(r, 300));
        return { trusted, received: win.__spikeHome.root.slice(-1) };`,
      ),
    );
  }, 60_000);

  it("(e) closing the app window closes its sign-in windows: nothing of its container stays unguarded", async () => {
    const login = server.url("compte.localhost", "/connexion");
    await inSiteView(m, "vidola", `window.open(${JSON.stringify(login)}, "connexion", "width=500,height=650"); return 1;`, { gesture: true });
    const small = `[...Services.wm.getEnumerator("navigator:browser")].filter((w) => w.document.documentElement.getAttribute("ressac-site-small") === "vidola").length`;
    await waitFor(m, `return ${small};`, (n: number) => n === 1);
    await m.execute(`${siteWindowExpr("vidola")}.close();`);
    const left = await waitFor(m, `return ${small};`, (n: number) => n === 0).catch(() => -1);
    note("(e) sign-in windows left after the app window closed", left);
    expect(left).toBe(0);
  }, 60_000);
});
