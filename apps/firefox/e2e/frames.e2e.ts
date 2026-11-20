import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import { inFrame, inUi, waitUi } from "./ui";
import { consoleWith, uiRefusals } from "./ui-network";

// The remote frame <browser>s (chrome/window/remote-frame.ts, chrome/agent/frame-actor.ts) on their own, before any
// caller uses them: two frames in the sidebar on a copy under the frames folder.

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const PAGE = (port: number) => `<!doctype html><meta charset="utf-8"><p id="t">cadre</p><p id="got">…</p><p id="net">…</p><p id="rtc">…</p>
<script>
  const note = (id, t) => (document.getElementById(id).textContent = t);
  try { new RTCPeerConnection().createOffer().then(() => note("rtc", "ok"), (e) => note("rtc", "err " + e.name)); } catch (e) { note("rtc", "throw " + e.name); }
  addEventListener("message", (e) => { document.getElementById("got").textContent = JSON.stringify(e.data); });
  fetch("http://127.0.0.1:${port}/frame-fetch").then(() => (document.getElementById("net").textContent = "ok"), (e) => (document.getElementById("net").textContent = "err " + e.name));
</script>`;

describe("remote frames", () => {
  let w: LaunchedRessac;
  let server: Server;
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(String(req.url));
      res.end("x");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    w = await launchRessac();
    await w.marionette.setContext("chrome");
    await waitReady(w.marionette);
    const port = (server.address() as AddressInfo).port;
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
      [PAGE(port)],
    );
    await waitUi(w.marionette, `return ["frames-a", "frames-b"].every((id) => ui.__framesLog.some(([i, n]) => i === id && n === "loaded"));`);
  }, 60_000);
  afterAll(async () => {
    await w?.close();
    server?.close();
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

  it("the page's fetch to the web is refused by the parent: nothing reaches the server", async () => {
    await expect.poll(() => inFrame<string>(w.marionette, "#frames-a browser", `document.getElementById("net").textContent`), { timeout: 5000 }).toMatch(/^err /);
    expect(await inFrame(w.marionette, "#frames-b browser", `document.getElementById("net").textContent`)).toMatch(/^err /);
    expect(hits).toEqual([]);
    // Cut by the parent's observer, not only by something in the web process (both frames' lines are the same, deduped).
    expect((await uiRefusals(w.marionette)).filter((t) => t.includes("/frame-fetch"))).toHaveLength(1);
  });

  it("the page's WebRTC is denied", async () => {
    await expect.poll(() => inFrame<string>(w.marionette, "#frames-a browser", `document.getElementById("rtc").textContent`), { timeout: 5000 }).toMatch(/^err /);
    expect(await consoleWith(w.marionette, "[ui-network] refused webrtc from a frame")).toHaveLength(1);
  });
});
