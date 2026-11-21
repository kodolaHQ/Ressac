import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPS_ENV, appWindowExpr, inAppView, launchAttempt, writeProject } from "./apps";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { grantSite, inHomeFrame, inSiteView, siteHomeBrowser, siteWindowExpr, writeSite } from "./sites";
import { click, inFrame } from "./ui";
import { consoleWith, DATA_PNG, NET_PREFS, netEnv, resolvedNames, rtcPage, SFX, startNetWitness, testPages, uiRefusals, widgetFiles } from "./ui-network";

// The UI's network (spec 2026-11-08-ressac-firefox-reseau-interfaces-design.md): nothing the UI shows reaches a server
// or makes a name resolve. One launch for the file. Ports: 15365 (HTTP/WS, logged by host), 15366 (TCP counter: fake
// TURN), 15367 (UDP counter: fake STUN), 15370-15374 (agent apps). The zero counters are the acceptance.

const HTTP = 15365;
const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const host = (name: string) => `${name}.${SFX}:${HTTP}`;

/** Shows the data it receives. No `e.source !== parent` test: in a sandboxed frame it is not parent (home.e2e.ts). */
const DISPLAY = `<!doctype html><meta charset="utf-8">
<pre id="donnees"></pre><span id="statut"></span> <span id="messages">0</span>
<script>
  let n = 0;
  addEventListener("message", (e) => {
    if (!e.data || e.data.type !== "widget") return;
    n++;
    document.getElementById("donnees").textContent = JSON.stringify(e.data.data);
    document.getElementById("statut").textContent = e.data.state.status;
    document.getElementById("messages").textContent = String(n);
  });
</script>`;

/** An offer to a fake TURN/TCP and STUN/UDP; writes its result with `note`. */
const rtcCode = (tag: string, note: string) => `try {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "turn:${tag}-turn.${SFX}:15366?transport=tcp", username: "SECRET", credential: "x" }, { urls: "stun:${tag}-stun.${SFX}:15367" }] });
  pc.createDataChannel("x");
  pc.createOffer().then((o) => pc.setLocalDescription(o));
  ${note}("lancé");
} catch (e) { ${note}("erreur " + e.name); }`;

/** A spy display, its addresses under espion.<SFX>. */
function spyDisplay(): string {
  const a = `http://${host("espion")}`;
  const inFrame = `<script>const noter = (t) => parent.postMessage({ imbrique: t }, "*"); ${rtcCode("espion-imbrique", "noter")}</script>`;
  const asString = (t: string) => JSON.stringify(t).replace(/<\//g, "<\\/");
  return `<!doctype html><meta charset="utf-8"><p id="rtc">…</p><p id="imbrique">…</p><p id="js">…</p><p id="vide">…</p>
<script>
  const note = (id, t) => (document.getElementById(id).textContent = t);
  const essai = (f) => { try { f(); } catch {} };
  essai(() => fetch(${JSON.stringify(`${a}/espion-fetch`)}).catch(() => {}));
  essai(() => navigator.sendBeacon(${JSON.stringify(`${a}/espion-balise`)}, "x"));
  essai(() => new WebSocket(${JSON.stringify(`ws://${host("espion-ws")}/espion-ws`)}));
  essai(() => { const i = new Image(); i.src = ${JSON.stringify(`${a}/espion-image`)}; document.body.append(i); });
  essai(() => document.body.insertAdjacentHTML("beforeend", '<img src="${a}/espion-img">'));
  essai(() => document.body.insertAdjacentHTML("beforeend", "<" + 'link rel="prefetch" href="${a}/espion-prefetch">'));
  ${rtcCode("espion", "((t) => note('rtc', t))")}
  addEventListener("message", (e) => { if (e.data && e.data.imbrique) note("imbrique", e.data.imbrique); });
  const s = document.createElement("iframe");
  s.srcdoc = ${asString(inFrame)};
  document.body.append(s);
  const j = document.createElement("iframe");
  try { j.setAttribute("src", "javascript:" + encodeURIComponent(${asString(inFrame)})); note("js", "posé"); } catch (e) { note("js", "erreur " + e.name); }
  document.body.append(j);
  const v = document.createElement("iframe");
  document.body.append(v);
  try { note("vide", typeof v.contentWindow.RTCPeerConnection); } catch (e) { note("vide", "erreur " + e.name); }
</script>`;
}

/** The spikes' loadsWidget: a static web frame, a child navigated to the web, a frame through about:blank, then itself. */
const framesDisplay = `<!doctype html><meta charset="utf-8"><title>cadres</title><p id="t">cadres</p>
<iframe src="http://${host("fuite-sfr")}/fuite/sfr"></iframe>
<script>
const f = document.createElement("iframe");
document.body.append(f);
try { f.contentWindow.location.href = "http://${host("fuite-nav")}/fuite/nav"; } catch (e) { document.getElementById("t").dataset.nav = String(e).slice(0, 80); }
const b = document.createElement("iframe");
document.body.append(b);
try { const i = b.contentDocument.createElement("iframe"); i.src = "http://${host("fuite-bfr")}/fuite/bfr"; b.contentDocument.body.append(i); } catch (e) { document.getElementById("t").dataset.bfr = String(e).slice(0, 80); }
setTimeout(() => { try { location.href = "http://${host("fuite-self")}/fuite/self"; } catch (e) { document.getElementById("t").dataset.self = String(e).slice(0, 80); } }, 1500);
</script>`;

/** A dedicated worker's fetch and WebSocket. Measured: in the parent process its fetch has no context at all, only the
 * worker's principal. The parent process refuses data: and blob: scripts and an opaque page cannot start a resource:
 * worker (so no served UI page can start one), hence this page is not sandboxed. */
const workerCode = `fetch(${JSON.stringify(`http://${host("tp-wfetch")}/tp/wfetch`)}).catch(() => {}); try { new WebSocket(${JSON.stringify(`ws://${host("tp-wws")}/tp/wws`)}); } catch (e) {} postMessage("ran");`;
const workerPage = `<!doctype html><meta charset="utf-8"><title>wk</title><script>
const wk = new Worker("worker.js");
wk.onmessage = (e) => (document.title = "worker " + e.data);
wk.onerror = () => (document.title = "worker error");
</script>`;
/** A WebTransport attempt to the UDP counter: its channel has a principal and no context. Its title: typeof WebTransport. */
const webTransportPage = `<!doctype html><meta charset="utf-8"><title>wt</title><script>
document.title = typeof WebTransport;
try { const t = new WebTransport("https://tp-wt.${SFX}:15367/tp/wt"); t.ready.catch(() => {}); t.closed.catch(() => {}); } catch (e) { document.title += " " + e.name; }
</script>`;

/** An unguarded opaque page (no CSP, no guard): every kind of load of the spikes' S2, under tp-<kind>. */
const loadsPage = `<!doctype html><meta charset="utf-8"><title>tp</title><p class="f">tp</p>
<style>@font-face { font-family: tp; src: url(http://${host("tp-font")}/tp/font); } .f { font-family: tp; }</style>
<img src="http://${host("tp-img")}/tp/img">
<div style="width:4px;height:4px;background-image:url(http://${host("tp-bg")}/tp/bg)"></div>
<iframe src="http://${host("tp-frame")}/tp/frame"></iframe>
<script>
fetch("http://${host("tp-fetch")}/tp/fetch").catch(() => {});
try { new WebSocket("ws://${host("tp-ws")}/tp/ws"); } catch (e) {}
try { navigator.sendBeacon("http://${host("tp-beacon")}/tp/beacon", "x"); } catch (e) {}
const f = document.createElement("iframe");
document.body.append(f);
try { f.contentWindow.location.href = "http://${host("tp-nav")}/tp/nav"; } catch (e) {}
</script>`;

/** accueil.spec.ts:810's display that writes network hints by script: each attempt's outcome in #r. */
const dnsScriptDisplay = `<!doctype html><meta charset="utf-8"><p id="r"></p><script>
  const L = "<" + "link";
  const r = [];
  const essai = (nom, f) => { try { f(); r.push(nom + ":passé"); } catch (e) { r.push(nom + ":" + e.name); } };
  essai("create", () => { const l = document.createElement("link"); l.rel = "dns-prefetch"; l.href = "//create.${SFX}"; document.head.append(l); });
  essai("inner", () => { document.body.innerHTML += L + ' rel="dns-prefetch" href="//inner.${SFX}">'; });
  essai("srcdoc", () => { const f = document.createElement("iframe"); f.srcdoc = L + ' rel=dns-prefetch href=//srcdoc.${SFX}>'; document.body.append(f); });
  essai("meta", () => { const m = document.createElement("meta"); m.httpEquiv = "x-dns-prefetch-control"; m.content = "on"; document.head.append(m); });
  essai("image", () => { const i = new Image(); i.src = "https://image.${SFX}/i.png"; document.body.append(i); });
  essai("ancre", () => { document.body.insertAdjacentHTML("beforeend", '<a href="https://ancre2.${SFX}/">a</a>'); });
  const XHTML = "http://www.w3.org/1999/xhtml";
  essai("createDocument", () => { const d = document.implementation.createDocument(XHTML, "li" + "nk", null); const l = document.adoptNode(d.documentElement); l.setAttribute("rel", "dns-prefetch"); l.setAttribute("href", "//createdoc.${SFX}"); document.head.append(l); });
  essai("importNode", () => { const d = document.implementation.createDocument(XHTML, "li" + "nk", null); const l = document.importNode(d.documentElement); l.rel = "preconnect"; l.href = "https://import.${SFX}/"; document.head.appendChild(l); });
  essai("htmlDocument", () => { const d = document.implementation.createHTMLDocument(""); const l = d.createElement("li" + "nk"); l.rel = "dns-prefetch"; l.href = "//htmldoc.${SFX}"; document.head.append(document.adoptNode(l)); });
  essai("fragment", () => { const d = document.implementation.createDocument(XHTML, "li" + "nk", null); const f = document.createDocumentFragment(); const p = document.createElement("p"); p.appendChild(document.adoptNode(d.documentElement)); f.append(p); p.firstChild.setAttribute("rel", "dns-prefetch"); p.firstChild.setAttribute("href", "//fragment.${SFX}"); document.body.append(f); });
  essai("execCommand", () => { const d = document.createElement("div"); d.contentEditable = "true"; document.body.append(d); d.focus(); document.execCommand("insertHTML", false, L + " rel=dns-prefetch href=//exec.${SFX}>"); });
  essai("srcdocEntites", () => { const f = document.createElement("iframe"); f.srcdoc = "<iframe srcdoc='&#38;lt;" + "link rel=dns-prefetch href=//srcdoc-dyn.${SFX}>'></iframe>"; document.body.append(f); });
  document.getElementById("r").textContent = r.join(" ");
</script>`;

/** dns-script's outcomes under the Firefox guard. */
const DNS_SCRIPT =
  "create:TypeError inner:TypeError srcdoc:TypeError meta:TypeError image:passé ancre:passé createDocument:TypeError importNode:TypeError htmlDocument:TypeError fragment:TypeError execCommand:TypeError srcdocEntites:TypeError";

/**
 * Links a person presses: #l opens its address in a tab through ressacOpen (the click handler), #p is a plain link,
 * #s an SVG link. The display's own capture listener tries to stop every mousedown before the chrome sees it.
 */
/**
 * Links around shadow content (open, closed, a shadow inside a shadow), and light content slotted under a link of a
 * shadow tree: a press must still be seen under its link. #hv is only hovered.
 */
const shadowDisplay = `<!doctype html><meta charset="utf-8"><title>ombre</title><body style="margin:0;font-size:14px">
<a href="http://sh-open.${SFX}:15366/"><span id="h-open" style="display:inline-block"></span></a>
<a href="http://sh-closed.${SFX}:15366/"><span id="h-closed" style="display:inline-block"></span></a>
<a href="http://sh-nested.${SFX}:15366/"><span id="h-nested" style="display:inline-block"></span></a>
<span id="h-slot" style="display:inline-block"><b>slotted</b></span>
<a href="http://sh-deep.${SFX}:15366/"><span id="h-deep"></span></a>
<a id="hv" href="http://hover.${SFX}:15366/">hover hover</a>
<script>
  const shadow = (id, mode, nested) => {
    const root = document.getElementById(id).attachShadow({ mode });
    const b = document.createElement("b");
    b.textContent = "shadow " + id;
    if (!nested) return root.append(b);
    const inner = document.createElement("span");
    root.append(inner);
    inner.attachShadow({ mode: "open" }).append(b);
  };
  shadow("h-open", "open");
  shadow("h-closed", "closed");
  shadow("h-nested", "open", true);
  // Light content slotted under a link that lives in a closed shadow root.
  const slotLink = document.createElement("a");
  slotLink.href = "http://sh-slot.${SFX}:15366/";
  slotLink.append(document.createElement("slot"));
  document.getElementById("h-slot").attachShadow({ mode: "closed" }).append(slotLink);
  // Deeper than the guard's walk bound (measured: Gecko warms nothing this deep either; kept as a witness).
  let deep = document.getElementById("h-deep");
  for (let i = 0; i < 1100; i++) deep = deep.appendChild(document.createElement("span"));
  deep.id = "h-deep-in";
  deep.textContent = "deep";
</script>`;

const linksDisplay = `<!doctype html><meta charset="utf-8"><title>lien</title>
<p><a id="l" href="http://md.${SFX}:15366/" style="display:inline-block;font-size:20px;padding:4px">ouvrir</a>
<a id="p" href="http://${host("plain")}/plain" style="display:inline-block;font-size:20px;padding:4px">simple</a></p>
<svg width="160" height="30"><a id="s" href="http://md-svg.${SFX}:15366/"><text x="4" y="22" font-size="20">svg svg svg</text></a></svg>
<script>
  addEventListener("mousedown", (e) => e.stopImmediatePropagation(), true);
  const l = document.getElementById("l");
  l.addEventListener("click", (e) => { e.preventDefault(); l.dataset.clicks = String(Number(l.dataset.clicks || 0) + 1); ressacOpen("http://${host("ouvert")}/ouvert"); });
</script>`;

describe("the UI's network", () => {
  let w: LaunchedRessac;
  let m: Marionette;
  let dataDir: string;
  let logDir: string;
  let pages: string;
  let net: Awaited<ReturnType<typeof startNetWitness>>;

  const names = () => resolvedNames(logDir);
  // The UI's refusals logged since `from`, less the leaking widgets' own: they navigate 1.5 s after each load of theirs (at
  // startup, and again when the home comes back after a tab), so they land inside whichever test runs then.
  const refusalsSince = async (from: number) => (await uiRefusals(m)).slice(from).filter((r) => !/\/\/fuite[-.]/.test(r));
  /** A frame `<iframe sandbox="allow-scripts">` appended to the sidebar on `src`; resolves once its document is `src`. */
  // The sidebar's CSP keeps `frame-src resource:` for these frames alone (no Ressac code frames resource: there since the
  // remote frames): removing it refuses them before the net, and these net tests could no longer set up their page.
  const sidebarFrame = (id: string, src: string, sandbox: string | null = "allow-scripts") =>
    m.execute(
      `return (async () => { const sb = document.getElementById("ressac-sidebar").contentDocument;
       const f = sb.createElement("iframe"); f.id = arguments[0]; if (arguments[2] !== null) f.setAttribute("sandbox", arguments[2]); f.style.cssText = "width:20px;height:20px;border:0";
       sb.body.append(f); f.setAttribute("src", arguments[1]);
       for (let i = 0; i < 100 && f.contentDocument?.documentURI !== arguments[1]; i++) await new Promise((r) => setTimeout(r, 50));
       return f.contentDocument?.documentURI; })();`,
      [id, src, sandbox],
    );
  /** Widget `id`'s remote frame <browser>, in the sidebar. */
  const FRAME = (id: string) => `[data-testid="widget-${id}"] browser`;
  const widgetFrame = (id: string) => `document.getElementById("ressac-sidebar").contentDocument.querySelector('${FRAME(id)}')`;
  /** Evaluates `expr` in widget `id`'s document (the frames actor's test hook); null while it has none. */
  const inWidget = <T = unknown>(id: string, expr: string) => inFrame<T>(m, FRAME(id), expr).catch(() => null);
  /** The page rectangle of `sel` in widget `id`'s document. */
  const rectIn = (id: string, sel: string) =>
    inFrame<{ left: number; top: number; width: number; height: number }>(m, FRAME(id), `document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().toJSON()`);
  /** A frame's cut, read on its docShell: { dns: allowDNSPrefetch, mail: appType is APP_TYPE_MAIL, uri: its document }. */
  const CUT = `const cut = (el) => { const ds = el?.frameLoader?.docShell; return ds ? { dns: ds.allowDNSPrefetch, mail: ds.appType === Ci.nsIDocShell.APP_TYPE_MAIL, uri: el.contentDocument?.documentURI } : null; };`;
  const tcpSince = (n: number) => net.tcp.length - n;
  /**
   * A trusted press (synthesizeMouseEvent from the sidebar, as a person's) on `sel` in widget `id`'s display, released on
   * the same point (a click) or away from it (no click). Returns the sidebar's element under the point.
   */
  const press = async (id: string, sel: string, click: boolean) => {
    await m.execute(`return (async () => { ${widgetFrame(id)}.scrollIntoView({ block: "center" }); await new Promise((r) => document.getElementById("ressac-sidebar").contentWindow.requestAnimationFrame(r)); })();`);
    // The frame's process learns its new place a paint or more after the scroll; a press before that lands where the frame
    // was (measured: the page got the press 253 px above the link, the scroll's distance). Pressed once both agree.
    const where = () => Promise.all([m.execute<number>(`return document.getElementById("ressac-sidebar").contentWindow.mozInnerScreenY + ${widgetFrame(id)}.getBoundingClientRect().top;`), inFrame<number>(m, FRAME(id), "window.mozInnerScreenY")]);
    await expect.poll(async () => { const [outer, inner] = await where(); return Math.abs(outer - inner) < 1; }).toBe(true);
    return m.execute<string | null>(
      `return (async () => { const sb = document.getElementById("ressac-sidebar"), ui = sb.contentWindow, f = ${widgetFrame(id)};
       const r = f.getBoundingClientRect(), q = arguments[2];
       const x = r.left + q.left + Math.min(10, q.width / 2), y = r.top + q.top + q.height / 2;
       const hit = sb.contentDocument.elementFromPoint(x, y)?.localName ?? null;
       ui.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
       if (arguments[1]) ui.synthesizeMouseEvent("mouseup", x, y, { button: 0, clickCount: 1 });
       else ui.synthesizeMouseEvent("mouseup", 2, 2, { button: 0, clickCount: 1 });
       return hit; })();`,
      [sel, click, await rectIn(id, sel)],
    );
  };
  const tabUrls = async () => Object.values((await state(m)).tabs).map((o) => o.url);
  /** Closes the tab whose address contains `part` (its opening hid the home), then waits for widget `id` again. */
  async function closeTab(part: string, id: string): Promise<void> {
    const tab = Object.entries((await state(m)).tabs).find(([, o]) => o.url.includes(part))?.[0];
    expect(tab, part).toBeDefined();
    await dispatch(m, { type: "closeTab", id: tab! });
    await expect.poll(() => inWidget(id, "!!document.body?.firstChild"), { timeout: 15_000 }).toBe(true);
  }

  beforeAll(async () => {
    net = await startNetWitness({ http: HTTP, raw: 15366, udp: 15367 });
    dataDir = await mkdtemp(path.join(os.tmpdir(), "ressac-data-"));
    logDir = await mkdtemp(path.join(os.tmpdir(), "ressac-dnslog-"));
    pages = await mkdtemp(path.join(os.tmpdir(), "ressac-net-pages-"));
    writeFileSync(path.join(pages, "rtc.html"), rtcPage("rtcp"));
    writeFileSync(path.join(pages, "loads.html"), loadsPage);
    writeFileSync(path.join(pages, "wt.html"), webTransportPage);
    writeFileSync(path.join(pages, "worker.html"), workerPage);
    writeFileSync(path.join(pages, "worker.js"), workerCode);
    widgetFiles(dataDir, "espion", spyDisplay());
    // Leaking widgets: the display navigates itself to the server, or to data:.
    widgetFiles(dataDir, "fuite", DISPLAY.replace("</script>", `setTimeout(() => (location = ${JSON.stringify(`http://${host("fuite")}/fuite-navigation?d=secret`)}), 1500);</script>`), "reste");
    widgetFiles(dataDir, "fuite-data", DISPLAY.replace("</script>", `setTimeout(() => (location = "data:text/html,<pre id=donnees>pirate</pre>"), 1500);</script>`), "reste");
    widgetFiles(dataDir, "fuite-cadres", framesDisplay);
    // accueil.spec.ts:810: displays with hints in their HTML are served refused (the parser would come before any guard).
    widgetFiles(dataDir, "dns-statique", `<!doctype html><link rel="dns-prefetch" href="//statique.${SFX}"><link rel="preconnect" href="https://preco.${SFX}"><p id="ok">pas refusé</p>`);
    widgetFiles(dataDir, "dns-meta", `<!doctype html><meta http-equiv="x-dns-prefetch-control" content="on"><a href="https://ancre.${SFX}/">a</a><p id="ok">pas refusé</p>`);
    widgetFiles(dataDir, "dns-entites", `<!doctype html><iframe srcdoc="<iframe srcdoc='&#38;lt;link rel=dns-prefetch href=//entite.${SFX}>'></iframe>"></iframe><p id="ok">pas refusé</p>`);
    widgetFiles(dataDir, "dns-entites-hex", `<!doctype html><iframe srcdoc="&#x26;lt;link rel=dns-prefetch href=//entite-hex.${SFX}>"></iframe><p id="ok">pas refusé</p>`);
    widgetFiles(dataDir, "dns-script", dnsScriptDisplay);
    // A starter widget still shows.
    const starter = path.resolve(import.meta.dirname, "../../../packages/kernel/templates/fr/widgets/actus-tech");
    widgetFiles(dataDir, "actus-tech", readFileSync(path.join(starter, "display.html"), "utf8"), JSON.parse(readFileSync(path.join(starter, "example.json"), "utf8")));
    widgetFiles(dataDir, "sonde", DISPLAY);
    widgetFiles(dataDir, "lien", linksDisplay);
    widgetFiles(dataDir, "ombre", shadowDisplay);
    writeProject(dataDir, "essai", { manifest: {} });
    const netsite = { name: "Netsite", url: `http://netsite.localhost:${HTTP}/page`, domains: ["netsite.localhost"] };
    writeSite(dataDir, "netsite", { declaration: netsite });
    await grantSite(dataDir, "netsite", netsite);
    const withHome = { name: "Netsite accueil", url: `http://netsite-accueil.localhost:${HTTP}/page`, domains: ["netsite-accueil.localhost"] };
    writeSite(dataDir, "netsite-accueil", { declaration: withHome, files: { "home/index.html": '<!doctype html><meta charset="utf-8"><p id="h">accueil</p>' } });
    await grantSite(dataDir, "netsite-accueil", withHome);
    w = await launchRessac({ dataDir, prefs: NET_PREFS, env: { ...netEnv(logDir), RESSAC_TEST_LOCAL_ADDRESSES: "1", ...APPS_ENV([15370, 15374]) } });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    await testPages(m, pages);
  }, 120_000);
  afterAll(async () => {
    await w?.close();
    net?.close();
    for (const d of [dataDir, logDir, pages]) if (d) await rm(d, { recursive: true, force: true });
  });

  // accueil.spec.ts:718
  it("a widget display can reach no server (neither WebRTC TURN/TCP or STUN/UDP, nested frames included)", { timeout: 120_000 }, async () => {
    const spy = () =>
      inWidget<Record<string, string | null>>(
        "espion",
        `(() => { const t = (id) => document.getElementById(id)?.textContent ?? null;
         return { rtc: t("rtc"), imbrique: t("imbrique"), js: t("js"), vide: t("vide") }; })()`,
      ).then((r) => r ?? {});
    await expect.poll(async () => (await spy()).vide, { timeout: 20_000 }).toBe("erreur SecurityError");
    const data = (id: string) => inWidget<string | null>(id, `document.getElementById("donnees")?.textContent ?? null`);
    await expect.poll(() => data("fuite"), { timeout: 20_000 }).toBe('"reste"');
    await expect.poll(() => data("fuite-data"), { timeout: 10_000 }).toBe('"reste"');
    await expect.poll(() => inWidget("fuite-cadres", `!!document.getElementById("t")`), { timeout: 10_000 }).toBe(true);
    await sleep(3000);
    // The nested srcdoc frame has no RTCPeerConnection either (frame-actor.ts RessacFrameRtcChild): no offer reaches
    // the parent's blocker. The counters below are the acceptance.
    expect(await spy()).toEqual({ rtc: "erreur TypeError", imbrique: "erreur TypeError", js: "posé", vide: "erreur SecurityError" });
    expect(await consoleWith(m, "[ui-network] refused webrtc from a frame")).toEqual([]);
    expect(await data("fuite")).toBe('"reste"');
    expect(await data("fuite-data")).toBe('"reste"');
    for (const id of ["espion", "fuite", "fuite-data", "fuite-cadres"])
      expect(await inWidget(id, "document.documentURI"), `${id} stays on its copy`).toMatch(new RegExp(`^resource://ressac-frames-[0-9a-f]{16}/widgets/${id}/`));
    expect(net.hits.filter((h) => /espion|fuite/.test(h.label + h.path)).map((h) => `${h.label} ${h.method} ${h.path}`)).toEqual([]);
    expect((await names()).filter((n) => /espion|fuite/.test(n)), "no name resolved").toEqual([]);
    expect(net.tcp.length, "TCP connections to the fake TURN").toBe(0);
    expect(net.udp.length, "UDP packets to the fake STUN").toBe(0);
  });

  // accueil.spec.ts:781
  it("the net: a UI document without the widget guard reaches no server by WebRTC", { timeout: 120_000 }, async () => {
    const tcp0 = net.tcp.length;
    const udp0 = net.udp.length;
    expect(await sidebarFrame("rtc-net", "resource://ressac-test-net/rtc.html")).toBe("resource://ressac-test-net/rtc.html");
    const result = () => m.execute<string | null>(`return document.getElementById("ressac-sidebar").contentDocument.getElementById("rtc-net")?.contentDocument?.getElementById("r")?.textContent ?? null;`);
    await expect.poll(result, { timeout: 30_000 }).toMatch(/^\[/);
    await sleep(3000);
    const [main, blank] = JSON.parse((await result())!) as { result?: string; ms?: number; error?: string }[];
    expect(main!.result, JSON.stringify(main)).toBe("NotAllowedError");
    expect(main!.ms, "refused at once").toBeLessThan(1000);
    expect(blank!.result ?? blank!.error, JSON.stringify(blank)).toMatch(/SecurityError|NotAllowedError/);
    expect(net.tcp.length - tcp0, "TCP connections to the fake TURN").toBe(0);
    expect(net.udp.length - udp0, "UDP packets to the fake STUN").toBe(0);
    expect((await names()).filter((n) => /^(turn|stun)-rtcp/.test(n))).toEqual([]);
  });

  it("the sidebar and the agent panel load nothing from the web: an <img> and a background-image in http, https or ws, even 127.0.0.1, are refused; a data: image shows", { timeout: 120_000 }, async () => {
    // The panel opened (✦): a hidden one lays nothing out, so it would not even try its background-image.
    if (await m.execute<boolean>("return document.getElementById('ressac-agent').hidden")) await click(m, '[data-testid="agent-button"]');
    const widths = await m.execute<Record<string, number>>(
      `return (async () => { const out = {};
       for (const [tag, id] of [["sb", "ressac-sidebar"], ["ag", "ressac-agent"]]) {
         const d = document.getElementById(id).contentDocument;
         const u = (name, scheme = "http") => scheme + "://" + name + "." + arguments[0] + ":${HTTP}/" + name;
         for (const src of [u(tag + "-img"), u(tag + "-imgs", "https"), "http://127.0.0.1:${HTTP}/" + tag + "-local.png"]) { const i = d.createElement("img"); i.src = src; d.body.append(i); }
         const div = d.createElement("div"); div.style.cssText = "width:4px;height:4px;background-image:url(" + u(tag + "-bg") + ")"; d.body.append(div);
         try { new d.defaultView.WebSocket(u(tag + "-ws", "ws")); } catch (e) {}
         const ok = d.createElement("img"); ok.src = arguments[1]; d.body.append(ok);
         await new Promise((r) => (ok.complete ? r() : ok.addEventListener("load", r, { once: true })));
         out[tag] = ok.naturalWidth;
       }
       return out; })();`,
      [SFX, DATA_PNG],
    );
    expect(widths).toEqual({ sb: 1, ag: 1 });
    await sleep(3000);
    expect(net.hits.filter((h) => /^(sb|ag)-/.test(h.label) || /\/(sb|ag)-/.test(h.path)).map((h) => `${h.label} ${h.path}`)).toEqual([]);
    expect((await names()).filter((n) => /^(sb|ag)-/.test(n))).toEqual([]);
    const refusals = (await uiRefusals(m)).join("\n");
    for (const tag of ["sb", "ag"]) for (const what of [`${tag}-img.`, `${tag}-imgs.`, `127.0.0.1:${HTTP}/${tag}-local`, `${tag}-bg.`]) expect(refusals, what).toContain(what);
  });

  it("an unguarded opaque page in the sidebar loads nothing: fetch, WebSocket, sendBeacon, img, font, frame, a worker's fetch and WebSocket, WebTransport", { timeout: 120_000 }, async () => {
    const udp0 = net.udp.length;
    expect(await sidebarFrame("loads-net", "resource://ressac-test-net/loads.html")).toBe("resource://ressac-test-net/loads.html");
    // WebTransport and, in the parent process, a worker's fetch have no context: they are judged by their principal, so
    // their pages are served under a UI prefix (still unguarded, no CSP).
    const origin = await m.execute<string>(
      `return (async () => { const store = ChromeUtils.importESModule("${STORE}");
       const dir = PathUtils.join(PathUtils.profileDir, "chrome", "ressac-frames", "test-net");
       await IOUtils.makeDirectory(dir);
       for (const f of ["wt.html", "worker.html", "worker.js"]) await IOUtils.copy(PathUtils.join(arguments[0], f), PathUtils.join(dir, f));
       return "resource://ressac-frames-" + store.framesToken() + "/test-net/"; })();`,
      [pages],
    );
    expect(await sidebarFrame("wt-net", `${origin}wt.html`)).toBe(`${origin}wt.html`);
    expect(await sidebarFrame("worker-net", `${origin}worker.html`, null)).toBe(`${origin}worker.html`);
    const title = (id: string) => m.execute<string>(`return document.getElementById("ressac-sidebar").contentDocument.getElementById(arguments[0]).contentDocument.title;`, [id]);
    await expect.poll(() => title("worker-net"), { timeout: 10_000 }).toBe("worker ran");
    expect(await title("wt-net")).toBe("function");
    await sleep(3000);
    expect(net.hits.filter((h) => h.label.startsWith("tp-")).map((h) => `${h.label} ${h.method} ${h.path}`)).toEqual([]);
    // The policy refuses before the DNS (S2 p1).
    expect({ names: (await names()).filter((n) => n.startsWith("tp-")), udp: net.udp.length - udp0 }).toEqual({ names: [], udp: 0 });
    const refusals = (await uiRefusals(m)).join("\n");
    for (const what of ["tp-wfetch.", "tp-wws.", "tp-wt."]) expect(refusals, what).toContain(what);
  });

  // accueil.spec.ts:810
  it("a widget display resolves no name (dns-prefetch, preconnect, x-dns-prefetch-control, image), nor does the sidebar through a link; a tab's navigation does", { timeout: 120_000 }, async () => {
    const tcp0 = net.tcp.length;
    const body = async (id: string) => (await inWidget<string>(id, `document.body?.textContent ?? ""`)) ?? "";
    for (const id of ["dns-statique", "dns-meta", "dns-entites", "dns-entites-hex"]) await expect.poll(() => body(id), { timeout: 20_000 }).toContain("Affichage refusé");
    await expect.poll(() => inWidget("dns-script", `document.getElementById("r")?.textContent ?? ""`), { timeout: 10_000 }).toBe(DNS_SCRIPT);
    await expect.poll(() => inWidget("actus-tech", `document.querySelector("#list li")?.textContent ?? ""`), { timeout: 10_000 }).toContain("Un modèle de langage");
    // A link and a preconnect, inserted in a widget (in its process) and the sidebar; a link in the widget's child frame.
    const add = `const add = (doc, tag) => {
         const a = doc.createElement("a"); a.href = "http://preco-" + tag + "-a.${SFX}:15366/"; a.textContent = "a"; doc.body.append(a);
         const l = doc.createElement("link"); l.rel = "preconnect"; l.href = "http://preco-" + tag + "-l.${SFX}:15366"; (doc.head ?? doc.body).append(l);
       };`;
    await inFrame(
      m,
      FRAME("sonde"),
      `(async () => { ${add}
       add(document, "wd");
       // A child frame has its own opaque origin, out of the sandbox's reach: its link comes in its markup.
       const child = document.createElement("iframe"); child.srcdoc = '<a href="http://preco-wb-a.${SFX}:15366/">a</a>'; document.body.append(child);
       // Time for the child to lay its link out (no load event reaches the sandbox from an opaque child).
       await new Promise((r) => setTimeout(r, 500)); })()`,
    );
    await m.execute(`${add} add(document.getElementById("ressac-sidebar").contentDocument, "sb");`);
    // The witness: a tab's navigation resolves its name.
    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `http://temoin.${SFX}:${HTTP}/`, activate: true });
    await expect.poll(() => net.hits.some((h) => h.label === "temoin"), { timeout: 15_000 }).toBe(true);
    await closeTab("temoin.", "sonde");
    await sleep(3000);
    expect({ names: await names(), tcp: tcpSince(tcp0) }).toEqual({ names: ["temoin"], tcp: 0 });
  });

  it("the five UI frames are cut before they load", { timeout: 120_000 }, async () => {
    await expect.poll(() => existsSync(path.join(dataDir, "workspace", ".ressac", "mcp.json")), { timeout: 15_000 }).toBe(true);
    await launchAttempt(dataDir);
    await m.execute(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; await store.agent.request("sites.act", { id: "netsite", action: "open", window: store.state.windows[0].id }); })();`);
    const frames = () =>
      m.execute(
        `${CUT} const site = ${siteWindowExpr("netsite")}, app = ${appWindowExpr("essai")};
         return { sidebar: cut(document.getElementById("ressac-sidebar")), agent: cut(document.getElementById("ressac-agent")), bar: cut(site?.document.getElementById("ressac-site-bar")),
                  badge: cut(app?.document.getElementById("ressac-app-badge")), drag: document.getElementById("ressac-sidebar").contentWindow.docShell.windowDraggingAllowed };`,
      );
    const page = (p: string) => ({ dns: false, mail: true, uri: `chrome://browser/content/ressac/${p}` });
    await expect.poll(frames, { timeout: 20_000 }).toEqual({ sidebar: page("sidebar.html"), agent: page("agent.html"), bar: page("sidebar.html?site=netsite"), badge: page("sidebar.html?badge=app%3Aessai"), drag: true });
  });

  it("the badge and the site bar are cut; their loads are refused", { timeout: 60_000 }, async () => {
    const badge = `${appWindowExpr("essai")}.document.getElementById("ressac-app-badge")`;
    const size = () => m.execute<number[]>(`const r = ${badge}.getBoundingClientRect(); return [r.width, r.height];`);
    await expect.poll(() => m.execute(`return !!${badge}.contentDocument.querySelector('[data-testid="ressac-pill"]');`), { timeout: 15_000 }).toBe(true);
    // 88×28: 48×28 and the agent's access button (apps-badge.e2e.ts).
    await expect.poll(size, { timeout: 10_000 }).toEqual([88, 28]);
    await m.execute(
      `for (const [tag, d] of [["bar", ${siteWindowExpr("netsite")}.document.getElementById("ressac-site-bar").contentDocument], ["badge", ${badge}.contentDocument]]) {
         const i = d.createElement("img"); i.style.cssText = "position:absolute;width:1px;height:1px"; i.src = "http://" + tag + "-img." + arguments[0] + ":${HTTP}/" + tag + "-img.png"; d.body.append(i);
       }`,
      [SFX],
    );
    await sleep(3000);
    expect(net.hits.filter((h) => /^(bar|badge)-img/.test(h.label)).map((h) => `${h.label} ${h.path}`)).toEqual([]);
    expect((await names()).filter((n) => /^(bar|badge)-img/.test(n))).toEqual([]);
    const refusals = (await uiRefusals(m)).join("\n");
    for (const what of ["bar-img.", "badge-img."]) expect(refusals, what).toContain(what);
    expect(await size()).toEqual([88, 28]);
    await callTool(dataDir, "stop_app", { folder: "essai" }).catch(() => {});
    await m.execute(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; for (const id of store.sites.openIds()) await store.sites.close(id); })();`);
  });

  // accueil.spec.ts:883
  it("a favicon shows in the tab list, fetched by the tab, never by the UI (the UI has no network)", { timeout: 60_000 }, async () => {
    const refused0 = (await uiRefusals(m)).length;
    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `http://${host("icone")}/avec-icone`, activate: true });
    let id = "";
    await expect.poll(async () => (id = Object.entries((await state(m)).tabs).find(([, o]) => o.url.includes("/avec-icone"))?.[0] ?? ""), { timeout: 10_000 }).not.toBe("");
    const icon = () =>
      m.execute<{ src: string; width: number } | null>(
        `const i = document.getElementById("ressac-sidebar").contentDocument.querySelector(arguments[0]); return i ? { src: i.src, width: i.complete ? i.naturalWidth : 0 } : null;`,
        [`[data-testid="tab-${id}"] img`],
      );
    await expect.poll(async () => (await icon())?.width, { timeout: 15_000 }).toBe(1);
    const src = (await icon())!.src;
    expect(src.startsWith("data:") || (src.startsWith("moz-remote-image:") && new URL(src).searchParams.get("url")!.startsWith("data:")), src.slice(0, 80)).toBe(true);
    expect(net.hits.some((h) => h.label === "icone" && h.path === "/icone.png")).toBe(true);
    await closeTab("/avec-icone", "sonde");
    expect(await refusalsSince(refused0)).toEqual([]);
  });

  it("the tabs and the agent's reads keep their network: a tab's image, fetch, WebSocket and WebRTC TURN/TCP reach the local servers, and an invisible read returns the page", { timeout: 120_000 }, async () => {
    const refused0 = (await uiRefusals(m)).length;
    const windowId = (await state(m)).windows[0]!.id;
    const seen = (name: string) => net.hits.filter((h) => h.label === name).map((h) => `${h.method} ${h.path}`);
    await dispatch(m, { type: "openTab", windowId: windowId, url: `http://${host("tab-page")}/page`, activate: true });
    try {
      await expect
        .poll(() => seen("tab-page"), { timeout: 15_000 })
        .toEqual(expect.arrayContaining(["GET /page", "GET /s2/witness/img", "GET /s2/witness/fetch", "UPGRADE /s2/witness/ws", "POST /s2/witness/beacon"]));
    } finally {
      await closeTab("tab-page.", "sonde");
    }
    const tcp0 = net.tcp.length;
    const udp0 = net.udp.length;
    await dispatch(m, { type: "openTab", windowId: windowId, url: `http://${host("tab-rtc")}/rtc`, activate: true });
    try {
      // Waits for the servers themselves: the page's call keeps gathering (and its connections open) until its tab closes.
      await expect.poll(() => ({ tcp: tcpSince(tcp0) > 0, udp: net.udp.length - udp0 > 0 }), { timeout: 20_000 }).toEqual({ tcp: true, udp: true });
    } finally {
      // Closed even on failure: an open tab hides the home and every widget test after this one would fail too.
      await closeTab("tab-rtc.", "sonde");
    }
    const read = await m.execute<string>(
      `return (async () => { const s = await ChromeUtils.importESModule("${STORE}").ready;
       try { return (await s.readPage(arguments[0], { profile: null, localAddresses: true })).title; } catch (e) { return "ERR " + e; } })();`,
      [`http://${host("lu")}/page`],
    );
    expect(read).toBe("page");
    expect(seen("lu")).toContain("GET /page");
    expect(await refusalsSince(refused0)).toEqual([]);
  });

  // Review Focus 1: the views are content <browser>s, never the UI's; the site bar and its home stay cut.
  it("a site app's view and an agent app's window keep their network; no load of theirs is refused", { timeout: 120_000 }, async () => {
    const refused0 = (await uiRefusals(m)).length;
    const hits0 = net.hits.length;
    await m.execute(
      `return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready;
       for (const id of ["netsite", "netsite-accueil"]) await store.agent.request("sites.act", { id, action: "open", window: store.state.windows[0].id }); })();`,
    );
    await expect
      .poll(() => net.hits.slice(hits0).filter((h) => h.label === "netsite.localhost").map((h) => `${h.method} ${h.path}`), { timeout: 20_000 })
      .toEqual(expect.arrayContaining(["GET /page", "GET /s2/witness/img", "GET /s2/witness/fetch", "UPGRADE /s2/witness/ws"]));
    const port = await launchAttempt(dataDir);
    await waitFor(m, `const b = ${appWindowExpr("essai")}?.gBrowser.selectedBrowser; return b && !b.webProgress.isLoadingDocument ? b.currentURI.spec : "";`, (v: string) => v.includes(`localhost:${port}`), 20_000);
    expect(await inAppView<number>(m, "essai", "return fetch('/').then((r) => r.status)")).toBe(200);
    // The opaque home of netsite-accueil is the UI's: its image is refused.
    const home = siteHomeBrowser("netsite-accueil");
    await expect.poll(() => inHomeFrame(m, home, `return document.getElementById("h")?.textContent ?? null;`), { timeout: 15_000 }).toBe("accueil");
    await inHomeFrame(m, home, `const i = document.createElement("img"); i.src = args[0]; document.body.append(i); return 1;`, [`http://${host("netsite-img")}/x.png`]);
    await sleep(3000);
    expect(net.hits.filter((h) => h.label === "netsite-img")).toEqual([]);
    expect((await names()).filter((n) => n === "netsite-img")).toEqual([]);
    const refused = (await uiRefusals(m)).slice(refused0);
    // Measured: the home's own CSP (img-src data: <frames origin>/sites/<copy>/) refuses it before the content policy is asked.
    expect((await consoleWith(m, "netsite-img.")).join("\n")).toMatch(/Content-Security-Policy.*netsite-img\..*img-src data: resource:\/\/ressac-frames-[0-9a-f]{16}\/sites\/netsite-accueil-/);
    // The home is a frame browser of the frames' process (checked here by its remoteType only).
    expect(await m.execute(`return (${home}).remoteType;`)).toMatch(/^webIsolated=resource:\/\/ressac-frames-/);
    expect(refused.filter((r) => /netsite(-accueil)?\.localhost|\/page|localhost:/.test(r) || r.includes(`:${port}`))).toEqual([]);
    await callTool(dataDir, "stop_app", { folder: "essai" }).catch(() => {});
    await m.execute(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; for (const id of store.sites.openIds()) await store.sites.close(id); })();`);
  });

  it("an action's images and an add-on install are not the UI's", { timeout: 60_000 }, async () => {
    const refused0 = (await uiRefusals(m)).length;
    // An action's result image: the product's channel (anonymous, a content principal, no document).
    const image = await m.execute<number | null>(
      `return (async () => { const s = await ChromeUtils.importESModule("${STORE}");
       const r = await s.loadImage(s.containerRequests(0, { anonymous: true }), arguments[0], { allowed: () => true, cookies: false, max: 100000 });
       return r ? r.body.length : null; })();`,
      [`http://${host("act-img")}/s2/witness/img`],
    );
    expect(image).toBeGreaterThan(0);
    const addon = await m.execute<string>(
      `return (async () => { const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
       const i = await AddonManager.getInstallForURL(arguments[0], { telemetryInfo: { source: "test" } });
       try { await i.install(); return "installed"; } catch (e) { return "failed: " + i.error; } })();`,
      [`http://${host("addon")}/x.xpi`],
    );
    // The fake .xpi fails once downloaded.
    expect(addon).toMatch(/^failed/);
    expect(net.hits.filter((h) => h.label === "act-img" || h.label === "addon").map((h) => `${h.label} ${h.path}`)).toEqual(expect.arrayContaining(["act-img /s2/witness/img", "addon /x.xpi"]));
    expect(await refusalsSince(refused0)).toEqual([]);
  });

  it("a widget re-rendered or added after the sidebar loaded inherits the cut", { timeout: 120_000 }, async () => {
    const tcp0 = net.tcp.length;
    const src0 = await inWidget<string>("sonde", "document.documentURI");
    widgetFiles(dataDir, "sonde", DISPLAY.replace("<pre", '<p id="v2">v2</p><pre'));
    await expect.poll(() => inWidget("sonde", `!!document.getElementById("v2")`), { timeout: 20_000 }).toBe(true);
    expect(await inWidget("sonde", "document.documentURI")).not.toBe(src0);
    widgetFiles(dataDir, "tard", DISPLAY);
    await expect.poll(() => inWidget("tard", `!!document.getElementById("donnees")`), { timeout: 20_000 }).toBe(true);
    // Both in the frames' process, whose policy refuses before any name lookup (frame-actor.ts).
    for (const id of ["sonde", "tard"])
      await inFrame(m, FRAME(id), `(() => { const a = document.createElement("a"); a.href = "http://rr-${id}.${SFX}:15366/"; a.textContent = "rr"; document.body.append(a); })()`);
    expect(await m.execute(`return [${widgetFrame("sonde")}, ${widgetFrame("tard")}].map((b) => b.remoteType.startsWith("webIsolated=resource://ressac-frames-"));`)).toEqual([true, true]);
    await sleep(3000);
    expect({ names: (await names()).filter((n) => n.startsWith("rr-")), tcp: tcpSince(tcp0) }).toEqual({ names: [], tcp: 0 });
  });

  it("a real press on a widget's link resolves no name and opens no connection; its click still opens the link in a tab", { timeout: 120_000 }, async () => {
    const tcp0 = net.tcp.length;
    await expect.poll(() => inWidget("lien", `!!document.getElementById("l")`), { timeout: 15_000 }).toBe(true);
    expect(await press("lien", "#l", true)).toBe("browser");
    await expect.poll(() => net.hits.some((h) => h.label === "ouvert" && h.path === "/ouvert"), { timeout: 15_000 }).toBe(true);
    const opened = await tabUrls();
    await closeTab("/ouvert", "lien");
    expect(opened).toContain(`http://${host("ouvert")}/ouvert`);
    // An SVG link, pressed and released away from it.
    expect(await press("lien", "#s", false)).toBe("browser");
    await sleep(3000);
    expect({ names: (await names()).filter((n) => n === "md" || n === "md-svg"), tcp: tcpSince(tcp0) }).toEqual({ names: [], tcp: 0 });
  });

  it("a press on shadow content inside a widget's link (open, closed, nested, slotted, very deep) resolves no name and opens no connection", { timeout: 60_000 }, async () => {
    const tcp0 = net.tcp.length;
    await expect.poll(() => inWidget("ombre", `!!document.getElementById("h-nested")`), { timeout: 15_000 }).toBe(true);
    for (const id of ["#h-open", "#h-closed", "#h-nested", "#h-slot b", "#h-deep-in"]) expect(await press("ombre", id, false), id).toBe("browser");
    await sleep(3000);
    expect({ names: (await names()).filter((n) => n.startsWith("sh-")), tcp: tcpSince(tcp0) }).toEqual({ names: [], tcp: 0 });
  });

  it("hovering a widget's link resolves no name and opens no connection", { timeout: 60_000 }, async () => {
    const tcp0 = net.tcp.length;
    await m.execute(`return (async () => { ${widgetFrame("ombre")}.scrollIntoView({ block: "center" }); await new Promise((r) => document.getElementById("ressac-sidebar").contentWindow.requestAnimationFrame(r)); })();`);
    await m.execute(
      `return (async () => { const sb = document.getElementById("ressac-sidebar"), ui = sb.contentWindow, f = ${widgetFrame("ombre")};
       const r = f.getBoundingClientRect(), q = arguments[0];
       for (let i = 0; i < 10; i++) { ui.synthesizeMouseEvent("mousemove", r.left + q.left + 2 + i * 4, r.top + q.top + q.height / 2, {}); await new Promise((ok) => setTimeout(ok, 100)); }
       ui.synthesizeMouseEvent("mousemove", 2, 2, {}); })();`,
      [await rectIn("ombre", "#hv")],
    );
    await sleep(3000);
    expect({ names: (await names()).filter((n) => n === "hover"), tcp: tcpSince(tcp0) }).toEqual({ names: [], tcp: 0 });
  });

  it("a plain link in a widget, clicked, leaves the frame on its copy", { timeout: 60_000 }, async () => {
    expect(await press("lien", "#p", true)).toBe("browser");
    await sleep(3000);
    expect(net.hits.filter((h) => h.label === "plain")).toEqual([]);
    expect(await inWidget("lien", "document.documentURI")).toMatch(/^resource:\/\/ressac-frames-[0-9a-f]{16}\/widgets\/lien\//);
    // Measured: the parent's net refuses the frame's top-level navigation as a document load (type 6; its policy and its
    // observer log the same line).
    expect(await consoleWith(m, "plain.")).toEqual([expect.stringMatching(/^\[ui-network\] refused 6 http:\/\/plain\./)]);
  });

  it("Enter on a focused widget link resolves no name, opens no connection, and opens a tab only by today's gesture rule", { timeout: 60_000 }, async () => {
    const tcp0 = net.tcp.length;
    // The keyboard reaches a widget only through a click (its code cannot focus it): a press on an empty corner (the resize handle is at the right), then
    // the last press is older than a gesture's 1.5 s.
    await m.execute(`document.getElementById("ressac-sidebar").contentWindow.focus();`);
    await sleep(300);
    await m.execute(
      `return (async () => { const sb = document.getElementById("ressac-sidebar"), ui = sb.contentWindow, f = ${widgetFrame("lien")};
       f.scrollIntoView({ block: "center" });
       await new Promise((r) => ui.requestAnimationFrame(r));
       const r = f.getBoundingClientRect();
       for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, r.left + 6, r.bottom - 6, { button: 0, clickCount: 1 }); })();`,
    );
    await expect.poll(() => m.execute(`return document.getElementById("ressac-sidebar").contentDocument.activeElement === ${widgetFrame("lien")};`), { timeout: 5000 }).toBe(true);
    await sleep(2000);
    const enterOn = async (sel: string) => {
      const focused = await inFrame<string | null>(m, FRAME("lien"), `(() => { document.querySelector(${JSON.stringify(sel)}).focus(); return document.activeElement?.id ?? null; })()`);
      await m.execute(
        `const sb = document.getElementById("ressac-sidebar");
         const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
         tip.beginInputTransactionForTests(sb.contentWindow);
         const ev = new sb.contentWindow.KeyboardEvent("", { key: "Enter", code: "Enter" });
         tip.keydown(ev);
         tip.keyup(ev);`,
      );
      return focused;
    };
    expect(await enterOn("#l")).toBe("l");
    await expect.poll(() => inWidget("lien", `document.getElementById("l")?.dataset.clicks ?? "0"`), { timeout: 10_000 }).toBe("1");
    await expect.poll(async () => (await consoleWith(m, "widget link ignored")).length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await enterOn("#p")).toBe("p");
    await sleep(3000);
    expect((await tabUrls()).filter((u) => u.includes("/ouvert"))).toEqual([]);
    expect(net.hits.filter((h) => h.label === "plain")).toEqual([]);
    expect({ names: (await names()).filter((n) => n === "md" || n === "plain"), tcp: tcpSince(tcp0) }).toEqual({ names: [], tcp: 0 });
  });

  // A pressed link's speculative connect is refused in system UI documents too (the History page's links: a click
  // still opens its tab, history.e2e.ts « ⌘Y lists visited pages; a click reopens one »).
  it("a press on a link of a system document resolves no name and opens no connection", { timeout: 60_000 }, async () => {
    const tcp0 = net.tcp.length;
    const http0 = net.httpConns();
    const hit = await m.execute(
      `return (async () => { const sb = document.getElementById("ressac-sidebar"), d = sb.contentDocument, ui = sb.contentWindow;
       const a = d.createElement("a"); a.id = "sys-md"; a.href = "http://sys-md." + arguments[0] + ":15366/"; a.textContent = "sys sys sys";
       a.style.cssText = "position:fixed;left:20px;top:200px;z-index:2147483647;font-size:20px;background:white";
       d.body.append(a);
       await new Promise((r) => ui.requestAnimationFrame(r));
       const q = a.getBoundingClientRect(), x = q.left + 10, y = q.top + q.height / 2;
       const hit = d.elementFromPoint(x, y)?.id ?? null;
       ui.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
       ui.synthesizeMouseEvent("mouseup", 2, 2, { button: 0, clickCount: 1 });
       a.remove();
       // A link around a closed shadow root's content.
       const s = d.createElement("a"); s.href = "http://sys-sh." + arguments[0] + ":15366/"; s.style.cssText = a.style.cssText;
       const h = d.createElement("span"); s.append(h); d.body.append(s);
       const b = d.createElement("b"); b.textContent = "shadow shadow"; h.attachShadow({ mode: "closed" }).append(b);
       await new Promise((r) => ui.requestAnimationFrame(r));
       const p = h.getBoundingClientRect(), sx = p.left + 10, sy = p.top + p.height / 2;
       ui.synthesizeMouseEvent("mousedown", sx, sy, { button: 0, clickCount: 1 });
       ui.synthesizeMouseEvent("mouseup", 2, 2, { button: 0, clickCount: 1 });
       s.remove();
       return hit; })();`,
      [SFX],
    );
    expect(hit).toBe("sys-md");
    await sleep(3000);
    expect({ names: (await names()).filter((n) => n === "sys-md" || n === "sys-sh"), tcp: tcpSince(tcp0), httpConns: net.httpConns() - http0 }).toEqual({ names: [], tcp: 0, httpConns: 0 });
  });

  // Last: a navigation that went through would take the UI away. Their parent is browser.xhtml: the net judges them by the
  // target context's mark (test/ui-network.test.ts), but browser.xhtml's CSP refuses first, so this measures the CSP.
  it("the sidebar and the agent panel navigating themselves to the web reach no server", { timeout: 60_000 }, async () => {
    const tcp0 = net.tcp.length;
    const http0 = net.httpConns();
    // Refused at once (NS_ERROR_CONTENT_BLOCKED, thrown by the setter): what counts is that nothing reaches the server.
    for (const [tag, id] of [["ag", "ressac-agent"], ["sb", "ressac-sidebar"]])
      await m.execute(`try { document.getElementById(arguments[0]).contentWindow.location.href = arguments[1]; } catch (e) {}`, [id, `http://${host(`selfnav-${tag}`)}/selfnav-${tag}`]);
    await sleep(3000);
    expect(net.hits.filter((h) => h.label.startsWith("selfnav-")).map((h) => `${h.label} ${h.path}`)).toEqual([]);
    expect({ names: (await names()).filter((n) => n.startsWith("selfnav-")), tcp: tcpSince(tcp0), httpConns: net.httpConns() - http0 }).toEqual({ names: [], tcp: 0, httpConns: 0 });
    expect(await m.execute(`return ["ressac-agent", "ressac-sidebar"].map((id) => document.getElementById(id).contentDocument?.documentURI);`)).toEqual([
      "chrome://browser/content/ressac/agent.html",
      "chrome://browser/content/ressac/sidebar.html",
    ]);
    // Measured: browser.xhtml's CSP (frame-src chrome:) refuses both before the content policy or the observer is asked.
    const csp = (await consoleWith(m, "selfnav-")).join("\n");
    for (const tag of ["ag", "sb"]) expect(csp, tag).toMatch(new RegExp(`Content-Security-Policy.*selfnav-${tag}\\..*frame-src chrome:`));
  });
});
