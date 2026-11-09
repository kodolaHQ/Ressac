import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "../firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "../launch";
import type { Marionette } from "../marionette";
import { inBrowser } from "../sites";

// Plan 35's spike S8 (docs/superpowers/notes/2026-11-06-mode-design-firefox-spikes.md, « S8, les applis de l'agent »):
// an agent app's window as store/sites.ts builds a site app's (apps-spike.sys.mjs, loaded in the parent from this
// folder: no build:ui), its badge, its favicon's source, its request guard, its container, and quitting.
// Security lines are asserted; the rest is printed as `[spike] <what>: <JSON>`. Rerun with WEBAIOS_SPIKE=1.
//
// Ports 5315–5317 on [::1] only: OrbStack holds 127.0.0.1:5300–5319 (the agent container's app range), so
// `localhost` could reach the real container. The origin rule is the same (scheme, host, port).

const note = (what: string, v: unknown) => console.log(`[spike] ${what}: ${JSON.stringify(v)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MODULE = "resource://webaios-spike-apps/apps-spike.sys.mjs";
const ATTEMPT = "http://[::1]:5315";
const OTHER_A = "http://[::1]:5316";
const OTHER = "http://[::1]:5317";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

type Hit = { port: number; path: string; cookie: string | undefined; at: number };
const hits: Hit[] = [];
const page = (title: string, body = "", head = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body style="margin:0;height:100vh;background:rgb(0,200,0)">${body}</body></html>`;

function route(port: number, req: IncomingMessage, res: ServerResponse): unknown {
  const u = new URL(req.url ?? "/", "http://x");
  hits.push({ port, path: u.pathname + u.search, cookie: req.headers.cookie, at: Date.now() });
  const html = (s: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(s);
  const png = () => res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
  const redirect = (to: string) => res.writeHead(302, { Location: to }).end();
  const p = u.pathname;
  if (port === 5317) {
    if (p === "/icon.png") return png();
    // A stand-in for the host's `docker exec` stopping the apps: answers after 1 s.
    if (p === "/stop") return void setTimeout(() => res.writeHead(200).end("stopped"), 1000);
    return html(page(`other ${p}`));
  }
  if (p === "/") return html(page(port === 5315 ? "Essai" : "Autre", "", '<link rel="icon" href="/icon.png">'));
  if (p === "/icon.png" || p === "/favicon.ico") return png();
  if (p === "/page2") return html(page("Page 2"));
  if (p === "/redir") return redirect(`${OTHER}/landed`);
  if (p === "/redir-same") return redirect("/page2");
  if (p === "/cross-icon") return html(page("Cross icon", "", `<link rel="icon" href="${OTHER}/icon.png">`));
  if (p === "/redir-icon") return html(page("Redirected icon", "", '<link rel="icon" href="/icon-302">'));
  if (p === "/icon-302") return redirect(`${OTHER}/icon.png`);
  if (p === "/noicon") return html(page("No icon"));
  if (p === "/data-icon") return html(page("Data icon", "", `<link rel="icon" href="data:image/png;base64,${PNG.toString("base64")}">`));
  res.writeHead(404).end();
}

describe.skipIf(!process.env.WEBAIOS_SPIKE)("agent app windows spike S8 (plan 35)", () => {
  const servers: Server[] = [];
  let w: LaunchedWebAiOs;
  let m: Marionette;

  const chrome = <T = any>(body: string, args: unknown[] = []) =>
    m.execute<T>(`return (async () => { const S = ChromeUtils.importESModule("${MODULE}"); ${body} })();`, args);
  const appWin = (d: string) => `[...Services.wm.getEnumerator("navigator:browser")].find((x) => x.document.documentElement.getAttribute("webaios-spike-app") === "${d}")`;
  const view = (d: string) => `${appWin(d)}.gBrowser.selectedBrowser`;
  const inView = <T = any>(d: string, script: string, gesture = false) => inBrowser<T>(m, view(d), script, { gesture });
  const viewUrl = (d: string) => m.execute<string>(`return ${view(d)}.currentURI.spec;`);
  const fromApp = (port: number, since: number, cookie = "essai=1") => hits.filter((h) => h.port === port && h.at >= since && h.cookie?.includes(cookie)).map((h) => h.path);
  const mainTabs = () => m.execute<{ url: string; uc: number }[]>(`return [...gBrowser.tabs].map((t) => ({ url: t.linkedBrowser.currentURI.spec, uc: t.userContextId }));`);
  async function openTab(url: string) {
    await dispatch(m, { type: "ouvrirOnglet", fenetreId: (await state(m)).fenetres[0]!.id, url });
    await waitFor(m, `return gBrowser.selectedBrowser.currentURI.spec === ${JSON.stringify(url)} && !gBrowser.selectedBrowser.webProgress.isLoadingDocument`, (v) => v === true);
  }
  /** The view is still on `url` and its page was not replaced (window.marque kept). */
  async function stays(d: string, url: string, what: string) {
    await sleep(700);
    expect(await viewUrl(d), what).toBe(url);
    expect(await inView(d, "return window.marque;"), what).toBe(7);
  }

  beforeAll(async () => {
    for (const port of [5315, 5316, 5317]) {
      const s = createServer((req, res) => route(port, req, res));
      await new Promise<void>((ok, ko) => s.once("error", ko).listen(port, "::1", ok));
      servers.push(s);
    }
    w = await launchWebAiOs();
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    await m.execute(
      `const res = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
       const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
       res.setSubstitution("webaios-spike-apps", Services.io.newFileURI(new FileUtils.File(arguments[0])));`,
      [import.meta.dirname],
    );
    const opened = await chrome(`return { essai: await S.open("essai", "${ATTEMPT}"), autre: await S.open("autre", "${OTHER_A}") };`);
    note("opened", opened);
  }, 120_000);
  afterAll(async () => {
    await w?.close();
    for (const s of servers) await new Promise((ok) => (s.closeAllConnections(), s.close(ok)));
  });

  // --- The badge ---------------------------------------------------------------------------------------------------

  it("badge: painted at the top right, clicks outside reach the page, enlarged to 300×320; neither sees the other", async () => {
    const placeAndProbe = async (wd: number, ht: number) => {
      const placed = await chrome<{ browser: number[]; frame: number[] }>(`return S.badge("essai", ${wd}, ${ht});`);
      await sleep(200);
      const [fx, fy, fw, fh] = placed.frame;
      const [bx, by] = placed.browser;
      const shot = await m.execute<{ inBadge: number[]; outside: number[] }>(
        `return (async () => { const win = ${appWin("essai")}, [fx, fy, fw, fh, bx, by] = arguments;
         const shot = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, win.devicePixelRatio, "white");
         const c = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
         c.width = shot.width; c.height = shot.height;
         const ctx = c.getContext("2d"); ctx.drawImage(shot, 0, 0);
         const at = (x, y) => [...ctx.getImageData(Math.round(x * win.devicePixelRatio), Math.round(y * win.devicePixelRatio), 1, 1).data].slice(0, 3);
         return { inBadge: at(fx + fw / 2, fy + fh / 2), outside: at(bx + 100, by + 300) }; })();`,
        [fx, fy, fw, fh, bx, by],
      );
      await inView("essai", "if (!window.got) for (const t of ['mousedown', 'click']) addEventListener(t, (e) => got.push(t + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY)), true); window.got = []; return 1;");
      const routed = await m.execute<{ onBadge: string; outside: string; badgeClicks: number }>(
        `return (async () => { const win = ${appWin("essai")}, [fx, fy, fw, fh, bx, by] = arguments, f = win.document.getElementById("spike-pastille");
         const hit = (x, y) => { const e = win.document.elementFromPoint(x, y); return e ? e.localName + (e.id ? "#" + e.id : "") : null; };
         const out = { onBadge: hit(fx + fw / 2, fy + fh / 2), outside: hit(bx + 100, by + 300) };
         const click = (x, y) => { win.synthesizeMouseEvent("mousedown", x, y, { button: 0, clickCount: 1 }); win.synthesizeMouseEvent("mouseup", x, y, { button: 0, clickCount: 1 }); };
         const before = f.contentWindow.clicks;
         click(fx + fw / 2, fy + fh / 2);
         click(bx + 100, by + 300);
         await new Promise((r) => win.setTimeout(r, 500));
         return { ...out, badgeClicks: f.contentWindow.clicks - before }; })();`,
        [fx, fy, fw, fh, bx, by],
      );
      const pageGot = await inView<string[]>("essai", "return window.got;");
      // What the page can know of the spot under the badge, and of its own frames and size.
      const pageView = await inView("essai", `const e = document.elementFromPoint(innerWidth - 12 - ${wd / 2}, 12 + ${ht / 2}); return { under: e && e.localName, frames: window.length, iframes: document.querySelectorAll("iframe").length, innerWidth, innerHeight };`);
      note(`badge ${wd}×${ht}`, { placed, shot, routed, pageGot, pageView });
      expect(shot.inBadge).toEqual([109, 94, 252]);
      expect(shot.outside).toEqual([0, 200, 0]);
      expect(routed).toEqual({ onBadge: "iframe#spike-pastille", outside: "browser", badgeClicks: 1 });
      // Security: the page never sees the click on the badge, nor the badge in its DOM or its size.
      expect(pageGot).toEqual(["mousedown@100,300", "click@100,300"]);
      expect(pageView).toMatchObject({ under: "body", frames: 0, iframes: 0, innerWidth: placed.browser[2], innerHeight: placed.browser[3] });
    };
    await placeAndProbe(48, 28);
    await placeAndProbe(88, 28);
    await placeAndProbe(300, 320);
    // Security: the badge's document reaches the chrome (it is chrome, as the overlay) but not the page: the view is remote.
    const badgeSide = await m.execute(
      `const win = ${appWin("essai")}, f = win.document.getElementById("spike-pastille"), v = win.gBrowser.selectedBrowser;
       return { type: f.contentWindow.docShell.itemType, system: f.contentDocument.nodePrincipal.isSystemPrincipal, top: f.contentWindow.top === win,
         viewRemote: v.isRemoteBrowser, viewDoc: v.contentDocument === null, viewWin: v.contentWindow === null,
         pageOtherProcess: v.browsingContext.currentWindowGlobal.osPid !== Services.appinfo.processID, badgeFrames: f.contentWindow.length };`,
    );
    note("badge side", badgeSide);
    expect(badgeSide).toMatchObject({ viewRemote: true, viewDoc: true, viewWin: true, pageOtherProcess: true, badgeFrames: 0 });
  });

  // --- The favicon -------------------------------------------------------------------------------------------------

  it("favicon: the source address is readable (onLinkIconAvailable), another origin's icon is set aside", async () => {
    await chrome(`S.log.icons.length = 0;`);
    for (const p of ["/", "/cross-icon", "/redir-icon", "/noicon", "/data-icon"]) {
      await chrome(`await S.load("essai", arguments[0]);`, [ATTEMPT + p]);
      await sleep(800);
    }
    await chrome(`await S.load("essai", arguments[0]);`, [ATTEMPT + "/"]);
    await sleep(500);
    const icons = await chrome<{ page: string; originalURL: string; icon: string; length: number; kept: boolean }[]>(`return S.log.icons.filter((i) => i.dossier === "essai");`);
    for (const i of icons) note("favicon", { ...i, page: i.page.replace(ATTEMPT, ""), originalURL: i.originalURL?.replace(ATTEMPT, "ESSAI").replace(OTHER, "OTHER") });
    const forPage = (p: string) => icons.filter((i) => i.page === ATTEMPT + p);
    expect(forPage("/").some((i) => i.kept && i.originalURL === `${ATTEMPT}/icon.png`)).toBe(true);
    expect(forPage("/cross-icon").every((i) => !i.kept)).toBe(true);
    expect(forPage("/cross-icon").some((i) => i.originalURL === `${OTHER}/icon.png`)).toBe(true);
  });

  // --- The guard ---------------------------------------------------------------------------------------------------

  it("guard: links, redirects and window.open off the origin are cancelled in the app and become main window tabs", async () => {
    await chrome(`await S.load("essai", arguments[0]);`, [ATTEMPT + "/"]);
    // A cookie in the app's container: it marks any request the app container sends (localhost cookies ignore the port).
    await inView("essai", "document.cookie = 'essai=1; max-age=3600; path=/'; window.marque = 7; return 1;");
    await chrome(`S.log.cancelled.length = 0; S.log.routed.length = 0;`);
    const since = Date.now();
    const main = await m.execute<number>("return gBrowser.tabs.length;");
    const appWindows = () => m.execute<number>(`return [...Services.wm.getEnumerator("navigator:browser")].length;`);
    const windowsBefore = await appWindows();
    const vectors: [string, string][] = [
      ["link to another port", `location.href = "${OTHER}/ext"`],
      // 127.0.0.2: never OrbStack (127.0.0.1), and the routed tab connects nowhere.
      ["link to the same port, another host", `location.href = "http://127.0.0.2:5315/"`],
      ["redirect off the origin", `location.href = "/redir"`],
      ["window.open", `window.open("${OTHER}/wo")`],
      ["window.open with features", `window.open("${OTHER}/wo-pop", "x", "width=300,height=300")`],
      ["target=_blank", `const a = document.createElement("a"); a.href = "${OTHER}/blank"; a.target = "_blank"; document.body.append(a); a.click()`],
    ];
    for (const [what, code] of vectors) {
      await inView("essai", `${code}; return 1;`, true);
      await stays("essai", `${ATTEMPT}/`, what);
    }
    await sleep(800);
    const log = await chrome(`return { cancelled: S.log.cancelled, routed: S.log.routed };`);
    const tabs = (await mainTabs()).slice(main);
    const reached = fromApp(5317, since);
    const viaIp = hits.filter((h) => h.at >= since && h.port === 5315 && h.cookie?.includes("essai=1") && h.path === "/").length;
    note("guard off-origin", { log: JSON.parse(JSON.stringify(log).replaceAll(OTHER, "OTHER")), tabs: tabs.map((t) => ({ ...t, url: t.url.replace(OTHER, "OTHER") })), reachedOtherWithAppCookie: reached, windowsBefore, windowsAfter: await appWindows() });
    // Security: the app container never sent a request to another origin, and nothing opened in it.
    expect(reached).toEqual([]);
    expect(viaIp).toBe(0);
    expect(await appWindows()).toBe(windowsBefore);
    expect(tabs.every((t) => t.uc === 0)).toBe(true);
    // A same-origin redirect stays in the app.
    await inView("essai", `location.href = "/redir-same"; return 1;`, true);
    await waitFor(m, `return ${view("essai")}.currentURI.spec;`, (u) => u === `${ATTEMPT}/page2`);
    note("guard same-origin redirect", await viewUrl("essai"));
    // Cleanup: the routed tabs.
    await m.execute(`for (const t of [...gBrowser.tabs].slice(arguments[0])) gBrowser.removeTab(t);`, [main]);
  });

  it("guard: file:, data: and blob: never load in the app view", async () => {
    await chrome(`await S.load("essai", arguments[0]);`, [ATTEMPT + "/"]);
    await inView("essai", "window.marque = 7; return 1;");
    await chrome(`S.log.rejected.length = 0;`);
    const system = "Services.scriptSecurityManager.getSystemPrincipal()";
    const file = `file://${w.profile}/user.js`;
    // ⌘O and a dropped file go through openLinkIn and droppedLinkHandler: the site-window.ts vectors.
    await m.execute(`${appWin("essai")}.openLinkIn(arguments[0], "current", { triggeringPrincipal: ${system} }); return 1;`, [file]);
    await stays("essai", `${ATTEMPT}/`, "⌘O file:");
    await m.execute(`${view("essai")}.droppedLinkHandler(null, [{ url: arguments[0], name: "", type: "" }], ${system}); return 1;`, [file]);
    await stays("essai", `${ATTEMPT}/`, "dropped file:");
    await m.execute(`${view("essai")}.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: ${system} }); return 1;`, ["data:text/html,<title>data</title>"]);
    await stays("essai", `${ATTEMPT}/`, "data: by the system principal");
    for (const [what, code] of [
      ["page file:", `location.href = "${file}"`],
      ["page data:", `location.href = "data:text/html,<title>data</title>"`],
      ["page blob:", `location.href = URL.createObjectURL(new Blob(["<title>blob</title>"], { type: "text/html" }))`],
    ] as const) {
      await inView("essai", `${code}; return 1;`, true);
      await stays("essai", `${ATTEMPT}/`, what);
    }
    note("guard non-web", await chrome(`return S.log.rejected;`));
  });

  // --- The containers ----------------------------------------------------------------------------------------------

  it("containers: cookies and storage are not shared between two apps, an app and a tab, or an app and a site app", async () => {
    await chrome(`await S.load("essai", arguments[0]);`, [ATTEMPT + "/"]);
    await inView("essai", "document.cookie = 'essai=1; max-age=3600; path=/'; localStorage.k = 'essai'; sessionStorage.k = 'essai'; return 1;");
    const read = "return { cookie: document.cookie, local: localStorage.k ?? null };";
    const other = await inView("autre", read);
    // A tab on the app's own origin (default container), then a site app's container on that origin.
    await openTab(`${ATTEMPT}/page2`);
    const tab = await inBrowser(m, "gBrowser.selectedBrowser", read);
    await inBrowser(m, "gBrowser.selectedBrowser", "document.cookie = 'tab=1; max-age=3600; path=/'; localStorage.k = 'tab'; return 1;");
    // Control: without containers, localhost cookies ignore the port (a tab on Autre's port sees the tab's cookie).
    await openTab(`${OTHER_A}/page2`);
    const tabOtherPort = await inBrowser<{ cookie: string }>(m, "gBrowser.selectedBrowser", read);
    const siteUc = await chrome<number>(`
      const { ContextualIdentityService: C } = ChromeUtils.importESModule("moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs");
      const name = "userContextIdInternal.webaios-site-spike";
      const found = C.getPrivateIdentity(name);
      if (found) return found.userContextId;
      C.ensureDataReady();
      const userContextId = ++C._lastUserContextId;
      C._identities.push({ userContextId, public: false, name });
      return userContextId;`);
    await m.execute(
      `const tab = gBrowser.addTab(arguments[0], { userContextId: arguments[1], triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); window.spikeSiteTab = tab;`,
      [`${ATTEMPT}/page2`, siteUc],
    );
    const siteTab = "window.spikeSiteTab.linkedBrowser";
    await waitFor(m, `return ${siteTab}.currentURI.spec === ${JSON.stringify(`${ATTEMPT}/page2`)} && !${siteTab}.webProgress.isLoadingDocument`, (v) => v === true);
    const site = await inBrowser(m, siteTab, read);
    await m.execute("gBrowser.removeTab(window.spikeSiteTab);");
    // And back: the app sees neither the tab's cookie nor its storage.
    await chrome(`await S.load("essai", arguments[0]);`, [ATTEMPT + "/page2"]);
    const attempt = await inView("essai", read);
    note("containers", { autre: other, tab, tabOtherPort, site, essai: attempt });
    expect(other).toEqual({ cookie: "", local: null });
    expect(tab).toEqual({ cookie: "", local: null });
    expect(site).toEqual({ cookie: "", local: null });
    expect(attempt).toEqual({ cookie: "essai=1", local: "essai" });
    expect(tabOtherPort.cookie).toContain("tab=1");
  });

  it("guard: a stopped app's container loads nothing", async () => {
    const uc = await chrome<number>(`return S.apps.get("autre").userContextId;`);
    await inView("autre", "document.cookie = 'autre=1; max-age=3600; path=/'; return 1;");
    await chrome(`await S.stop("autre"); S.log.cancelled.length = 0;`);
    const since = Date.now();
    // What could still load in its container: a tab or a window left behind, with the app's server still up.
    await m.execute(
      `const tab = gBrowser.addTab(arguments[0], { userContextId: arguments[1], triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
       window.spikeStrayTab = tab;`,
      [`${OTHER_A}/page2`, uc],
    );
    await sleep(1500);
    const stray = await m.execute<{ url: string; uc: number }>(`const b = window.spikeStrayTab.linkedBrowser; const out = { url: b.currentURI.spec, uc: window.spikeStrayTab.userContextId }; gBrowser.removeTab(window.spikeStrayTab); return out;`);
    const served = hits.filter((h) => h.port === 5316 && h.at >= since).map((h) => h.path);
    note("stopped container", { stray, served, cancelled: await chrome(`return S.log.cancelled;`) });
    // Security: no request from the stopped app's container reached its server.
    expect(served).toEqual([]);
    expect(stray.url).not.toBe(`${OTHER_A}/page2`);
  });

  // --- Quitting ----------------------------------------------------------------------------------------------------

  it("quit: the app window closes, then a profile-before-change blocker (the host's stop) has time to stop the apps", async () => {
    const hostPid = await m.execute<number>(`return (async () => (await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready).agent.pid)();`);
    // A stand-in for the host's apps stop: a subprocess (as the host's docker exec), during profile-before-change, as
    // the existing « stop the agent host » blocker; and the app window's close, noted with its time.
    await m.execute(
      `const { AsyncShutdown } = ChromeUtils.importESModule("resource://gre/modules/AsyncShutdown.sys.mjs");
       const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
       const curl = (p) => Subprocess.call({ command: "/usr/bin/curl", arguments: ["-s", "-g", "--max-time", "4", arguments[0] + p] }).then((x) => x.wait());
       const appWin = ${appWin("essai")};
       Services.ww.registerNotification({ observe: (w, topic) => topic === "domwindowclosed" && w === appWin && curl("/closed?t=" + Date.now()) });
       AsyncShutdown.profileBeforeChange.addBlocker("spike: stop the agent apps", async () => {
         const open = [...Services.wm.getEnumerator("navigator:browser")].filter((x) => x.document.documentElement.hasAttribute("webaios-spike-app")).length;
         await curl("/stop?appWindowsOpen=" + open + "&t=" + Date.now());
       });`,
      [OTHER],
    );
    const t0 = Date.now();
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const gone = async (pid: number) => {
      while (alive(pid)) await sleep(20);
      return Date.now() - t0;
    };
    const firefoxGone = gone(w.pid);
    const hostGone = hostPid ? gone(hostPid) : Promise.resolve(null);
    await w.close();
    const [firefoxExit, hostExit] = await Promise.all([firefoxGone, hostGone]);
    const at = (p: string) => hits.find((h) => h.port === 5317 && h.at >= t0 && h.path.startsWith(p));
    const closed = at("/closed");
    const stop = at("/stop");
    const result = {
      appWindowClosedMs: closed ? closed.at - t0 : null,
      stopAskedMs: stop ? stop.at - t0 : null,
      stopAnsweredMs: stop ? stop.at + 1000 - t0 : null,
      appWindowsOpenAtBlocker: stop ? new URL(stop.path, "http://x").searchParams.get("appWindowsOpen") : null,
      hostExitMs: hostExit,
      firefoxExitMs: firefoxExit,
    };
    note("quit", result);
    expect(stop).toBeTruthy();
    expect(firefoxExit).toBeGreaterThan(result.stopAnsweredMs!);
    expect(firefoxExit).toBeLessThan(5000);
  });
});
