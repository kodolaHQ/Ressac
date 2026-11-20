import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import { inFrame, inUi, waitUi } from "./ui";
import { consoleWith, NET_PREFS, netEnv, resolvedNames, SFX, startNetWitness } from "./ui-network";

// The remote frame <browser>s (chrome/window/remote-frame.ts, chrome/agent/frame-actor.ts) on their own, before any
// caller uses them: two frames in the sidebar on a copy under the frames folder. Ports: 15380 (HTTP/WS witness),
// 15381 (TCP counter: preconnects and a pressed link's speculative connect).

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const HTTP = 15380;
const RAW = 15381;
const host = (name: string) => `${name}.${SFX}:${HTTP}`;
/** Every kind of load the UI's net refuses (as ui-network.e2e.ts), under fr-<kind>; a page-wide link to the TCP counter. */
const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<link rel="dns-prefetch" href="//fr-dns.${SFX}"><link rel="preconnect" href="http://fr-preco.${SFX}:${RAW}">
<a id="lien" href="http://fr-press.${SFX}:${RAW}/" style="position:fixed;inset:0;display:block">lien</a>
<p id="t">cadre</p><p id="got">…</p><p id="net">…</p><p id="rtc">…</p>
<img src="http://${host("fr-img")}/fr/img">
<script>
  const note = (id, t) => (document.getElementById(id).textContent = t);
  try { new RTCPeerConnection().createOffer().then(() => note("rtc", "ok"), (e) => note("rtc", "err " + e.name)); } catch (e) { note("rtc", "throw " + e.name); }
  addEventListener("message", (e) => note("got", JSON.stringify(e.data)));
  fetch("http://${host("fr-fetch")}/fr/fetch").then(() => note("net", "ok"), (e) => note("net", "err " + e.name));
  try { new WebSocket("ws://${host("fr-ws")}/fr/ws"); } catch (e) {}
  const l = document.createElement("link"); l.rel = "dns-prefetch"; l.href = "//fr-dns-script.${SFX}"; document.head.append(l);
</script>`;

/** A frame whose owner sends it back to `file` on every load that is not it (as ui/RemoteFrame.svelte's owners); its loads in 3 s. */
async function loadsIn3s(m: LaunchedRessac["marionette"], file: string, html: string | null): Promise<number> {
  return inUi<number>(
    m,
    `const store = ChromeUtils.importESModule(${JSON.stringify(STORE)});
     const [file, html] = arguments;
     const dir = PathUtils.join(PathUtils.profileDir, "chrome", "ressac-frames", "widgets", "frames-test");
     if (html !== null) await IOUtils.writeUTF8(PathUtils.join(dir, file), html);
     const src = "resource://ressac-frames-" + store.framesToken() + "/widgets/frames-test/" + file;
     const host = doc.body.appendChild(doc.createElement("div"));
     host.style.cssText = "position: fixed; left: 0; top: 240px; width: 200px; height: 100px; display: flex";
     const b = store.remoteFrames.createFrameBrowser(doc);
     b.style.flex = "1";
     host.append(b);
     const r = store.remoteFrames.frameReverter(b);
     let n = 0;
     const off = store.remoteFrames.onFrameMessage(b, (name, data) => {
       if (name !== "loaded") return;
       n++;
       r.loaded(() => String(data.uri).split("#")[0] !== src && r.revert(src));
     });
     store.remoteFrames.loadFrame(b, src);
     await new Promise((ok) => ui.setTimeout(ok, 3000));
     off();
     host.remove();
     return n;`,
    [file, html],
  );
}

describe("remote frames", () => {
  let w: LaunchedRessac;
  let net: Awaited<ReturnType<typeof startNetWitness>>;
  let logDir: string;
  beforeAll(async () => {
    net = await startNetWitness({ http: HTTP, raw: RAW });
    logDir = await mkdtemp(path.join(os.tmpdir(), "ressac-frames-log-"));
    w = await launchRessac({ prefs: NET_PREFS, env: netEnv(logDir) });
    await w.marionette.setContext("chrome");
    await waitReady(w.marionette);
    await inUi(
      w.marionette,
      `const store = ChromeUtils.importESModule(${JSON.stringify(STORE)});
       const dir = PathUtils.join(PathUtils.profileDir, "chrome", "ressac-frames", "widgets", "frames-test");
       await IOUtils.makeDirectory(dir);
       await IOUtils.writeUTF8(PathUtils.join(dir, "display.html"), arguments[0]);
       const src = "resource://ressac-frames-" + store.framesToken() + "/widgets/frames-test/display.html";
       ui.__framesLog = [];
       for (const id of ["frames-a", "frames-b"]) {
         const host = doc.body.appendChild(doc.createElement("div"));
         host.id = id;
         host.style.cssText = "position: fixed; z-index: 99999; left: 0; top: " + (id === "frames-a" ? 0 : 120) + "px; width: 200px; height: 100px; display: flex";
         const b = store.remoteFrames.createFrameBrowser(doc);
         b.style.flex = "1";
         host.append(b);
         store.remoteFrames.onFrameMessage(b, (name, data) => ui.__framesLog.push([id, name, data]));
         if (!store.remoteFrames.loadFrame(b, src)) throw new Error("not loaded");
       }`,
      [PAGE],
    );
    await waitUi(w.marionette, `return ["frames-a", "frames-b"].every((id) => ui.__framesLog.some(([i, n, d]) => i === id && n === "loaded" && String(d.uri).endsWith("/display.html")));`);
  }, 60_000);
  afterAll(async () => {
    await w?.close();
    net?.close();
    if (logDir) await rm(logDir, { recursive: true, force: true });
  });

  it("run out of the parent, both in one process, with a null principal", async () => {
    const r = await inUi<{ pids: number[]; parent: number; nulls: boolean[]; remoteType: string; uris: string[] }>(
      w.marionette,
      `const bs = ["frames-a", "frames-b"].map((id) => doc.querySelector("#" + id + " browser"));
       const wgs = bs.map((b) => b.browsingContext.currentWindowGlobal);
       return { pids: wgs.map((g) => g.osPid), parent: Services.appinfo.processID, nulls: wgs.map((g) => g.documentPrincipal.isNullPrincipal), remoteType: bs[0].remoteType, uris: wgs.map((g) => g.documentURI.spec) };`,
    );
    expect(r.pids[0]).not.toBe(r.parent);
    expect(r.pids[1]).toBe(r.pids[0]);
    expect(r.nulls).toEqual([true, true]);
    expect(r.remoteType).toMatch(/^webIsolated=resource:\/\/ressac-frames-[0-9a-f]{16}$/);
    expect(r.uris[0]).toMatch(/\/widgets\/frames-test\/display\.html$/);
  });

  it("are transparent: a page with no background shows what is behind its frame", async () => {
    const r = await inUi<{ attr: string | null; pixel: number[] }>(
      w.marionette,
      `const host = doc.getElementById("frames-a"), b = host.querySelector("browser");
       host.style.background = "rgb(255, 0, 0)";
       await new Promise((ok) => ui.requestAnimationFrame(() => ui.requestAnimationFrame(ok)));
       const r = b.getBoundingClientRect();
       // The bottom right corner: below the page's text.
       const shot = await ui.browsingContext.currentWindowGlobal.drawSnapshot(new ui.DOMRect(r.right - 4, r.bottom - 4, 1, 1), 1, "rgb(0, 255, 0)");
       const c = doc.createElement("canvas"); c.width = c.height = 1;
       const g = c.getContext("2d"); g.drawImage(shot, 0, 0);
       host.style.background = "";
       return { attr: b.getAttribute("transparent"), pixel: [...g.getImageData(0, 0, 1, 1).data.slice(0, 3)] };`,
    );
    expect(r.pixel, "the host's red, not a white canvas").toEqual([255, 0, 0]);
    expect(r.attr).toBe("true");
  });

  it("send reaches the page, inFrame reads it", async () => {
    expect(await inFrame(w.marionette, "#frames-a browser", `document.getElementById("t").textContent`)).toBe("cadre");
    await inUi(w.marionette, `await ChromeUtils.importESModule(${JSON.stringify(STORE)}).remoteFrames.sendFrame(doc.querySelector("#frames-a browser"), { type: "widget", n: 1 });`);
    await expect.poll(() => inFrame(w.marionette, "#frames-a browser", `document.getElementById("got").textContent`), { timeout: 5000 }).toBe('{"type":"widget","n":1}');
    expect(await inFrame(w.marionette, "#frames-b browser", `document.getElementById("got").textContent`), "the other frame got nothing").toBe("…");
  });

  it("a real press in a frame comes back as press, to its owner only", async () => {
    await inUi(
      w.marionette,
      `const r = doc.querySelector("#frames-b browser").getBoundingClientRect();
       for (const type of ["mousedown", "mouseup"]) ui.synthesizeMouseEvent(type, r.left + r.width / 2, r.top + r.height / 2, { button: 0, clickCount: 1 });`,
    );
    await waitUi(w.marionette, `return ui.__framesLog.some(([i, n]) => i === "frames-b" && n === "press");`);
    expect(await inUi(w.marionette, `return ui.__framesLog.some(([i, n]) => i === "frames-a" && n === "press");`)).toBe(false);
  });

  it("the page reaches no server and resolves no name: fetch, WebSocket, img, dns-prefetch, preconnect, a pressed link", async () => {
    await expect.poll(() => inFrame<string>(w.marionette, "#frames-a browser", `document.getElementById("net").textContent`), { timeout: 5000 }).toMatch(/^err /);
    // The witness: a tab's navigation resolves its name and reaches the server (the log and the counters work).
    await dispatch(w.marionette, { type: "openTab", windowId: (await state(w.marionette)).windows[0]!.id, url: `http://${host("fr-temoin")}/`, activate: true });
    await expect.poll(() => net.hits.some((h) => h.label === "fr-temoin"), { timeout: 15_000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 3000));
    expect(net.hits.filter((h) => h.label.startsWith("fr-") && h.label !== "fr-temoin").map((h) => `${h.label} ${h.path}`)).toEqual([]);
    expect({ names: (await resolvedNames(logDir)).filter((n) => n.startsWith("fr-")), tcp: net.tcp.length }).toEqual({ names: ["fr-temoin"], tcp: 0 });
    // The frames' process refuses them before their channel (frame-actor.ts policeProcess); the parent's observer behind it is unit-tested (test/ui-network.test.ts).
  });

  // Measured before the bound (3 s): 64 loads for a missing copy, 104 for a page that leaves at once; after: 2 and 7.
  it("an owner's revert to its copy is bounded: a missing copy, a page that keeps leaving", async () => {
    expect(await loadsIn3s(w.marionette, "gone.html", null), "about:blank, then the neterror page: no more").toBeLessThanOrEqual(3);
    const leaves = await loadsIn3s(w.marionette, "leaves.html", `<!doctype html><script>setTimeout(() => (location = "about:blank"), 50)</script>`);
    expect(leaves, "at most one revert a second").toBeLessThanOrEqual(10);
    expect(leaves, "it still comes back").toBeGreaterThanOrEqual(4);
  }, 30_000);

  it("SANDBOX_ALLOW_SCRIPTS is a real <iframe sandbox=allow-scripts>'s flags", async () => {
    const r = await inUi<number[]>(
      w.marionette,
      `const f = doc.createElement("iframe");
       f.setAttribute("sandbox", "allow-scripts");
       doc.body.append(f);
       const flags = f.browsingContext.sandboxFlags;
       f.remove();
       return [flags, ChromeUtils.importESModule(${JSON.stringify(STORE)}).remoteFrames.SANDBOX_ALLOW_SCRIPTS];`,
    );
    expect(r[1]).toBe(r[0]);
  });

  it("the page's WebRTC is denied", async () => {
    await expect.poll(() => inFrame<string>(w.marionette, "#frames-a browser", `document.getElementById("rtc").textContent`), { timeout: 5000 }).toMatch(/^err /);
    expect(await consoleWith(w.marionette, "[ui-network] refused webrtc from a frame")).toHaveLength(1);
  });
});
