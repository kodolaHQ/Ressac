// Security bench B7, claims C7.8 and C7.9 (catalogue H4, H5, H6, I3): vectors the repo's suites do not hold
// (e2e/frames.e2e.ts, e2e/ui-network.e2e.ts already cover fetch, WebSocket, img, font, beacon, worker, WebRTC,
// dns-prefetch, preconnect, links, fullscreen, mailto: and the process: run those first, they are the baseline).
// NOT part of the repo's suite. Written at 0.1.20 without the engine; run on 0.1.22 (output in results/). To run, from apps/firefox:
//   cp <bench>/e2e/b7-frames-ui.e2e.ts e2e/bench-b7-frames-ui.e2e.ts
//   corepack pnpm --filter firefox-ressac exec vitest run -c vitest.e2e.config.ts e2e/bench-b7-frames-ui.e2e.ts
//   rm e2e/bench-b7-frames-ui.e2e.ts
// Ports: 15480 (HTTP witness), 15481 (TCP counter). Every name is under SFX and resolves to 127.0.0.1.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import { startServer } from "./server";
import { inFrame, inUi, waitUi } from "./ui";
import { NET_PREFS, netEnv, resolvedNames, SFX, startNetWitness } from "./ui-network";

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const HTTP = 15480;
const RAW = 15481;
const web = (name: string) => `http://${name}.${SFX}:${HTTP}`;
const enc = (name: string) => encodeURIComponent(`${web(name)}/x/img`);

/** I3: addresses that are not http(s)/ws(s) by their text but make Firefox fetch a web address. */
const WRAPPED = (p: string) => [
  `jar:${web(`${p}-jar`)}/a.zip!/b.png`,
  `moz-remote-image://?url=${enc(`${p}-remoteimage`)}`,
  `view-source:${web(`${p}-viewsource`)}/x`,
  `page-icon:${web(`${p}-pageicon`)}/`,
  `moz-page-thumb://thumbnails/?url=${enc(`${p}-pagethumb`)}`,
  `cached-favicon:${web(`${p}-cachedfavicon`)}/favicon.ico`,
  `about:reader?url=${enc(`${p}-reader`)}`,
  `feed:${web(`${p}-feed`)}/`,
];
const framePage = `<!doctype html><meta charset="utf-8"><body style="margin:0"><p id="t">bench</p>
<script>
  const urls = ${JSON.stringify(WRAPPED("fr"))};
  for (const u of urls) { new Image().src = u; const f = document.createElement("iframe"); f.src = u; document.body.append(f); try { fetch(u).catch(() => {}); } catch (e) {} }
  // WebTransport and a nested data: document that fetches.
  try { new WebTransport("https://fr-webtransport.${SFX}:${HTTP}/w"); } catch (e) {}
  const d = document.createElement("iframe"); d.src = "data:text/html,<img src='${web("fr-datadoc")}/x/img'>"; document.body.append(d);
</script>`;

describe("bench B7: frames and the UI, extra vectors", () => {
  let w: LaunchedRessac;
  let m: LaunchedRessac["marionette"];
  let net: Awaited<ReturnType<typeof startNetWitness>>;
  let logDir: string;
  /** A frame <browser> on a copy `file` holding `html`, under #<id>; resolves once it reports "loaded". */
  const frame = async (id: string, file: string, html: string) => {
    await inUi(
      m,
      `const store = ChromeUtils.importESModule(${JSON.stringify(STORE)});
       const [id, file, html] = arguments;
       const dir = PathUtils.join(PathUtils.profileDir, "chrome", "ressac-frames", "widgets", "bench");
       await IOUtils.makeDirectory(dir);
       await IOUtils.writeUTF8(PathUtils.join(dir, file), html);
       const src = "resource://ressac-frames-" + store.framesToken() + "/widgets/bench/" + file;
       ui.__bench = ui.__bench || [];
       const host = doc.body.appendChild(doc.createElement("div"));
       host.id = id;
       host.style.cssText = "position: fixed; z-index: 99999; left: 0; top: 0; width: 200px; height: 100px; display: flex";
       const b = store.remoteFrames.createFrameBrowser(doc);
       b.style.flex = "1";
       host.append(b);
       store.remoteFrames.onFrameMessage(b, (name, data) => ui.__bench.push([id, name, data]));
       if (!store.remoteFrames.loadFrame(b, src)) throw new Error("not loaded");`,
      [id, file, html],
    );
    await waitUi(m, `return ui.__bench.some(([i, n]) => i === arguments[0] && n === "loaded");`, [id]);
  };
  /** The frame's current document, as the parent sees it. */
  const where = (id: string) =>
    inUi<{ uri: string; nullPrincipal: boolean; remoteType: string; sandboxed: boolean }>(
      m,
      `const store = ChromeUtils.importESModule(${JSON.stringify(STORE)});
       const b = doc.querySelector("#" + arguments[0] + " browser");
       const g = b.browsingContext.currentWindowGlobal;
       return { uri: g.documentURI.spec, nullPrincipal: g.documentPrincipal.isNullPrincipal, remoteType: g.domProcess ? g.domProcess.remoteType : "parent", sandboxed: b.browsingContext.sandboxFlags !== 0 };`,
      [id],
    );

  beforeAll(async () => {
    net = await startNetWitness({ http: HTTP, raw: RAW });
    logDir = await mkdtemp(path.join(os.tmpdir(), "ressac-b7-frames-"));
    w = await launchRessac({ prefs: NET_PREFS, env: netEnv(logDir) });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
  }, 120_000);
  afterAll(async () => {
    await w?.close();
    net?.close();
    if (logDir) await rm(logDir, { recursive: true, force: true });
  });
  /** The witness: a tab's own navigation resolves its name and reaches the server, so the log and the counters work. */
  const witness = async (name: string) => {
    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${web(name)}/`, activate: true });
    await expect.poll(() => net.hits.some((h) => h.label === name), { timeout: 15_000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 3000));
  };

  it("I3: an agent-written frame reaches no server through a wrapping scheme (jar:, moz-remote-image:, view-source:, page-icon:, about:reader…), WebTransport or a data: document", async () => {
    await frame("bench-wrapped", "wrapped.html", framePage);
    await witness("fr-witness");
    expect(net.hits.filter((h) => h.label.startsWith("fr-") && h.label !== "fr-witness").map((h) => `${h.label} ${h.path}`)).toEqual([]);
    expect((await resolvedNames(logDir)).filter((n) => n.startsWith("fr-") && n !== "fr-witness")).toEqual([]);
  }, 60_000);

  // Only privileged code can write into the sidebar (here Marionette, as Ressac's own code): this measures what such code
  // could fetch. README « UI network » states the limit: moz-remote-image: wrapping http in a system document is not covered.
  it("I3: the sidebar (a UI document of the parent process) reaches no server through a wrapping scheme, but the stated moz-remote-image: limit", async () => {
    await inUi(
      m,
      `for (const u of arguments[0]) { const i = doc.createElement("img"); i.src = u; doc.body.append(i); const f = doc.createElement("iframe"); f.src = u; f.style.display = "none"; doc.body.append(f); }`,
      [WRAPPED("ui")],
    );
    await witness("ui-witness");
    const hits = net.hits.filter((h) => h.label.startsWith("ui-") && h.label !== "ui-witness").map((h) => `${h.label} ${h.path}`);
    console.log("[I3] sidebar hits:", hits);
    expect(hits.filter((h) => !h.startsWith("ui-remoteimage "))).toEqual([]);
    expect((await resolvedNames(logDir)).filter((n) => n.startsWith("ui-") && n !== "ui-witness" && n !== "ui-remoteimage")).toEqual([]);
  }, 60_000);

  // I3, the reachable half: the UI shows tab icons (SiteIcon → shared/icon.ts keeps moz-remote-image: as is). A page
  // cannot hand the tab such an icon: LinkHandlerParent accepts only data: (SVG wrapped as moz-remote-image://?url=data:)
  // and chrome/about/resource icons from content.
  it("I3: a web page whose icon is a moz-remote-image: address wrapping the web makes the UI fetch nothing", async () => {
    const pageSrv = await startServer({
      routes: {
        "/icon": (_req, res) =>
          res.writeHead(200, { "Content-Type": "text/html" }).end(`<title>icon</title><link rel="icon" href="moz-remote-image://?url=${enc("pg-remoteicon")}&width=16">`),
      },
    });
    try {
      const url = `${pageSrv.url}/icon`;
      await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, activate: true });
      await waitFor(m, `const b = gBrowser.browsers.find((x) => x.currentURI.spec === ${JSON.stringify(url)}); return !!b && !b.webProgress.isLoadingDocument`, (v) => v === true);
      // Must not happen: the icon is picked once the page has loaded (LinkHandler's pageshow), the window starts after it.
      await new Promise((r) => setTimeout(r, 3000));
      const image = await m.execute<string>(`return gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)}).getAttribute("image") || ""`);
      expect(image.includes("pg-remoteicon"), image.slice(0, 80)).toBe(false);
      expect(net.hits.filter((h) => h.label === "pg-remoteicon")).toEqual([]);
    } finally {
      await pageSrv.close();
    }
  }, 60_000);

  // H4. A frame navigates itself away from its copy. Wherever it lands it must stay out of the parent process, with a
  // null principal, or be sent nothing; it must never show a privileged page.
  for (const [label, target] of [
    ["a chrome:// page", "chrome://browser/content/ressac/sidebar.html"],
    ["about:config", "about:config"],
    ["about:preferences", "about:preferences"],
    ["a resource:// file of Firefox", "resource://gre/modules/AppConstants.sys.mjs"],
    ["a file: address", "file:///etc/hosts"],
    ["a javascript: address", "javascript:document.title='js'"],
    ["a blob: document it made", "BLOB"],
  ] as const) {
    it(`H4: a frame navigating itself to ${label} stays sandboxed, out of the parent, and unprivileged`, async () => {
      const id = `bench-nav-${label.replace(/[^a-z]/g, "").slice(0, 12)}`;
      const go = target === "BLOB" ? `location = URL.createObjectURL(new Blob(["<p id=t>blob</p>"], { type: "text/html" }))` : `location = ${JSON.stringify(target)}`;
      await frame(id, `${id}.html`, `<!doctype html><p id="t">nav</p><script>setTimeout(() => { try { ${go} } catch (e) { document.title = "threw " + e.name } }, 300)</script>`);
      await new Promise((r) => setTimeout(r, 2500));
      const at = await where(id);
      console.log(`[H4] ${label}: now at ${at.uri.slice(0, 80)} (null principal ${at.nullPrincipal}, ${at.remoteType})`);
      expect(at.remoteType, "never the parent process").toMatch(/^webIsolated=resource:\/\/ressac-frames-/);
      expect(at.nullPrincipal || at.uri === "about:blank", "a null principal (or nothing loaded)").toBe(true);
      expect(at.uri.startsWith("chrome://") || /^about:(config|preferences)/.test(at.uri), "no privileged page shown").toBe(false);
    }, 60_000);
  }

  it("H4: a frame cannot read another widget's copy, nor Ressac's own files, by fetch or XHR", async () => {
    await frame("bench-read", "read.html", `<!doctype html><p id="t">read</p>`);
    await inUi(m, `await IOUtils.writeUTF8(PathUtils.join(PathUtils.profileDir, "chrome", "ressac-frames", "widgets", "bench", "other.html"), "<p>OTHER-WIDGET-SECRET</p>");`);
    const got = await inFrame<string[]>(
      m,
      "#bench-read browser",
      `Promise.all([location.href.replace("read.html", "other.html"), "chrome://browser/content/ressac/sidebar.html", "resource://gre/greprefs.js", "file:///etc/hosts"].map((u) => fetch(u).then((r) => r.text()).then((t) => "READ " + t.slice(0, 30), (e) => "refused")))`,
    );
    console.log("[H4] reads from a frame:", got);
    expect(got.filter((g) => g.startsWith("READ"))).toEqual([]);
  }, 60_000);

  // H5. The frames' address is content-accessible (a remote frame must load it): the per-launch token is what keeps a
  // web page out. Measured: what a web page that somehow knows the token can do with it (an agent-written display knows
  // its own address, and the "open" message can carry it to a page of an allowed domain).
  it("H5 (measured): a web page that knows the token — can it embed or read a frame copy?", async () => {
    await frame("bench-token", "token.html", `<!doctype html><p id="t">TOKEN-PAGE-SECRET</p>`);
    const src = await inUi<string>(m, `return "resource://ressac-frames-" + ChromeUtils.importESModule(${JSON.stringify(STORE)}).framesToken() + "/widgets/bench/token.html";`);
    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${web("h5-page")}/`, activate: true });
    await expect.poll(() => net.hits.some((h) => h.label === "h5-page"), { timeout: 15_000 }).toBe(true);
    const r = await m.execute<string>(
      `const b = gBrowser.selectedBrowser;
       return b.browsingContext.currentWindowGlobal.getActor("RessacFrame") ? "frame actor in a tab" : "no actor";`,
    ).catch((e) => `no frame actor in a web tab (${String(e).slice(0, 60)})`);
    console.log("[H5] actor in a web tab:", r);
    // The page tries from its own script, through Marionette's content context.
    await m.setContext("content");
    let out: string;
    try {
      out = await m.execute<string>(
        `const src = arguments[0];
         return Promise.all([
           fetch(src).then((x) => x.text()).then((t) => "fetch READ " + t.slice(0, 40), () => "fetch refused"),
           new Promise((ok) => { const f = document.createElement("iframe"); f.onload = () => { try { ok("iframe loaded, body: " + f.contentDocument.body.textContent.slice(0, 40)); } catch (e) { ok("iframe loaded, cross-origin (cannot read)"); } }; f.onerror = () => ok("iframe error"); f.src = src; document.body.append(f); setTimeout(() => ok("iframe: no load event"), 3000); }),
           new Promise((ok) => { const s = document.createElement("script"); s.onload = () => ok("script loaded"); s.onerror = () => ok("script refused"); s.src = src; document.body.append(s); }),
         ]).then((a) => a.join(" | "));`,
        [src],
      );
    } finally {
      await m.setContext("chrome");
    }
    console.log("[H5] a web page holding the token:", out);
    expect(out.includes("READ"), "a web page never reads a frame copy's text").toBe(false);
    expect(out.includes("TOKEN-PAGE-SECRET")).toBe(false);
  }, 60_000);

  it("H6: a frame cannot show a dialog, lock the pointer, open a window or start a download", async () => {
    await frame("bench-misc", "misc.html", `<!doctype html><p id="t">misc</p><a id="d" href="data:text/plain,x" download="bench-leak.txt">d</a>`);
    const r = await inFrame<Record<string, string>>(
      m,
      "#bench-misc browser",
      `(async () => {
         const out = {};
         const t0 = Date.now(); try { alert("x"); out.alert = Date.now() - t0 < 500 ? "returned at once" : "blocked the page"; } catch (e) { out.alert = "threw"; }
         try { await document.body.requestPointerLock(); out.pointerLock = document.pointerLockElement ? "LOCKED" : "no"; } catch (e) { out.pointerLock = "refused"; }
         try { const x = window.open("about:blank"); out.open = x ? "OPENED" : "null"; } catch (e) { out.open = "threw"; }
         // Clicked after this reply: the link can navigate the frame itself (to a data: page, H4), which would drop the reply.
         // window.name outlives that navigation: it proves the click ran.
         const d = document.getElementById("d");
         d.addEventListener("click", () => { window.name = "bench-clicked"; });
         setTimeout(() => d.click(), 50);
         out.download = "click scheduled";
         return out;
       })()`,
    );
    console.log("[H6]", r);
    expect(r.pointerLock === "LOCKED").toBe(false);
    expect(r.open === "OPENED").toBe(false);
    // The deferred click ran (in the frame's current document, whatever it navigated to).
    await expect.poll(() => inFrame<string>(m, "#bench-misc browser", "window.name").catch(() => ""), { timeout: 10_000 }).toBe("bench-clicked");
    // Must not happen: a download, given 1.5 s after the click that could start it.
    await new Promise((ok) => setTimeout(ok, 1500));
    const downloads = await m.execute<number>(`return (async () => { const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs"); return (await (await Downloads.getList(Downloads.ALL)).getAll()).filter((d) => d.target.path.includes("bench-leak")).length; })();`);
    expect(downloads).toBe(0);
  }, 60_000);
});
