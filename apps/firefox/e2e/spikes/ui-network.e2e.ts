import dgram from "node:dgram";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testActor } from "../agent-extensions";
import { dispatch, state, waitFor, waitReady } from "../firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "../launch";
import type { Marionette } from "../marionette";
import { writeSite } from "../sites";

// Spikes S1–S3 of docs/superpowers/specs/2026-11-08-webaios-firefox-reseau-interfaces-design.md (note:
// docs/superpowers/notes/2026-11-08-reseau-interfaces-spikes.md). The spec's mechanisms are prototyped in
// ui-network-spike.sys.mjs, loaded in the parent from this folder (no build:ui), switched layer by layer.
// Measures are printed as `[spike] <what>: <JSON>`; the security lines are asserted at the end of each spike.
// Rerun with WEBAIOS_SPIKE=1 (WEBAIOS_SPIKE_LOOPBACK=1: media.peerconnection.ice.loopback, so the UDP witness counts).
//
// Nothing reaches the real internet: every name is under SFX and network.dns.native-is-localhost answers 127.0.0.1
// for any name (IPv4 only); the hostResolver log (MOZ_LOG) shows which names were asked. Ports: 15368 (HTTP/WS with a
// log), 15369 (a TCP counter: fake TURN and the hints' target; and a UDP counter: fake STUN).

// WEBAIOS_SPIKE_OUT=<file> also appends each note there (vitest hides a passed test's console).
const note = (what: string, v: unknown) => {
  const line = `[spike] ${what}: ${JSON.stringify(v)}`;
  console.log(line);
  if (process.env.WEBAIOS_SPIKE_OUT) appendFileSync(process.env.WEBAIOS_SPIKE_OUT, line + "\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODULE = "resource://webaios-spike-net/ui-network-spike.sys.mjs";
const SFX = `w${Date.now()}.webaios-test.example`;
const HTTP = 15368;
const RAW = 15369;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

type Hit = { label: string; path: string; method: string; at: number };
const hits: Hit[] = [];
const tcp: number[] = [];
const udp: number[] = [];
let httpConns = 0;
const label = (h: string | undefined) => String(h ?? "").replace(/:\d+$/, "").replace(`.${SFX}`, "");

/** The page-side WebRTC probe: an offer with a fake TURN/TCP and STUN/UDP under names that carry `tag`. */
const RTC = `async function rtc(C, tag) {
  const t0 = performance.now();
  const out = { tag, type: typeof C };
  if (typeof C === "string") out.error = C.slice(0, 160);
  if (typeof C !== "function") return out;
  let pc;
  try {
    pc = new C({ iceServers: [{ urls: "turn:turn-" + tag + ".${SFX}:${RAW}?transport=tcp", username: "u", credential: "p" }, { urls: "stun:stun-" + tag + ".${SFX}:${RAW}" }] });
    pc.createDataChannel("d");
    const offer = await Promise.race([pc.createOffer(), new Promise((_, r) => setTimeout(() => r({ name: "pending" }), 3000))]);
    out.offerMs = Math.round(performance.now() - t0);
    await pc.setLocalDescription(offer);
    await new Promise((r) => { const t = setTimeout(r, 3000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); r(); } }; });
    out.result = "gathered:" + pc.iceGatheringState;
    out.candidates = (pc.localDescription.sdp.match(/typ [a-z]+/g) || []).map((c) => c.slice(4));
  } catch (e) {
    out.result = (e && e.name) || String(e);
    out.message = String((e && e.message) || "").slice(0, 120);
  }
  out.ms = Math.round(performance.now() - t0);
  try { pc && pc.close(); } catch (e) {}
  return out;
}`;
/** Runs rtc on the page itself, a fresh about:blank child's constructor, and a srcdoc child (each writes its own #r). */
const rtcPage = (tag: string) => `<!doctype html><meta charset="utf-8"><title>rtc</title><pre id="r">lancé</pre><script>${RTC}
(async () => {
  const res = [];
  res.push(await rtc(window.RTCPeerConnection, "${tag}-main"));
  const b = document.createElement("iframe");
  document.body.append(b);
  let C;
  try { C = b.contentWindow.RTCPeerConnection; } catch (e) { C = "access " + e; }
  res.push(await rtc(C, "${tag}-blank"));
  const s = document.createElement("iframe");
  try { s.srcdoc = '<pre id="r">lancé</pre><scr' + 'ipt>' + rtc.toString() + ' rtc(window.RTCPeerConnection, "${tag}-srcdoc").then((o) => { document.getElementById("r").textContent = JSON.stringify(o); });</scr' + 'ipt>'; } catch (e) { res.push({ tag: "${tag}-srcdoc", error: "srcdoc " + String(e).slice(0, 120) }); }
  document.body.append(s);
  document.getElementById("r").textContent = JSON.stringify(res);
})();
</script>`;

/** S1: hints written statically in a served widget display (no <link>: the sanitizer would refuse the display). */
const hintsWidget = (p: string) => `<!doctype html><meta charset="utf-8"><title>sonde</title><p id="t">sonde ${p}</p>
<a href="http://${p}-ws-a.${SFX}:${RAW}/">a</a>
<img src="http://${p}-ws-img.${SFX}:${HTTP}/i.png">
<iframe src="http://${p}-ws-fr.${SFX}:${HTTP}/fr"></iframe>
<video poster="http://${p}-ws-pos.${SFX}:${HTTP}/p.png"></video>
<div style="width:4px;height:4px;background:url(http://${p}-ws-bg.${SFX}:${HTTP}/b.png)"></div>
<script>const a = document.createElement("a"); a.href = "http://${p}-wsj-a.${SFX}:${RAW}/"; a.textContent = "j"; document.body.append(a);</script>`;
/** S1: the same hints in an unsanitized test page (static <link>s, read by the speculative parser too). */
const hintsPage = (p: string) => `<!doctype html><meta charset="utf-8"><title>tp</title>
<link rel="dns-prefetch" href="//${p}-tp-dnsp.${SFX}">
<link rel="preconnect" href="http://${p}-tp-preco.${SFX}:${RAW}">
<link rel="prefetch" href="http://${p}-tp-pref.${SFX}:${HTTP}/x">
<link rel="preload" as="image" href="http://${p}-tp-prel.${SFX}:${HTTP}/x.png">
<a href="http://${p}-tp-a.${SFX}:${RAW}/">a</a>`;
/** S2: the widget display has a static web frame, navigates a child frame, then itself. */
const loadsWidget = (p: string) => `<!doctype html><meta charset="utf-8"><title>sonde</title><p id="t">sonde ${p}</p>
<iframe src="http://${p}-wd-sfr.${SFX}:${HTTP}/s2/${p}-wd/sfr"></iframe>
<script>
const f = document.createElement("iframe");
document.body.append(f);
try { f.contentWindow.location.href = "http://${p}-wd-nav.${SFX}:${HTTP}/s2/${p}-wd/nav"; } catch (e) { document.getElementById("t").dataset.nav = String(e).slice(0, 80); }
// The widget's own script, through a fresh about:blank child (the guard patched only this window's prototypes).
const b = document.createElement("iframe");
document.body.append(b);
try { const i = b.contentDocument.createElement("iframe"); i.src = "http://${p}-wd-bfr.${SFX}:${HTTP}/s2/${p}-wd/bfr"; b.contentDocument.body.append(i); } catch (e) { document.getElementById("t").dataset.bfr = String(e).slice(0, 80); }
setTimeout(() => { try { location.href = "http://${p}-wd-self.${SFX}:${HTTP}/s2/${p}-wd/self"; } catch (e) { document.getElementById("t").dataset.self = String(e).slice(0, 80); } }, 2500);
</script>`;
/** S2: the unguarded test page also navigates a child frame. */
const loadsPage = (p: string, d: string) => `<!doctype html><meta charset="utf-8"><title>tp</title><p>tp</p>
<script>
const f = document.createElement("iframe");
document.body.append(f);
try { f.contentWindow.location.href = "http://${p}-${d}-nav.${SFX}:${HTTP}/s2/${p}-${d}/nav"; } catch (e) {}
</script>`;

function widgetFiles(dataDir: string, id: string, display: string): void {
  const dir = path.join(dataDir, "espace/accueil/widgets", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "widget.json"),
    JSON.stringify({ nom: id, description: "", tailles: { min: { l: 2, h: 1 }, max: { l: 6, h: 4 }, defaut: { l: 3, h: 2 } }, sources: { compte: [], publiques: [], web: false } }),
  );
  writeFileSync(path.join(dir, "affichage.html"), display);
}

describe.skipIf(!process.env.WEBAIOS_SPIKE)("the UI's network, spikes S1–S3", () => {
  const servers: { close(): void }[] = [];
  let w: LaunchedWebAiOs;
  let m: Marionette;
  let dataDir: string;
  let profile: string;
  let logDir: string;
  let pages: string;

  /** Chrome body with N = the spike module, sidebar/agent = the UI iframes, sb = the sidebar's document. */
  const chrome = <T = any>(body: string, args: unknown[] = []) =>
    m.execute<T>(
      `return (async () => { const N = ChromeUtils.importESModule("${MODULE}");
       const sidebar = document.getElementById("webaios-sidebar"), agent = document.getElementById("webaios-agent"), sb = sidebar.contentDocument;
       const widget = (id) => sb.querySelector('[data-testid="widget-' + id + '"] iframe');
       ${body} })();`,
      args,
    );
  /** The names asked of the resolver (without SFX), in order, from every process's log. */
  async function names(): Promise<string[]> {
    let all = "";
    for (const f of await readdir(logDir)) all += await readFile(path.join(logDir, f), "utf8").catch(() => "");
    const out = new Set<string>();
    for (const [, h] of all.matchAll(/Resolving host \[([^\]]+)\]/g)) if (h!.endsWith(`.${SFX}`)) out.add(h!.slice(0, -SFX.length - 1));
    return [...out];
  }
  const counters = () => ({ tcp: tcp.length, udp: udp.length, http: httpConns, hits: hits.length });
  const delta = (a: ReturnType<typeof counters>) => {
    const b = counters();
    return { tcp: b.tcp - a.tcp, udp: b.udp - a.udp, httpConns: b.http - a.http, hits: hits.slice(a.hits).map((h) => `${h.label} ${h.method} ${h.path}`) };
  };
  /** Rewrites a widget's display and waits until its frame shows `marker`. */
  async function display(id: string, html: string, marker: string): Promise<void> {
    widgetFiles(dataDir, id, html);
    await waitFor(m, `const f = document.getElementById("webaios-sidebar").contentDocument.querySelector('[data-testid="widget-${id}"] iframe'); return f?.contentDocument?.body?.textContent ?? "";`, (t: string) => t.includes(marker), 20_000);
  }
  async function closeTabs(): Promise<void> {
    for (const id of Object.keys((await state(m)).onglets)) await dispatch(m, { type: "fermerOnglet", id } as never);
  }
  async function openTab(url: string): Promise<void> {
    await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url } as never);
    await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`, (v) => v === true, 15_000);
  }

  beforeAll(async () => {
    const http: Server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      hits.push({ label: label(req.headers.host), path: u.pathname, method: req.method ?? "GET", at: Date.now() });
      const html = (s: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(s);
      if (u.pathname === "/tab-s1")
        return html(`<title>tab</title><a href="http://tab-a.${SFX}:${RAW}/">a</a><link rel="dns-prefetch" href="//tab-dnsp.${SFX}"><link rel="preconnect" href="http://tab-preco.${SFX}:${RAW}">`);
      if (u.pathname === "/page")
        return html(`<title>page</title><img src="/s2/witness/img"><script>fetch("/s2/witness/fetch").catch(() => {}); try { new WebSocket("ws://" + location.host + "/s2/witness/ws"); } catch (e) {} navigator.sendBeacon("/s2/witness/beacon", "x");</script>`);
      if (u.pathname === "/rtc") return html(`<title>rtc</title><script>${RTC}\nrtc(window.RTCPeerConnection, "tab-s3").then((o) => { document.title = JSON.stringify(o); });</script>`);
      if (u.pathname.endsWith("img") || u.pathname.endsWith(".png") || u.pathname.endsWith("remote")) return res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
      if (u.pathname.startsWith("/s2/")) return html("<title>s2</title>");
      res.writeHead(404).end();
    });
    http.on("connection", () => httpConns++);
    http.on("upgrade", (req, socket) => {
      hits.push({ label: label(req.headers.host), path: new URL(req.url ?? "/", "http://x").pathname, method: "UPGRADE", at: Date.now() });
      socket.destroy();
    });
    await new Promise<void>((ok, ko) => http.once("error", ko).listen(HTTP, "127.0.0.1", ok));
    servers.push({ close: () => (http.closeAllConnections(), http.close()) });
    const raw = net.createServer((s) => {
      tcp.push(Date.now());
      s.on("error", () => {});
      setTimeout(() => s.destroy(), 300);
    });
    await new Promise<void>((ok, ko) => raw.once("error", ko).listen(RAW, "127.0.0.1", ok));
    servers.push(raw);
    const stun = dgram.createSocket("udp4");
    stun.on("message", () => udp.push(Date.now()));
    await new Promise<void>((ok) => stun.bind(RAW, "127.0.0.1", ok));
    servers.push(stun);

    dataDir = await mkdtemp(path.join(os.tmpdir(), "webaios-data-"));
    profile = await mkdtemp(path.join(os.tmpdir(), "webaios-firefox-"));
    logDir = await mkdtemp(path.join(os.tmpdir(), "webaios-dnslog-"));
    pages = await mkdtemp(path.join(os.tmpdir(), "webaios-spike-pages-"));
    for (const p of ["a", "b", "c"]) writeFileSync(path.join(pages, `s1-${p}.html`), hintsPage(p));
    for (const p of ["p0", "p1", "p2"]) for (const d of ["cp", "tp"]) writeFileSync(path.join(pages, `s2-${p}-${d}.html`), loadsPage(p, d));
    for (const p of ["s3o", "s3d"]) writeFileSync(path.join(pages, `rtc-${p}.html`), rtcPage(`${p}-tp`));
    // The widget folder exists: no starter widget is seeded, so no harvest runs.
    widgetFiles(dataDir, "sonde", hintsWidget("a"));
    writeSite(dataDir, "netsite", {
      declaration: { nom: "Netsite", adresse: `http://netsite.localhost:${HTTP}/page`, domaines: ["netsite.localhost"] },
      fichiers: { "accueil/index.html": '<!doctype html><meta charset="utf-8"><p id="h">accueil</p>' },
    });
    const actor = testActor(profile);
    w = await launchWebAiOs({
      dataDir,
      profile,
      // ice.loopback: lets ICE send to the loopback STUN witness (spike only; measured with and without in the note).
      prefs: { ...actor.prefs, "network.dns.native-is-localhost": true, "network.trr.mode": 5, ...(process.env.WEBAIOS_SPIKE_LOOPBACK ? { "media.peerconnection.ice.loopback": true } : {}) },
      env: { ...actor.env, WEBAIOS_TEST_ADRESSES_LOCALES: "1", MOZ_LOG: "sync,nsHostResolver:5", MOZ_LOG_FILE: path.join(logDir, "moz.log") },
    });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    await m.execute(
      `const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
       const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
       res.setSubstitution("webaios-spike-net", Services.io.newFileURI(new FileUtils.File(arguments[0])));
       for (const n of ["webaios-spike-page", "webaios-composant-spike", "webaios-site-spike"]) res.setSubstitution(n, Services.io.newFileURI(new FileUtils.File(arguments[1])));`,
      [import.meta.dirname, pages],
    );
    await chrome("N.install();");
    await display("sonde", hintsWidget("a"), "sonde a");
    note("media.navigator.permission.disabled", await m.execute("return Services.prefs.getBoolPref('media.navigator.permission.disabled', null);"));
  }, 120_000);
  afterAll(async () => {
    await w?.close();
    for (const s of servers) s.close();
    for (const d of [dataDir, profile, logDir, pages]) if (d) await rm(d, { recursive: true, force: true });
  });

  /** Inserts S1's hints in every UI document; returns what each insertion said, then the names asked and the TCP count. */
  async function s1Phase(p: string) {
    const before = counters();
    const inserted = await chrome(
      `const p = arguments[0], sfx = arguments[1], out = {}, frames = {};
       const step = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = "ERR " + String(e).slice(0, 100); } };
       const wd = widget("sonde").contentDocument;
       await step("sb", () => N.insertHints(sb, p + "-sb", sfx));
       await step("ag", () => N.insertHints(agent.contentDocument, p + "-ag", sfx));
       await step("wd", () => N.insertHints(wd, p + "-wd", sfx));
       await step("wb", async () => { frames.blank = await N.addFrame(wd); return N.insertHints(frames.blank.contentDocument, p + "-wb", sfx); });
       await step("wsd", async () => { frames.sd = await N.addFrame(wd, { srcdoc: "<p>s</p>" }); return [frames.sd.contentDocument?.documentURI, N.insertHints(frames.sd.contentDocument, p + "-wsd", sfx)]; });
       await step("tp", async () => { frames.tp = await N.addFrame(sb, { sandbox: "allow-scripts" }, "resource://webaios-spike-page/s1-" + p + ".html"); return [frames.tp.contentDocument?.documentURI, N.insertHints(frames.tp.contentDocument, p + "-tpd", sfx)]; });
       await step("flags", () => ({ sidebar: N.flags(sidebar), agent: N.flags(agent), widget: N.flags(widget("sonde")), blank: frames.blank && N.flags(frames.blank), tp: frames.tp && N.flags(frames.tp) }));
       return out;`,
      [p, SFX],
    );
    await sleep(3000);
    return { inserted, names: (await names()).filter((n) => n.startsWith(`${p}-`)), ...delta(before) };
  }

  it("S1: DNS and anticipated connections, with and without the two docShell flags", { timeout: 240_000 }, async () => {
    const a = await s1Phase("a");
    note("S1 a, no flags", a);

    // b: the flags put on the loaded sidebar and agent, without reloading them.
    await chrome("N.cut(sidebar); N.cut(agent);");
    await display("sonde", hintsWidget("b"), "sonde b");
    const b = await s1Phase("b");
    note("S1 b, flags on the loaded frames", b);

    // c: the same frames reloaded under their flags (the document copies allowDNSPrefetch as it loads).
    await chrome("sidebar.contentWindow.location.reload(); agent.contentWindow.location.reload();");
    await sleep(500);
    await waitReady(m);
    widgetFiles(dataDir, "sonde", hintsWidget("c"));
    await display("sonde", hintsWidget("c"), "sonde c");
    const c = await s1Phase("c");
    note("S1 c, flags then load", c);

    // A mousedown on a widget's link warms a connection (Element.cpp, PostHandleEventForLinks): not gated by either flag?
    const md0 = counters();
    const md = await chrome(
      `const f = widget("sonde"), wd = f.contentDocument;
       const a = wd.createElement("a"); a.href = "http://c-md-a." + arguments[0] + ":15369/"; a.textContent = "lien lien lien"; a.style.cssText = "display:block;font-size:20px";
       wd.body.prepend(a);
       await new Promise((r) => setTimeout(r, 200));
       const fr = f.getBoundingClientRect(), ar = a.getBoundingClientRect();
       const x = fr.left + ar.left + 10, y = fr.top + ar.top + 5;
       const hit = sb.elementFromPoint(x, y);
       sb.defaultView.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
       sb.defaultView.synthesizeMouseEvent("mouseup", 2, 2, { button: 0, clickCount: 1 });
       return { x, y, hit: hit && hit.localName, frameSrc: wd.documentURI };`,
      [SFX],
    );
    await sleep(2500);
    note("S1 mousedown on a widget link, flags on", { md, names: (await names()).filter((n) => n.startsWith("c-md")), ...delta(md0) });

    // A candidate closure: the chrome's capture listener on the window root (before any listener of the widget)
    // consumes a mousedown on a link of a non-system UI document: Element.cpp's precondition then skips the warm-up.
    const mc0 = counters();
    const mc = await chrome(
      `const root = window.windowRoot;
       window.spikeMousedown ??= (e) => { const t = e.composedTarget ?? e.target; const d = t?.ownerDocument;
         if (d && !d.nodePrincipal.isSystemPrincipal && N.isUiDocument(d) && t.closest?.("a[href], area[href]")) { e.preventDefault(); window.spikeConsumed = (window.spikeConsumed ?? 0) + 1; } };
       root.addEventListener("mousedown", window.spikeMousedown, true);
       // The widget's own capture listener tries to stop it first.
       const f = widget("sonde"), wd = f.contentDocument;
       wd.defaultView.wrappedJSObject.addEventListener("mousedown", (e) => e.stopImmediatePropagation(), true);
       const a = wd.createElement("a"); a.href = "http://c-md2-a." + arguments[0] + ":15369/"; a.textContent = "deux deux deux"; a.style.cssText = "display:block;font-size:20px";
       wd.body.prepend(a);
       await new Promise((r) => setTimeout(r, 200));
       const fr = f.getBoundingClientRect(), ar = a.getBoundingClientRect();
       const x = fr.left + ar.left + 10, y = fr.top + ar.top + 5;
       sb.defaultView.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 });
       sb.defaultView.synthesizeMouseEvent("mouseup", 2, 2, { button: 0, clickCount: 1 });
       root.removeEventListener("mousedown", window.spikeMousedown, true);
       return { consumed: window.spikeConsumed ?? 0 };`,
      [SFX],
    );
    await sleep(2500);
    note("S1 mousedown, consumed by a window-root listener", { mc, names: (await names()).filter((n) => n.startsWith("c-md2")), ...delta(mc0) });

    // What APP_TYPE_MAIL changed that shows: the UI mounted again, the widget displayed, the agent panel, the drag flag.
    const visible = await chrome(
      `const ag = agent.contentDocument;
       return { sidebarMounted: !!sb.querySelector('[data-testid="barre-laterale"]'), widgets: [...sb.querySelectorAll('[data-testid^="widget-"] iframe')].map((f) => f.contentDocument?.body?.textContent?.trim().slice(0, 30)),
                agentMounted: !!ag.querySelector('[data-testid="panneau-agent"]'), sidebar: N.flags(sidebar), agent: N.flags(agent), windowDocShell: docShell.appType };`,
    );
    note("S1 visible after reload with flags", visible);

    // The witness: a tab's navigation and its hints are still resolved.
    const t0 = counters();
    await openTab(`http://tab.${SFX}:${HTTP}/tab-s1`);
    await sleep(3000);
    note("S1 tab witness", { names: (await names()).filter((n) => n.startsWith("tab")), ...delta(t0) });
    await closeTabs();

    // Loads (a frame's src, a preload read by the speculative parser) are S2's: the content policy's job.
    expect(c.names.filter((n) => !/-(fr|prel)$/.test(n)), "no hint of a UI document under its flags resolves a name").toEqual([]);
    expect(c.tcp, "nor opens a connection").toBe(0);
  });

  /** A policy/observer record, compacted: label of the host, type, loading document, node, principals, context, verdict. */
  const compact = (r: any) =>
    `${label(new URL(r.uri.startsWith("moz-remote-image") ? decodeURIComponent(r.uri.split("url=")[1] ?? "") || "http://x" : r.uri.replace(/^wss?:/, "http:")).host)} t${r.type} doc=${(r.doc ?? "-").replace(/^(chrome:\/\/browser\/content\/webaios\/|resource:\/\/)/, "").slice(0, 40)} node=${r.node ?? "-"} L=${r.loading} T=${r.triggering} bc=${r.bc ? (r.bc.content ? "content" : "chrome") : "-"} ui=${r.ui}`;
  const logs = () => chrome<{ policy: number; observer: number; webrtc: number }>("return { policy: N.log.policy.length, observer: N.log.observer.length, webrtc: N.log.webrtc.length };");
  const logsSince = (l: { policy: number; observer: number }) =>
    chrome<{ policy: any[]; observer: any[] }>("return { policy: N.log.policy.slice(arguments[0]), observer: N.log.observer.slice(arguments[1]) };", [l.policy, l.observer]);
  const site = `[...Services.wm.getEnumerator("navigator:browser")].find((x) => x.document.documentElement.getAttribute("webaios-site") === "netsite")`;

  async function s2Phase(p: string) {
    await display("sonde", loadsWidget(p), `sonde ${p}`);
    const before = counters();
    const l0 = await logs();
    const inserted = await chrome(
      `const p = arguments[0], sfx = arguments[1], out = {};
       const step = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = "ERR " + String(e).slice(0, 100); } };
       const wd = widget("sonde").contentDocument;
       const win = ${site};
       const bar = win?.document.getElementById("webaios-site-bar")?.contentDocument;
       const home = bar?.querySelector('[data-testid="site-cadre-accueil"]')?.contentDocument;
       await step("sb", () => N.insertLoads(sb, p + "-sb", sfx));
       await step("ag", () => N.insertLoads(agent.contentDocument, p + "-ag", sfx));
       await step("wd", () => N.insertLoads(wd, p + "-wd", sfx));
       await step("wb", async () => N.insertLoads((await N.addFrame(wd)).contentDocument, p + "-wb", sfx));
       await step("wsd", async () => { const f = await N.addFrame(wd, { srcdoc: "<p>s</p>" }); return [f.contentDocument.documentURI, N.insertLoads(f.contentDocument, p + "-wsd", sfx)]; });
       for (const [d, sub] of [["cp", "webaios-composant-spike"], ["tp", "webaios-spike-page"]])
         await step(d, async () => { const f = await N.addFrame(sb, { sandbox: "allow-scripts" }, "resource://" + sub + "/s2-" + p + "-" + d + ".html"); return [f.contentDocument.documentURI, N.insertLoads(f.contentDocument, p + "-" + d, sfx)]; });
       await step("bar", () => (bar ? [bar.documentURI, N.insertLoads(bar, p + "-bar", sfx)] : "no bar"));
       await step("sh", () => (home ? [home.documentURI, N.insertLoads(home, p + "-sh", sfx)] : "no home"));
       // A cut frame of the window itself navigated to the web: only loadingNode says it is the UI's.
       await step("cf", async () => { const f = await N.addFrame(document.getElementById("browser"), {}, null, (f) => N.cut(f)); f.setAttribute("src", "http://" + p + "-cf-nav." + sfx + ":15368/s2/" + p + "-cf/nav"); return "set"; });
       return out;`,
      [p, SFX],
    );
    await sleep(4000);
    const { policy, observer } = await logsSince(l0);
    const d = delta(before);
    const mine = (x: string) => x.startsWith(`${p}-`);
    return {
      inserted,
      names: (await names()).filter(mine),
      httpConns: d.httpConns,
      hits: d.hits.filter(mine),
      policy: policy.filter((r) => r.uri.includes(SFX) || r.uri.includes(encodeURIComponent(SFX))).map(compact),
      observer: observer.filter((r) => r.uri.includes(SFX)).map(compact),
    };
  }

  it("S2: who a load belongs to, and what a refusal leaves (DNS, connection)", { timeout: 300_000 }, async () => {
    const opened = await m
      .execute(
        `return (async () => { const store = await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready;
         return await store.agent.request("sites.agir", { id: "netsite", action: "ouvrir", fenetre: store.state.fenetres[0].id }); })();`,
      )
      .then((v) => v, (e) => `ERR ${e}`);
    const bar = await waitFor(m, `const w = ${site}; const b = w?.document.getElementById("webaios-site-bar")?.contentDocument; const h = b?.querySelector('[data-testid="site-cadre-accueil"]')?.contentDocument; return { bar: b?.documentURI ?? null, home: h?.documentURI ?? null, view: w?.gBrowser.selectedBrowser.currentURI.spec ?? null };`, (v: any) => !!v.bar && !!v.home, 20_000).catch((e) => String(e));
    const liste = await m.execute(`return (async () => { const store = await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready; return await store.agent.request("sites.liste"); })();`).catch((e) => String(e));
    note("S2 site app opened", { opened, bar, liste });

    const p0 = await s2Phase("p0");
    note("S2 p0, no net", p0);
    await chrome('N.mode.policy = "reject"; N.mode.observer = "log";');
    const p1 = await s2Phase("p1");
    note("S2 p1, policy refuses, observer logs", p1);
    await chrome('N.mode.policy = "off"; N.mode.observer = "cancel";');
    const p2 = await s2Phase("p2");
    note("S2 p2, observer alone cancels", p2);

    // The witnesses, both layers on: none is the UI's, all reach the server.
    await chrome('N.mode.policy = "reject"; N.mode.observer = "cancel";');
    const before = counters();
    const l0 = await logs();
    const witness: Record<string, unknown> = {};
    await openTab(`http://wt-tab.${SFX}:${HTTP}/page`);
    await sleep(1500);
    witness.read = await m.execute(
      `return (async () => { const s = await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready;
       try { const r = await s.readPage(arguments[0], { profil: null, adressesLocales: true }); return r.titre; } catch (e) { return "ERR " + e; } })();`,
      [`http://wt-read.${SFX}:${HTTP}/page`],
    );
witness.siteView = await m.execute(`const b = ${site}?.gBrowser.selectedBrowser; if (!b) return null; b.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true;`, [`http://netsite.localhost:${HTTP}/page`]).catch((e) => String(e));
    witness.siteViewAt = await waitFor(m, `const b = ${site}?.gBrowser.selectedBrowser; return b && !b.webProgress.isLoadingDocument ? b.currentURI.spec + " " + b.contentTitle : "";`, (v: string) => v.includes("/page"), 10_000).catch((e) => String(e).slice(0, 200));
    // An action's result image (site-home.ts containerRequests, anonymous): a content principal, no document.
    witness.actionImage = await m.execute(
      `return (async () => { const { NetUtil } = ChromeUtils.importESModule("resource://gre/modules/NetUtil.sys.mjs");
       const uri = Services.io.newURI(arguments[0]);
       const ch = NetUtil.newChannel({ uri, loadingPrincipal: Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId: 0 }), securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL, contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER });
       ch.loadFlags |= Ci.nsIRequest.LOAD_ANONYMOUS;
       return await new Promise((r) => { try { NetUtil.asyncFetch(ch, (_s, status) => r(status)); } catch (e) { r("ERR " + e); } }); })();`,
      [`http://wt-img.${SFX}:${HTTP}/s2/witness/img`],
    );
    witness.addon = await m.execute(
      `return (async () => { const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
       const i = await AddonManager.getInstallForURL(arguments[0], { telemetryInfo: { source: "test" } });
       try { await i.install(); return "installed?"; } catch (e) { return "failed as expected: " + i.error; } })();`,
      [`http://wt-addon.${SFX}:${HTTP}/x.xpi`],
    ).catch((e) => String(e));
    await sleep(2000);
    const wl = await logsSince(l0);
    const wd = delta(before);
    note("S2 witnesses", {
      witness,
      hits: wd.hits.filter((h) => h.startsWith("wt-") || h.startsWith("netsite")),
      policy: wl.policy.filter((r) => r.uri.includes(SFX)).map(compact),
      observer: wl.observer.filter((r) => r.uri.includes(SFX)).map(compact),
    });
    await closeTabs();
    note("S2 every hit of a widget's frame over the run (sfr static, bfr through about:blank, ws-fr S1)", hits.filter((h) => /-(sfr|bfr|ws-fr|nav|self)$/.test(h.label)).map((h) => `${h.label} ${h.path}`));

    // System documents skip content policies (nsContentPolicyUtils.h:134): only moz-remote-image, unattributable, gets through.
    expect(p1.hits.filter((h) => !/^p1-(sb|ag|bar)-remote /.test(h)), "the policy: no request from a non-system UI document").toEqual([]);
    expect(p1.names.filter((n) => !/^p1-(sb|ag|bar)-/.test(n)), "and no name resolved").toEqual([]);
    expect(p2.names.filter((n) => /^p2-(sb|ag|bar)-(img|bg)$/.test(n)), "the observer cancels a system document's image before DNS").toEqual([]);
    expect(wl.observer.filter((r) => r.uri.includes(SFX) && r.ui).map(compact), "no witness is the UI's").toEqual([]);
  });

  it("S3: WebRTC from the UI's documents, without and with the PeerConnection:request refusal", { timeout: 300_000 }, async () => {
    const runs: Record<string, unknown> = {};
    const run = async (what: string, f: () => Promise<unknown>) => {
      const c0 = counters();
      const l0 = await logs();
      const r = await f();
      await sleep(500);
      const d = delta(c0);
      const requests = await chrome("return N.log.webrtc.slice(arguments[0]);", [l0.webrtc]);
      runs[what] = { r, tcp: d.tcp, udp: d.udp, requests };
    };
    /** The results a page wrote: its own #r (main, about:blank), then its srcdoc child's. */
    const results = (frameExpr: string) =>
      `const d = (${frameExpr})?.contentDocument; const s = d?.querySelector("iframe[srcdoc]")?.contentDocument;
       return { main: d?.getElementById("r")?.textContent ?? null, srcdoc: s?.getElementById("r")?.textContent ?? null, srcdocUri: s?.documentURI ?? null };`;
    const settle = async (frameExpr: string) => {
      await waitFor(m, `const widget = (id) => document.getElementById("webaios-sidebar").contentDocument.querySelector('[data-testid="widget-' + id + '"] iframe'); ${results(frameExpr)}`, (v: any) => v.main?.startsWith("["), 30_000);
      await sleep(8000);
      return m.execute(`const widget = (id) => document.getElementById("webaios-sidebar").contentDocument.querySelector('[data-testid="widget-' + id + '"] iframe'); ${results(frameExpr)}`);
    };
    for (const [ph, mode] of [["s3o", "off"], ["s3d", "deny"]] as const) {
      await chrome("N.mode.webrtc = arguments[0];", [mode]);
      await run(`${ph} widget (served, guarded)`, async () => {
        widgetFiles(dataDir, "rtc", rtcPage(`${ph}-w`));
        await waitFor(m, `const f = document.getElementById("webaios-sidebar").contentDocument.querySelector('[data-testid="widget-rtc"] iframe'); return f?.contentDocument?.documentElement?.innerHTML.includes(${JSON.stringify(`${ph}-w-main`)}) ?? false;`, (v) => v === true, 20_000);
        return settle(`widget("rtc")`);
      });
      await run(`${ph} unguarded page in the sidebar`, async () => {
        await chrome("const f = await N.addFrame(sb, { sandbox: 'allow-scripts', id: 'rtc-' + arguments[0] }, 'resource://webaios-spike-page/rtc-' + arguments[0] + '.html'); return f.contentDocument.documentURI;", [ph]);
        return settle(`document.getElementById("webaios-sidebar").contentDocument.getElementById("rtc-${ph}")`);
      });
      await run(`${ph} sidebar (system principal)`, () => chrome("return await N.rtc(sb.defaultView.RTCPeerConnection, arguments[0], arguments[1]);", [`${ph}-sb`, SFX]));
    }
    await run("tab witness", async () => {
      await openTab(`http://wt-rtc.${SFX}:${HTTP}/rtc`);
      return waitFor(m, "return gBrowser.selectedBrowser.contentTitle;", (t: string) => t.startsWith("{"), 15_000).then((t) => JSON.parse(t));
    });
    note("S3 runs", runs);
    note("S3 names", (await names()).filter((n) => n.startsWith("turn-") || n.startsWith("stun-")));
    await closeTabs();

    const deny = Object.entries(runs).filter(([k]) => k.startsWith("s3d ") && !k.includes("system")) as [string, { tcp: number; udp: number }][];
    for (const [k, v] of deny) expect({ k, tcp: v.tcp, udp: v.udp }).toEqual({ k, tcp: 0, udp: 0 });
    const tab = runs["tab witness"] as { tcp: number; udp: number };
    expect(tab.tcp + tab.udp, "a tab still reaches the fake TURN/STUN").toBeGreaterThan(0);
  });
});
