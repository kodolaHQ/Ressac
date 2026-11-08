import dgram from "node:dgram";
import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import type { Marionette } from "./marionette";

// The UI's network e2e helpers, taken from the spikes (spikes/ui-network.e2e.ts, note 2026-11-08-reseau-interfaces-spikes.md).
// Nothing reaches the real internet: every name is under SFX and network.dns.native-is-localhost answers 127.0.0.1 for
// any name (IPv4 only); the hostResolver log (MOZ_LOG) shows which names were asked.

/** Each name a probe uses ends with it. */
export const SFX = `w${Date.now()}.webaios-test.example`;
/** No name goes to the real resolver; ICE may send to the loopback STUN witness (without it a zero UDP count proves nothing, S3). */
export const NET_PREFS = { "network.dns.native-is-localhost": true, "network.trr.mode": 5, "media.peerconnection.ice.loopback": true };
/** Every process logs the names it asks for into `logDir`. */
export const netEnv = (logDir: string) => ({ MOZ_LOG: "sync,nsHostResolver:5", MOZ_LOG_FILE: path.join(logDir, "moz.log") });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
/** A 1×1 PNG as a data: URL. */
export const DATA_PNG = `data:image/png;base64,${PNG.toString("base64")}`;

export type Hit = { label: string; path: string; method: string };
/** A host without its port and SFX: `sb-img.<SFX>:15365` → `sb-img`. */
export const label = (h: string | undefined) => String(h ?? "").replace(/:\d+$/, "").replace(`.${SFX}`, "");

/**
 * An HTTP/WebSocket server on `http` logging each request by host name (/page: a tab's loads, /rtc: a tab's WebRTC, /link?h=: a page-wide link,
 * images as PNG, the rest a small page), a TCP counter on `raw` (fake TURN, a link's target) and, with `udp`, a UDP
 * counter (fake STUN). The arrays fill as things arrive.
 */
export async function startNetWitness(o: { http: number; raw: number; udp?: number }): Promise<{ hits: Hit[]; tcp: number[]; udp: number[]; httpConns: () => number; close(): void }> {
  const hits: Hit[] = [];
  const tcp: number[] = [];
  const udp: number[] = [];
  let conns = 0;
  const http = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    hits.push({ label: label(req.headers.host), path: u.pathname, method: req.method ?? "GET" });
    const html = (s: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(s);
    if (u.pathname === "/page")
      return html(`<title>page</title><img src="/s2/witness/img"><script>fetch("/s2/witness/fetch").catch(() => {}); try { new WebSocket("ws://" + location.host + "/s2/witness/ws"); } catch (e) {} navigator.sendBeacon("/s2/witness/beacon", "x");</script>`);
    // A page-wide link to `h` (a tab's link press).
    if (u.pathname === "/link") return html(`<title>link</title><a href="${u.searchParams.get("h")}" style="position:fixed;inset:0;display:block;font-size:40px">link</a>`);
    if (u.pathname === "/rtc") return html(`<title>rtc</title><script>${RTC}\nrtc(window.RTCPeerConnection, "tab").then((o) => { document.title = JSON.stringify(o); });</script>`);
    if (/(img|\.png|remote)$/.test(u.pathname)) return res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
    html("<title>s2</title>");
  });
  http.on("connection", () => conns++);
  http.on("upgrade", (req, socket) => {
    hits.push({ label: label(req.headers.host), path: new URL(req.url ?? "/", "http://x").pathname, method: "UPGRADE" });
    socket.destroy();
  });
  await new Promise<void>((ok, ko) => http.once("error", ko).listen(o.http, "127.0.0.1", ok));
  const raw = net.createServer((s) => {
    tcp.push(Date.now());
    s.on("error", () => {});
    setTimeout(() => s.destroy(), 300);
  });
  await new Promise<void>((ok, ko) => raw.once("error", ko).listen(o.raw, "127.0.0.1", ok));
  const stun = o.udp === undefined ? null : dgram.createSocket("udp4");
  if (stun) {
    stun.on("message", () => udp.push(Date.now()));
    await new Promise<void>((ok) => stun.bind(o.udp, "127.0.0.1", ok));
  }
  return {
    hits,
    tcp,
    udp,
    httpConns: () => conns,
    close() {
      http.closeAllConnections();
      http.close();
      raw.close();
      stun?.close();
    },
  };
}

/** The names asked of the resolver (without SFX), from every process's log (`Resolving host [<name>]`). */
export async function resolvedNames(logDir: string): Promise<string[]> {
  let all = "";
  for (const f of await readdir(logDir)) all += await readFile(path.join(logDir, f), "utf8").catch(() => "");
  const out = new Set<string>();
  for (const [, h] of all.matchAll(/Resolving host \[([^\]]+)\]/g)) if (h!.endsWith(`.${SFX}`)) out.add(h!.slice(0, -SFX.length - 1));
  return [...out];
}

/** A widget `id` of the space's home with display `html`, and optional example data (exemple.json). */
export function widgetFiles(dataDir: string, id: string, html: string, example?: unknown): void {
  const dir = path.join(dataDir, "espace/accueil/widgets", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "widget.json"),
    JSON.stringify({ nom: id, description: "", tailles: { min: { l: 2, h: 1 }, max: { l: 6, h: 4 }, defaut: { l: 3, h: 2 } }, sources: { compte: [], publiques: [], web: false } }),
  );
  writeFileSync(path.join(dir, "affichage.html"), html);
  if (example !== undefined) writeFileSync(path.join(dir, "exemple.json"), JSON.stringify(example));
}

// ui-network.e2e.ts's fake TURN (TCP) and STUN (UDP) ports.
const TURN = 15366;
const STUN = 15367;
/** The page-side WebRTC probe: an offer with a fake TURN/TCP and STUN/UDP under names that carry `tag`. */
export const RTC = `async function rtc(C, tag) {
  const t0 = performance.now();
  const out = { tag, type: typeof C };
  if (typeof C === "string") out.error = C.slice(0, 160);
  if (typeof C !== "function") return out;
  let pc;
  try {
    pc = new C({ iceServers: [{ urls: "turn:turn-" + tag + ".${SFX}:${TURN}?transport=tcp", username: "u", credential: "p" }, { urls: "stun:stun-" + tag + ".${SFX}:${STUN}" }] });
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
/** Runs rtc on the page itself, a fresh about:blank child's constructor, and a srcdoc child; #r reads « lancé » until done. */
export const rtcPage = (tag: string) => `<!doctype html><meta charset="utf-8"><title>rtc</title><pre id="r">lancé</pre><script>${RTC}
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

/** The console lines so far that contain `text`, from the console service and the console API's storage. */
export function consoleWith(m: Marionette, text: string): Promise<string[]> {
  return m.execute<string[]>(
    `const out = Services.console.getMessageArray().map((x) => String(x.message ?? x));
     for (const e of Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage).getEvents()) out.push((e.arguments ?? []).map(String).join(" "));
     return [...new Set(out.filter((t) => t.includes(arguments[0])))];`,
    [text],
  );
}

/** The net's refusals so far (`[ui-network] refused …`). */
export const uiRefusals = (m: Marionette): Promise<string[]> => consoleWith(m, "[ui-network] refused");

/** resource://webaios-test-net/ serves `dir` (a name outside the UI's prefixes: such a page is the UI's only through its ancestor). */
export function testPages(m: Marionette, dir: string): Promise<unknown> {
  return m.execute(
    `const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
     const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
     res.setSubstitution("webaios-test-net", Services.io.newFileURI(new FileUtils.File(arguments[0])));`,
    [dir],
  );
}
