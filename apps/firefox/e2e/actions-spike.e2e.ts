import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BARS, probe, startActionServers, writeComponent } from "./actions";
import { waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { inUi } from "./ui";

// Plan 33's spike (docs/superpowers/notes/2026-11-06-actions-firefox-spike.md): S1, an agent component in a sandboxed
// frame of the sidebar, served by store.actionMedia.serve; S2, the result images' anonymous channel. Rerun with
// WEBAIOS_SPIKE=1 after a Firefox version change and compare: the security lines are asserted.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const note = (what: string, v: unknown) => console.log(`[spike] ${what}: ${JSON.stringify(v)}`);
/** Runs `body` (an async function body) in the chrome context. */
const chrome = <T = any>(m: Marionette, body: string, args: unknown[] = []) => m.execute<T>(`return (async () => { ${body} })();`, args);

describe.skipIf(!process.env.WEBAIOS_SPIKE)("actions spike", () => {
  let servers: Awaited<ReturnType<typeof startActionServers>>;
  let w: LaunchedWebAiOs;
  let m: Marionette;
  /** What reached the S1 probe's server: requests, WebSocket upgrades, TCP connections. */
  const reached = { requests: [] as string[], upgrades: [] as string[], connections: 0 };
  let probeServer: Server;
  let probeBase: string;

  beforeAll(async () => {
    servers = await startActionServers();
    probeServer = createServer((req, res) => {
      if (req.url === "/page")
        return void res.writeHead(200, { "Content-Type": "text/html" }).end(
          `<script>document.title = JSON.stringify({ Components: typeof Components, keys: typeof Components === "undefined" ? [] : Object.keys(Components), interfaces: typeof Components === "undefined" ? [] : Object.keys(Components.interfaces ?? {}) });</script>`,
        );
      reached.requests.push(req.url ?? "/");
      res.writeHead(200).end("x");
    });
    probeServer.on("upgrade", (req, socket) => (reached.upgrades.push(req.url ?? "/"), socket.destroy()));
    // Connections: the baseline page's are counted after the component's measurement is kept.
    probeServer.on("connection", () => reached.connections++);
    await new Promise<void>((ok) => probeServer.listen(0, "127.0.0.1", ok));
    probeBase = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}`;
    w = await launchWebAiOs({ env: { WEBAIOS_TEST_ACTION_IMAGES: servers.images.url } });
    m = w.marionette;
    await m.setContext("chrome");
    await waitReady(m);
    const properties = { values: { kind: "reference", description: "Liste de { libelle, valeur }", required: true }, title: { kind: "texte", description: "Titre du graphique" } };
    await writeComponent(w.dataDir, "barres", { description: "Graphique en barres", properties: properties, html: BARS });
    await writeComponent(w.dataDir, "sonde", { description: "Sonde", properties: {}, html: probe(probeBase) });
  }, 60_000);
  afterAll(async () => {
    await w?.close();
    await servers?.close();
    await new Promise((ok) => (probeServer?.closeAllConnections(), probeServer?.close(ok)));
  });

  /** Serves `nom`, mounts it in a sandboxed frame of the sidebar (listened on the window root before it loads), sends it `props`. */
  const mount = (name: string, props: unknown, waitMs: number) =>
    inUi<any>(
      m,
      `const store = await ChromeUtils.importESModule("${STORE}").ready;
      const src = await store.actionMedia.serve(arguments[0]);
      const f = doc.createElement("iframe");
      f.setAttribute("sandbox", "allow-scripts");
      f.style.cssText = "position: fixed; left: 0; top: 0; width: 400px; height: 300px; border: none";
      const got = [];
      const listener = (e) => got.push({ detail: e.detail, fromFrame: e.target === f.contentWindow });
      ui.windowRoot.addEventListener("webaios-composant", listener, true, true);
      doc.documentElement.append(f);
      f.src = src;
      for (let i = 0; i < 100 && !(f.contentDocument?.documentURI === src && f.contentDocument.readyState === "complete"); i++) await new Promise((r) => setTimeout(r, 100));
      f.contentWindow.postMessage({ type: "composant", props: arguments[1], theme: "clair", largeur: 400 }, "*");
      await new Promise((r) => setTimeout(r, arguments[2]));
      ui.windowRoot.removeEventListener("webaios-composant", listener, true);
      const fd = f.contentDocument;
      const out = { src, loaded: fd?.documentURI, origin: fd?.defaultView.origin, csp: !!fd?.querySelector('meta[http-equiv="Content-Security-Policy"]'),
        titre: fd?.getElementById("titre")?.textContent ?? null, rects: fd ? fd.querySelectorAll("rect").length : -1,
        texts: fd ? [...fd.querySelectorAll("text")].map((t) => t.textContent) : [], got };
      f.remove();
      await store.actionMedia.release(arguments[0]);
      return out;`,
      [name, props, waitMs],
    );

  it("S1: AGENTS.md's « barres » draws with its props; its height reaches the chrome on the window root", async () => {
    const r = await mount("barres", { title: "Ventes", values: [{ label: "Lundi", value: 3 }, { label: "Mardi", value: 5 }] }, 500);
    note("S1 barres", r);
    expect(r.src).toMatch(/^resource:\/\/webaios-composant-barres\/composant-\d+\.html$/);
    expect(r.origin).toBe("null");
    expect(r.titre).toBe("Ventes");
    expect(r.rects).toBe(2);
    const heights = r.got.filter((g: any) => g.fromFrame).map((g: any) => JSON.parse(g.detail));
    expect(heights.some((h: any) => h.type === "hauteur" && h.px > 0)).toBe(true);
    // Released: the substitution and the copies are gone.
    const after = await chrome(
      m,
      `const h = Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
      return { substitution: h.hasSubstitution("webaios-composant-barres"), copies: await IOUtils.exists(PathUtils.join(arguments[0], "webaios-composants", "barres")) };`,
      [w.dataDir],
    );
    note("S1 after release", after);
    expect(after).toEqual({ substitution: false, copies: false });
  }, 60_000);

  it("S1: a component reaches neither the network (fetch, <img>, WebSocket) nor the chrome", async () => {
    const before = { ...reached, requests: [...reached.requests], upgrades: [...reached.upgrades] };
    const r = await mount("sonde", {}, 3500);
    const report = r.got.filter((g: any) => g.fromFrame).map((g: any) => JSON.parse(g.detail)).find((d: any) => d.type === "sonde")?.out;
    const componentReached = structuredClone(reached);
    // The baseline: the same globals in an ordinary web page (a tab on the probe server's /page, which writes them in its title).
    const baseline = await chrome(
      m,
      `const url = arguments[0] + "/page";
      const tab = gBrowser.addTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      for (let i = 0; i < 50 && !tab.linkedBrowser.contentTitle?.startsWith("{"); i++) await new Promise((r) => setTimeout(r, 100));
      const title = tab.linkedBrowser.contentTitle;
      gBrowser.removeTab(tab);
      return JSON.parse(title);`,
      [probeBase],
    ).catch((e) => String(e));
    note("S1 probe", { report, reached: componentReached, before, baseline, afterNavigation: r.loaded });
    expect(report).toBeDefined();
    expect(componentReached).toEqual({ requests: [], upgrades: [], connections: 0 });
    // The leftover web Components that COMPONENT_BRIDGE hides: in an ordinary page, `interfaces` only.
    expect(r.loaded).toBe(r.src);
    expect(baseline).toMatchObject({ Components: "object", keys: ["interfaces"] });
    expect({ Components: report.Components, ChromeUtils: report.ChromeUtils, Services: report.Services }).toEqual({ Components: "undefined", ChromeUtils: "undefined", Services: "undefined" });
  }, 60_000);

  it("S1: a component's navigation to another resource: URL (another component's copy, a Firefox resource)", async () => {
    // barres stays served meanwhile: its copy is a live resource:// URL to aim at.
    const bars = await chrome<string>(m, `return (await ChromeUtils.importESModule("${STORE}").ready).actionMedia.serve("barres");`);
    const out: Record<string, unknown> = {};
    for (const [name, target] of [["nav-composant", bars], ["nav-gre", "resource://gre/modules/NetUtil.sys.mjs"]] as const) {
      await writeComponent(w.dataDir, name, { description: "Sonde", properties: {}, html: `<!doctype html><script>setTimeout(() => { try { location.href = ${JSON.stringify(target)}; parent.postMessage({ type: "nav", thrown: null }, "*"); } catch (e) { parent.postMessage({ type: "nav", thrown: e.name + ": " + e.message }, "*"); } }, 200);</script>` });
      const r = await mount(name, {}, 1500);
      out[name] = { loaded: r.loaded, said: r.got.filter((g: any) => g.fromFrame).map((g: any) => g.detail) };
    }
    await chrome(m, `await (await ChromeUtils.importESModule("${STORE}").ready).actionMedia.release("barres");`);
    note("S1 resource navigation", { bars: bars, out });
  }, 60_000);

  /** The cookies on 127.0.0.1 of each container: default, profile p1, the action images'. */
  const cookies = () =>
    chrome<Record<string, string[]>>(
      m,
      `const mod = ChromeUtils.importESModule("${STORE}");
      const store = await mod.ready;
      const of = (userContextId) => Services.cookies.getCookiesFromHost("127.0.0.1", { userContextId }).map((c) => c.name + "=" + c.value).sort();
      return { default: of(0), p1: of(store.containerFor("p1")), actionImages: of(mod.actionImagesContainer()) };`,
    );

  it("S2: the anonymous channel sends no Cookie nor Referer, stores no Set-Cookie, and keeps LOAD_ANONYMOUS after a redirect", async () => {
    // The image server's cookie, set by a tab in the default container, one in profile p1's, one in the action images'.
    await chrome(
      m,
      `const mod = ChromeUtils.importESModule("${STORE}");
      const store = await mod.ready;
      for (const [userContextId, v] of [[0, "default"], [store.containerFor("p1"), "p1"], [mod.actionImagesContainer(), "action"]]) {
        const url = arguments[0] + "/cookie?v=" + v;
        const tab = gBrowser.addTab(url, { userContextId, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
        for (let i = 0; i < 50 && tab.linkedBrowser.currentURI.spec !== url; i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 500));
        gBrowser.removeTab(tab);
      }`,
      [servers.images.url],
    );
    const set = await cookies();
    note("S2 cookies set", set);
    expect(set).toEqual({ default: ["seen=default"], p1: ["seen=p1"], actionImages: ["seen=action"] });
    servers.images.seen.length = 0;
    const load = (anonymous: boolean, url: string) =>
      chrome(
        m,
        `const mod = ChromeUtils.importESModule("${STORE}");
        const ctx = mod.actionImagesContainer();
        const channels = [];
        const observer = { observe(s) {
          const ch = s.QueryInterface(Ci.nsIHttpChannel);
          if (!ch.URI.spec.startsWith(arguments[2])) return;
          channels.push({ url: ch.URI.spec, anonymous: !!(ch.loadFlags & Ci.nsIRequest.LOAD_ANONYMOUS), userContextId: ch.loadInfo.originAttributes.userContextId, referrer: ch.referrerInfo?.computedReferrerSpec ?? null });
        } };
        Services.obs.addObserver(observer, "http-on-modify-request");
        try {
          const image = await mod.loadImage(mod.containerRequests(ctx, { anonymous: arguments[0] }), arguments[1], { permise: () => true, cookies: false, max: 5242880 });
          return { image: image && { type: image.type, length: image.corps.length }, channels, ctx };
        } finally { Services.obs.removeObserver(observer, "http-on-modify-request"); }`.replace("arguments[2]", JSON.stringify(servers.images.url)),
        [anonymous, url],
      );
    const direct = await load(true, `${servers.images.url}/p.png`);
    const redirected = await load(true, `${servers.images.url}/hop`);
    const anonymousSeen = servers.images.seen.splice(0);
    const after = await cookies();
    note("S2 anonymous", { direct, redirected, seen: anonymousSeen, after });
    expect(direct.image).toEqual({ type: "image/png", length: 70 });
    expect(redirected.image).toEqual({ type: "image/png", length: 70 });
    expect(anonymousSeen.map((s) => s.path)).toEqual(["/p.png", "/hop", "/p.png"]);
    expect(anonymousSeen.every((s) => s.cookie === null && s.referer === null)).toBe(true);
    expect([direct.channels.length, redirected.channels.length]).toEqual([1, 2]);
    expect([...direct.channels, ...redirected.channels].every((c: any) => c.anonymous && c.userContextId === direct.ctx)).toBe(true);
    expect(after).toEqual(set);
    // Control: the same load without the flag (a cookie jar, as a site app's) sends the container's cookie, so the probe sees one.
    const control = await load(false, `${servers.images.url}/p.png`);
    const controlSeen = servers.images.seen.splice(0);
    const controlAfter = await cookies();
    note("S2 control (not anonymous)", { control, seen: controlSeen, after: controlAfter });
    expect(controlSeen[0]?.cookie).toBe("seen=action");
    expect(controlAfter.actionImages).toContain("leak=1");
  }, 60_000);

  it("S2: through the test hook, a redirect to 127.0.0.1 is refused before it is followed; an image arrives as data:", async () => {
    const before = await cookies();
    servers.images.seen.length = 0;
    const r = await chrome(
      m,
      `const store = await ChromeUtils.importESModule("${STORE}").ready;
      return { redirect: await store.actionMedia.image("https://img.exemple/r"), image: await store.actionMedia.image("https://img.exemple/p.png"),
        http: await store.actionMedia.image("http://img.exemple/p.png") };`,
    );
    const seen = servers.images.seen.splice(0);
    const after = await cookies();
    note("S2 hook", { redirect: r.redirect, image: r.image?.slice(0, 40), http: r.http, seen, before, after });
    expect(r.redirect).toBeNull();
    expect(seen.map((s) => s.path)).toEqual(["/img.exemple/r", "/img.exemple/p.png"]);
    expect(seen.every((s) => s.cookie === null && s.referer === null)).toBe(true);
    expect(r.image).toMatch(/^data:image\/png;base64,/);
    expect(r.http).toBeNull();
    expect(after).toEqual(before);
  }, 60_000);
});
