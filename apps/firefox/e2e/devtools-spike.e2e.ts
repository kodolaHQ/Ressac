import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, it } from "vitest";
import { summarizeProfile } from "../../../packages/kernel/src/devtools/summaries";
import { geckoToCpuProfile } from "../chrome/store/devtools";
import { cleanupXpis, installAddon } from "./addons";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { waitUi } from "./ui";

// Probes of plan 28's unknowns (docs/superpowers/notes/2026-11-05-outils-dev-recherche.md, D1-D9): the agent's dev
// tools on one tab, inside the browser process, without any listening port. They print what they see rather than
// assert it: rerun them with WEBAIOS_SPIKE=1 after a Firefox version change and compare. No network.

const note = (what: string, v: unknown) => console.log(`[spike] ${what}: ${JSON.stringify(v)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- The pages ----------------------------------------------------------------------------------------------------

/** `/p?do=console` writes to the console and throws; `/p?do=net` makes requests; `/p` alone only loads. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>loading</title><body><img src="/cached.png"><div id="out">out</div>
<script>
const tag = location.search;
class Leaky { constructor(i) { this.i = i; this.payload = "leak-" + i; } }
window.leak = [];
function burn(ms) { const end = performance.now() + ms; let x = 0; while (performance.now() < end) x += Math.sqrt(x + 1); return x; }
function thrash(n) { const d = document.getElementById("out"); for (let i = 0; i < n; i++) { d.style.width = (100 + (i % 50)) + "px"; d.offsetWidth; } }
const q = new URLSearchParams(location.search);
if (q.get("do") === "console") {
  console.log("spike-log", tag, { a: 1, b: [1, 2] });
  console.info("spike-info", tag);
  console.warn("spike-warn", tag);
  console.error("spike-error", tag);
  console.debug("spike-debug", tag);
  setTimeout(function thrower() { throw new Error("spike-uncaught " + tag); }, 0);
  (async function rejecter() { throw new Error("spike-rejection " + tag); })();
}
if (q.get("do") === "net") {
  fetch("/data.json?token=secret&x=1", { headers: { Authorization: "Bearer spike" } }).then((r) => r.text());
  fetch("/post", { method: "POST", body: "hello", headers: { "Content-Type": "text/plain" } });
  const x = new XMLHttpRequest(); x.open("GET", "/xhr.txt"); x.send();
  fetch("/missing");
  fetch("/big.json");
  fetch("http://127.0.0.1:1/refused").catch(() => {});
  new Image().src = "/img.png?n=" + Math.random();
}
document.title = "loaded";
</script>`;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

/** Serves the pages; `hits` keeps every request's path and cache headers (D4). */
async function startPages(): Promise<{ url: string; hits: { path: string; h: Partial<IncomingHttpHeaders> }[]; close(): Promise<void> }> {
  const hits: { path: string; h: Partial<IncomingHttpHeaders> }[] = [];
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const h = req.headers;
    hits.push({ path: u.pathname + u.search, h: { "cache-control": h["cache-control"], pragma: h.pragma, "if-none-match": h["if-none-match"] } });
    if (u.pathname === "/p") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(PAGE);
    if (u.pathname === "/cached.png") return res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=3600", ETag: '"v1"' }).end(PNG);
    if (u.pathname === "/img.png") return res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
    if (u.pathname === "/data.json") return res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "s=1", "X-Spike": "1" }).end('{"ok":true}');
    if (u.pathname === "/big.json") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ big: "x".repeat(100_000) }));
    if (u.pathname === "/xhr.txt") return res.writeHead(200, { "Content-Type": "text/plain" }).end("xhr body");
    if (u.pathname === "/post") return void req.on("data", () => {}).on("end", () => res.writeHead(201, { "Content-Type": "text/plain" }).end("created"));
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((ok) => (server.close(() => ok()), server.closeAllConnections())) };
}

// --- Firefox side -------------------------------------------------------------------------------------------------

async function ready(m: Marionette): Promise<void> {
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  // The home page's agent session settles first: quitting during its start-up leaves writers in the data dir.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
}

const chrome = <T = any>(m: Marionette, body: string, args: unknown[] = []) => m.execute<T>(`return (async () => { ${body} })();`, args);

let opened = 0;
/** Opens `url` (made unique) in a WebAiOs tab of the first window and waits for its script; the browser is window.spikeBrowsers[name]. */
async function open(m: Marionette, name: string, page: string): Promise<void> {
  const url = `${page}${page.includes("?") ? "&" : "?"}k=${++opened}`;
  await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url });
  await waitFor(
    m,
    `const b = gBrowser.browsers.findLast((b) => b.currentURI.spec === ${JSON.stringify(url)} && b.contentTitle === "loaded");
     if (b) (window.spikeBrowsers ??= {})[${JSON.stringify(name)}] = b; return !!b;`,
    (v) => v === true,
  );
}

/**
 * Navigates the named browser itself (same tab) to `url` and waits for its script, then for the agent session's new
 * top-level target: it comes a little after the load, and the previous one is destroyed ("Target already destroyed").
 */
async function navigate(m: Marionette, name: string, url: string): Promise<void> {
  const targets = await m.execute<number | null>("return window.spikeSessions?.agent?.targets ?? null;");
  await m.execute("window.spikeBrowsers[arguments[0]].fixupAndLoadURIString(arguments[1], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });", [name, url]);
  await waitFor(m, `const b = window.spikeBrowsers[${JSON.stringify(name)}]; return b.currentURI.spec === ${JSON.stringify(url)} && b.contentTitle === "loaded";`, (v) => v === true);
  if (name === "a" && targets !== null) await waitFor(m, `const s = window.spikeSessions.agent; return s.targets > ${targets} && !s.commands.targetCommand.targetFront.isDestroyed();`, (v) => v === true);
}

/**
 * D9 / the mechanism under test: an in-process DevTools client on a local pipe (DevToolsServer.connectPipe, no socket),
 * the same `commands` the toolbox uses, watching console, errors, network and navigations of one tab.
 * Session state: window.spikeSessions[session] = { commands, console, net, docs }.
 */
const ATTACH = `
  const [session, name] = arguments;
  const t0 = Date.now();
  const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
  const { CommandsFactory } = require("devtools/shared/commands/commands-factory");
  const tab = gBrowser.getTabForBrowser(window.spikeBrowsers[name]);
  const commands = await CommandsFactory.forTab(tab);
  await commands.targetCommand.startListening();
  const s = { commands, console: [], net: [], docs: [], targets: 0 };
  // Each navigation of the tab brings a new top-level target (the previous one is destroyed): count them.
  await commands.targetCommand.watchTargets({ types: [commands.targetCommand.TYPES.FRAME], onAvailable: ({ targetFront }) => { if (targetFront.isTopLevel) s.targets++; } });
  const { TYPES } = commands.resourceCommand;
  await commands.resourceCommand.watchResources([TYPES.CONSOLE_MESSAGE, TYPES.ERROR_MESSAGE, TYPES.NETWORK_EVENT, TYPES.DOCUMENT_EVENT], {
    ignoreExistingResources: true,
    onAvailable: (list) => {
      for (const r of list) {
        if (r.resourceType === TYPES.NETWORK_EVENT) s.net.push(r);
        else if (r.resourceType === TYPES.DOCUMENT_EVENT) s.docs.push({ name: r.name, url: r.url ?? null, isFrameSwitching: r.isFrameSwitching ?? null, t: Date.now() });
        else s.console.push(r);
      }
    },
    // Network resources are updated in place (status, timings, sizes): nothing to do here.
    onUpdated: () => {},
  });
  (window.spikeSessions ??= {})[session] = s;
  const { DevToolsServer } = require("devtools/server/devtools-server");
  return { ms: Date.now() - t0, target: commands.targetCommand.targetFront.targetType, url: commands.targetCommand.targetFront.url,
    serverSockets: DevToolsServer.listeningSockets?.size ?? null, remoteEnabled: Services.prefs.getBoolPref("devtools.debugger.remote-enabled", false) };`;

/** The session's console messages since `from`, as text (grips from fronts). */
const CONSOLE = `
  const [session, from] = arguments;
  const s = window.spikeSessions[session];
  const grip = (g) => (g && typeof g.getGrip === "function" ? g.getGrip() : g);
  const text = (g) => {
    g = grip(g);
    if (g === null || typeof g !== "object") return String(g);
    if (g.type === "undefined") return "undefined";
    if (g.type === "longString") return g.initial + "…";
    if (g.class) {
      const p = g.preview?.ownProperties ? Object.fromEntries(Object.entries(g.preview.ownProperties).map(([k, v]) => [k, grip(v.value)?.class ?? grip(v.value)])) : g.preview?.items ?? null;
      return g.class + (p ? " " + JSON.stringify(p) : "");
    }
    return JSON.stringify(g);
  };
  const frames = (st) => (st ?? []).slice(0, 4).map((f) => (f.functionName || "(anonymous)") + "@" + f.filename.replace(/^https?:\\/\\/[^/]+/, "") + ":" + f.lineNumber + ":" + f.columnNumber);
  return s.console.slice(from).map((r) => r.pageError
    ? { kind: "error", text: text(r.pageError.errorMessage), name: r.pageError.errorMessageName ?? null, rejection: r.pageError.isPromiseRejection, stack: frames(r.pageError.stacktrace), exceptionStack: grip(r.pageError.exception)?.preview?.stack?.replace(/https?:\\/\\/[^/]+/g, "") ?? null, file: r.pageError.sourceName?.replace(/^https?:\\/\\/[^/]+/, ""), innerWindowID: r.pageError.innerWindowID, time: typeof r.pageError.timeStamp }
    : { kind: r.level, text: r.arguments.map(text).join(" "), stack: frames(r.stacktrace), file: r.filename?.replace(/^https?:\\/\\/[^/]+/, ""), chrome: r.chromeContext ?? false, innerWindowID: r.innerWindowID, time: typeof r.timeStamp });`;

/** The session's requests since `from`, with headers asked to each request's actor. */
const NETWORK = `
  const [session, from] = arguments;
  const s = window.spikeSessions[session];
  const client = s.commands.client;
  const out = [];
  for (const r of s.net.slice(from)) {
    const ask = (type) => client.request({ to: r.actor, type }).catch((e) => ({ error: String(e?.message ?? e) }));
    const rq = await ask("getRequestHeaders");
    const rs = await ask("getResponseHeaders");
    const tm = await ask("getEventTimings");
    out.push({
      id: r.resourceId, actor: r.actor, method: r.method, url: r.url.replace(/^https?:\\/\\/[^/]+/, "") || r.url, cause: r.cause?.type, nav: r.isNavigationRequest,
      status: r.status ?? null, statusText: r.statusText ?? null, totalTime: r.totalTime ?? null, transferredSize: r.transferredSize ?? null, contentSize: r.contentSize ?? null,
      mimeType: r.mimeType ?? null, fromCache: r.fromCache ?? null, blockedReason: r.blockedReason ?? null, timeStamp: r.timeStamp, innerWindowId: r.innerWindowId,
      reqHeaders: rq.headers?.map((h) => h.name + ": " + h.value) ?? rq, resHeaders: rs.headers?.map((h) => h.name + ": " + h.value) ?? rs, timings: tm.totalTime ?? tm,
    });
  }
  return out;`;

/** A response body by request actor: the text, or a long string read through its own actor. */
const BODY = `
  const [session, actor] = arguments;
  const client = window.spikeSessions[session].commands.client;
  const r = await client.request({ to: actor, type: "getResponseContent" });
  let t = r.content.text;
  const long = t && typeof t === "object" && t.type === "longString";
  if (long) t = (await client.request({ to: t.actor, type: "substring", start: 0, end: t.length })).substring;
  return { long, length: typeof t === "string" ? t.length : null, head: typeof t === "string" ? t.slice(0, 40) : t, encoding: r.content.encoding ?? null, mimeType: r.content.mimeType, discarded: r.contentDiscarded };`;

/**
 * D3: evaluation in the page's main world, top frame (the console's evaluateJSAsync). `await` in the code is mapped
 * like the console does (the debugger's parser worker); a returned promise is awaited (`mapped.await`). The value is
 * then read once more as JSON through `$_` (the last result), so the code itself runs only once.
 */
const EVAL = `
  const [session, code] = arguments;
  const s = window.spikeSessions[session];
  const grip = (g) => (g && typeof g.getGrip === "function" ? g.getGrip() : g);
  let expression = code, mapped = { await: true };
  if (code.includes("await")) {
    const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
    const { ParserDispatcher } = require("devtools/client/debugger/src/workers/parser/index");
    s.parser ??= new ParserDispatcher();
    const m = await s.parser.mapExpression(code, null, null, false, true);
    if (m) ({ expression, mapped } = m);
  }
  const t0 = Date.now();
  // The top-level target, not selectedTargetFront: only a toolbox moves that one, it goes stale after a navigation.
  const target = s.commands.targetCommand.targetFront;
  const r = await s.commands.scriptCommand.execute(expression, { mapped, selectedTargetFront: target });
  const out = { ms: Date.now() - t0, mappedAwait: !!mapped?.await, result: grip(r.result), hasException: !!r.exception || r.hasException, exceptionMessage: r.exceptionMessage ?? null,
    exceptionStack: r.exceptionStack?.slice(0, 4).map((f) => (f.functionName || "(anonymous)") + "@" + f.filename.replace(/^https?:\\/\\/[^/]+/, "") + ":" + f.lineNumber) ?? null,
    exception: r.exception ? (grip(r.exception)?.preview?.stack ?? grip(r.exception)) : null, errorMessageName: r.errorMessageName ?? null, topLevelAwaitRejected: r.topLevelAwaitRejected ?? false };
  if (!out.hasException && !out.topLevelAwaitRejected) {
    const j = await s.commands.scriptCommand.execute("JSON.stringify($_)", { selectedTargetFront: target });
    out.json = grip(j.result);
  }
  return out;`;

/** Each WebAiOs (Gecko) process's listening TCP sockets (D8), Marionette's own port (the control) set apart. */
async function listening(m: Marionette, w: LaunchedWebAiOs): Promise<{ pids: number; marionetteSeen: boolean; listen: string[] }> {
  const pids = await chrome<number[]>(m, `const i = await ChromeUtils.requestProcInfo(); return [i.pid, ...i.children.map((c) => c.pid)];`);
  const marionettePort = (await readFile(path.join(w.profile, "MarionetteActivePort"), "utf8")).trim();
  // lsof exits 1 when one pid has nothing to list: its stdout still holds the others.
  const out = await promisify(execFile)("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(",")]).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? "");
  const lines = out.split("\n").slice(1).filter(Boolean).map((l) => l.replace(/\s+/g, " "));
  return { pids: pids.length, marionetteSeen: lines.some((l) => l.includes(`:${marionettePort} `)), listen: lines.filter((l) => !l.includes(`:${marionettePort} `)) };
}

describe.skipIf(!process.env.WEBAIOS_SPIKE)("agent dev tools spike", () => {
  let pages: Awaited<ReturnType<typeof startPages>>;
  let other: Awaited<ReturnType<typeof startPages>>;
  let w: LaunchedWebAiOs;
  let m: Marionette;
  let before: Awaited<ReturnType<typeof listening>>;
  beforeAll(async () => {
    pages = await startPages();
    other = await startPages();
    w = await launchWebAiOs();
    m = w.marionette;
    await ready(m);
    before = await listening(m, w);
    note("D8 listening before the probes", before);
  }, 90_000);
  afterAll(async () => {
    await w?.close();
    await cleanupXpis();
    await Promise.all([pages?.close(), other?.close()]);
  });

  it("D9 + D1: an in-process DevTools client per tab; console and errors of this tab only; reload", { timeout: 120_000 }, async () => {
    // A content script that logs on every page of the test sites (an extension's messages must not reach the tab's buffer).
    const addon = await installAddon(m, {
      id: "logger@webaios.test",
      manifest: { manifest_version: 2, name: "Logger", version: "1.0", browser_specific_settings: { gecko: { id: "logger@webaios.test" } },
        content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["cs.js"], run_at: "document_end" }] },
      files: { "cs.js": 'console.log("spike-content-script", location.search);' },
    });
    note("D1 extension installed", addon);
    await open(m, "a", `${pages.url}/p`);
    note("D9 attach (CommandsFactory.forTab on DevToolsServer.connectPipe)", await chrome(m, ATTACH, ["agent", "a"]));
    // Same site, other tab; same site, other container.
    await open(m, "b", `${pages.url}/p?do=console&tag=othertab`);
    note("D1 other container tab", await chrome(m, `
      const tab = gBrowser.addTab(arguments[0], { userContextId: 1, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      window.spikeBrowsers.c = tab.linkedBrowser;
      for (let i = 0; i < 100 && tab.linkedBrowser.contentTitle !== "loaded"; i++) await new Promise((r) => setTimeout(r, 100));
      return { title: tab.linkedBrowser.contentTitle, userContextId: tab.userContextId, samePid: tab.linkedBrowser.browsingContext.currentWindowGlobal?.osPid === window.spikeBrowsers.a.browsingContext.currentWindowGlobal?.osPid };`,
      [`${pages.url}/p?do=console&tag=othercontainer`]));
    note("D1 pids (a, b same site other tab)", await chrome(m, `return ["a", "b"].map((n) => window.spikeBrowsers[n].browsingContext.currentWindowGlobal.osPid);`));
    // This tab navigates (same site) to the console page.
    const url = `${pages.url}/p?do=console&tag=this`;
    await navigate(m, "a", url);
    await sleep(1000);
    note("D1 this tab, after a same-site navigation", await chrome(m, CONSOLE, ["agent", 0]));
    note("D1 document events", await chrome(m, `return window.spikeSessions.agent.docs.map((d) => d.name + (d.isFrameSwitching ? " (switch)" : "") + " " + (d.url ?? "").replace(/^https?:\\/\\/[^/]+/, ""));`));
    const n = await chrome<number>(m, "return window.spikeSessions.agent.console.length;");
    const docs = await chrome<number>(m, "return window.spikeSessions.agent.docs.length;");
    await m.execute("window.spikeBrowsers.a.reload();");
    await waitFor(m, "return window.spikeBrowsers.a.contentTitle === 'loaded'", (v) => v === true);
    await sleep(1000);
    note("D1 after reload, new messages", await chrome(m, CONSOLE, ["agent", n]));
    note("D1 after reload, document events", await chrome(m, `return window.spikeSessions.agent.docs.slice(arguments[0]).map((d) => d.name);`, [docs]));
    note("D1 target after reload", await chrome(m, `const t = window.spikeSessions.agent.commands.targetCommand.targetFront; return { type: t.targetType, url: t.url.replace(/^https?:\\/\\/[^/]+/, ""), destroyed: t.isDestroyed() };`));
  });

  it("D2: network of this tab, headers, body on demand, a failure", { timeout: 60_000 }, async () => {
    const from = await chrome<number>(m, "return window.spikeSessions.agent.net.length;");
    await navigate(m, "a", `${pages.url}/p?do=net`);
    await sleep(1500);
    const net = await chrome<any[]>(m, NETWORK, ["agent", from]);
    note("D2 requests", net.map(({ actor: _a, reqHeaders, resHeaders, ...r }) => ({ ...r, reqHeaders: reqHeaders?.length ?? reqHeaders, resHeaders: resHeaders?.length ?? resHeaders })));
    const data = net.find((r) => r.url.startsWith("/data.json"));
    note("D2 /data.json headers (Authorization, Cookie, Set-Cookie seen in clear?)", { req: data?.reqHeaders, res: data?.resHeaders });
    for (const p of ["/data.json", "/big.json", "/img.png", "/post", "/p?do=net"]) {
      const r = net.find((x) => x.url.startsWith(p));
      note(`D2 body ${p}`, r ? await chrome(m, BODY, ["agent", r.actor]) : "no request");
    }
    note("D2 other tab's requests in this session", (await chrome<any[]>(m, NETWORK, ["agent", 0])).filter((r) => r.url.includes("othertab") || r.url.includes("othercontainer")).length);
  });

  it("D3: evaluation in the page's main world", { timeout: 60_000 }, async () => {
    for (const [label, code] of [
      ["JSON value", "({ a: 1, b: [1, 'x'], c: null })"],
      ["number", "6 * 7"],
      ["undefined", "undefined"],
      ["NaN", "0/0"],
      ["bigint", "10n ** 20n"],
      ["DOM node", "document.body"],
      ["cycle", "(() => { const o = {}; o.o = o; return o; })()"],
      ["page global", "typeof burn + ' ' + document.title + ' ' + location.pathname"],
      ["returned promise", "new Promise((r) => setTimeout(() => r({ done: 1 }), 50))"],
      ["top-level await", "const v = await new Promise((r) => setTimeout(() => r(21), 50)); v * 2"],
      ["thrown Error", "function f() { throw new Error('spike-eval-error'); } f()"],
      ["rejected promise", "Promise.reject(new TypeError('spike-reject'))"],
      ["await rejected", "await Promise.reject(new RangeError('spike-await-reject'))"],
      ["thrown string", "throw 'plain string'"],
      ["syntax error", "let = ;"],
      ["console from eval", "console.log('spike-from-eval'); 1"],
    ] as const) note(`D3 ${label}`, await chrome(m, EVAL, ["agent", code]));
    const nc = await chrome<number>(m, "return window.spikeSessions.agent.console.length;");
    note("D3 await rejected, again", await chrome(m, EVAL, ["agent", "await Promise.reject(new RangeError('spike-await-reject-2'))"]));
    await sleep(300);
    note("D3 console after the rejected await", await chrome(m, CONSOLE, ["agent", nc]));
    note("D3 settled promise grip (no mapped.await)", await chrome(m, `
      const s = window.spikeSessions.agent, target = s.commands.targetCommand.targetFront;
      const p = await s.commands.scriptCommand.execute("window.spikeP = Promise.reject(new TypeError('spike-settled')); window.spikeP.catch(() => {}); window.spikeP", { selectedTargetFront: target });
      await new Promise((r) => setTimeout(r, 50));
      const again = await s.commands.scriptCommand.execute("window.spikeP", { selectedTargetFront: target });
      const g = again.result.getGrip();
      return { class: g.class, promiseState: g.preview?.promiseState ?? g.promiseState ?? null, keys: Object.keys(g.preview ?? {}) };`));
    // Two steps, so a rejection keeps its stack: run the (mapped) code without awaiting, wait for the promise to settle
    // through _self, then ask the promise actor for its state.
    note("D3 two-step await (promiseState)", await chrome(m, `
      const s = window.spikeSessions.agent, target = s.commands.targetCommand.targetFront, client = s.commands.client;
      const out = [];
      const step = (what, p) => Promise.race([p, new Promise((_, ko) => setTimeout(() => ko(new Error("stuck at " + what)), 3000))]);
      for (const code of ["(async () => { await null; throw new RangeError('spike-two-step'); })()", "(async () => { await null; return { v: 7 }; })()"]) {
        try {
        const p = await step("execute", s.commands.scriptCommand.execute(code, { selectedTargetFront: target }));
        const actor = p.result.actorID;
        let st;
        for (let i = 0; i < 100; i++) {
          st = await step("promiseState", p.result.getPromiseState());
          if (st.promiseState.state !== "pending") break;
          await new Promise((r) => setTimeout(r, 20));
        }
        const g = st.promiseState.reason ?? st.promiseState.value;
        let json = null;
        const gr = g?.getGrip ? g.getGrip() : g;
        if (st.promiseState.state === "fulfilled" && gr?.actor) json = (await step("json", s.commands.scriptCommand.execute("JSON.stringify(_self)", { selectedTargetFront: target, selectedObjectActor: gr.actor }))).result;
        out.push({ state: st.promiseState.state, class: gr?.class ?? null, message: gr?.preview?.message ?? null, stack: gr?.preview?.stack ?? null, json });
        } catch (e) { out.push({ error: String(e) }); }
      }
      return out;`));
    await sleep(300);
    note("D3 console of the eval (is it marked?)", (await chrome<any[]>(m, CONSOLE, ["agent", 0])).filter((c) => c.text.includes("spike-from-eval")));
  });

  it("D4: reload with and without cache", { timeout: 60_000 }, async () => {
    await navigate(m, "a", `${pages.url}/p?do=plain`);
    for (const bypass of [false, true]) {
      const from = pages.hits.length;
      const t0 = Date.now();
      await chrome(m, "await window.spikeSessions.agent.commands.targetCommand.reloadTopLevelTarget(arguments[0]);", [bypass]);
      note(`D4 reloadTopLevelTarget(${bypass})`, { ms: Date.now() - t0, hits: pages.hits.slice(from) });
    }
    for (const flags of ["LOAD_FLAGS_NONE", "LOAD_FLAGS_BYPASS_CACHE"]) {
      const from = pages.hits.length;
      await m.execute(`window.spikeBrowsers.a.reloadWithFlags(Ci.nsIWebNavigation.${flags});`);
      await sleep(1000);
      note(`D4 browser.reloadWithFlags(${flags})`, pages.hits.slice(from));
    }
  });

  it("D5: Gecko profiler limited to the tab's process, converted to CpuProfile; metrics", { timeout: 90_000 }, async () => {
    await navigate(m, "a", `${pages.url}/p?do=plain`);
    const info = await chrome(m, `
      const b = window.spikeBrowsers.a;
      const wg = b.browsingContext.currentWindowGlobal;
      window.spikeProf = { pid: wg.osPid, innerWindowId: wg.innerWindowId, browserId: b.browserId };
      const active = Services.profiler.IsActive();
      await Services.profiler.StartProfiler(1 << 22, 1, ["js", "stackwalk", "cpu"], ["pid:" + wg.osPid], b.browserId);
      return { ...window.spikeProf, activeBefore: active, activeNow: Services.profiler.IsActive() };`);
    note("D5 start", info);
    await chrome(m, EVAL, ["agent", "setTimeout(() => { burn(300); thrash(300); }, 0); 1"]);
    await sleep(1200);
    const prof = await chrome<any>(m, `
      const p = await Services.profiler.getProfileDataAsync();
      await Services.profiler.StopProfiler();
      const { pid, innerWindowId } = window.spikeProf;
      const procs = [{ meta: p.meta, threads: p.threads }, ...p.processes];
      const shape = procs.map((x) => ({ pid: x.threads[0]?.pid ?? null, type: x.meta.processType, threads: x.threads.map((t) => t.name).slice(0, 6), nThreads: x.threads.length }));
      const proc = procs.find((x) => x.threads.some((t) => String(t.pid) === String(pid)));
      const main = proc?.threads.find((t) => t.name === "GeckoMain");
      const mk = main ? main.markers.data.map((d) => main.stringTable[d[main.markers.schema.name]]) : [];
      const counts = {};
      for (const n of mk) counts[n] = (counts[n] ?? 0) + 1;
      return { version: p.meta.version, interval: proc?.meta.interval, shape, threadKeys: main ? Object.keys(main) : null, categories: proc?.meta.categories.map((c) => c.name),
        samples: main?.samples.data.length, markerCounts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15)), main, innerWindowId,
        bytes: JSON.stringify(p).length, sampleSchema: main?.samples.schema,
        jsFrames: main ? [...new Set(main.frameTable.data.filter((f) => f[main.frameTable.schema.category] === 4).map((f) => main.stringTable[f[main.frameTable.schema.location]] + " | impl=" + f[main.frameTable.schema.implementation] + " line=" + f[main.frameTable.schema.line] + " win=" + f[main.frameTable.schema.innerWindowID] + " rel=" + f[main.frameTable.schema.relevantForJS]))].slice(0, 12) : null,
        // Reflow markers: one start (phase 2) and one end (3) per reflow, or one interval (1).
        reflows: main ? main.markers.data.filter((d) => main.stringTable[d[main.markers.schema.name]].startsWith("Reflow") && d[main.markers.schema.phase] !== 3).length : null,
        reflowPhases: main ? main.markers.data.filter((d) => main.stringTable[d[main.markers.schema.name]] === "Reflow (sync)").reduce((a, d) => ((a[d[main.markers.schema.phase]] = (a[d[main.markers.schema.phase]] ?? 0) + 1), a), {}) : null };`);
    const { main, ...rest } = prof;
    note("D5 profile", rest);
    if (main) {
      const r = geckoToCpuProfile(main, prof.categories.map((name: string) => ({ name })), new Set([prof.innerWindowId]));
      note("D5 conversion", { nodes: r.profile.nodes.length, samples: r.profile.samples.length, scriptMs: Math.round(r.scriptMs), taskMs: Math.round(r.taskMs),
        durationMs: Math.round((r.profile.endTime - r.profile.startTime) / 1000) });
      note("D5 resumerProfil", summarizeProfile(r.profile, { LayoutCount: prof.reflows, ScriptDuration: r.scriptMs / 1000, TaskDuration: r.taskMs / 1000 }, 8).split("\n"));
    }
    // Metrics: memory actor measure() (sizeOfTab) and, privileged in the page's process, a frame script.
    note("D5 memory.measure()", await chrome(m, `
      const mem = await window.spikeSessions.agent.commands.targetCommand.targetFront.getFront("memory");
      return await mem.measure();`));
  });

  it("D6: heap census of the tab's page, by object class, twice", { timeout: 60_000 }, async () => {
    const census = `
      const mem = await window.spikeSessions.agent.commands.targetCommand.targetFront.getFront("memory");
      if ((await mem.getState()) !== "attached") await mem.attach();
      const t0 = Date.now();
      const c = await mem.takeCensus();
      const ms = Date.now() - t0;
      const leaf = (x) => (x && typeof x === "object" ? (typeof x.count === "number" ? [x] : Object.values(x).flatMap(leaf)) : []);
      const total = leaf(c).reduce((a, x) => a + x.bytes, 0);
      const top = (o) => Object.entries(o ?? {}).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8).map(([k, v]) => [k, v.count, v.bytes]);
      return { ms, keys: Object.keys(c), total, count: leaf(c).reduce((a, x) => a + x.count, 0), objects: top(c.objects), domNode: top(c.domNode), strings: c.strings, scripts: c.scripts, raw: c,
        jsonBytes: JSON.stringify(c).length };`;
    const one = await chrome<any>(m, census);
    note("D6 census 1", { ...one, raw: undefined });
    await chrome(m, EVAL, ["agent", "for (let i = 0; i < 20000; i++) window.leak.push(new Leaky(i)); for (let i = 0; i < 500; i++) document.body.append(document.createElement('section')); 1"]);
    const two = await chrome<any>(m, census);
    note("D6 census 2", { ...two, raw: undefined });
    const grow: [string, number, number][] = Object.entries(two.raw.objects as Record<string, { count: number; bytes: number }>)
      .map(([k, v]) => [k, v.count - (one.raw.objects[k]?.count ?? 0), v.bytes - (one.raw.objects[k]?.bytes ?? 0)] as [string, number, number])
      .sort((a, b) => b[2] - a[2]).slice(0, 5);
    note("D6 grew (objects by class)", grow);
    note("D6 grew (domNode)", Object.entries(two.raw.domNode as Record<string, { count: number }>).map(([k, v]) => [k, v.count - (one.raw.domNode[k]?.count ?? 0)]).filter((x) => x[1] !== 0));
    // The alternative without a DevTools server: a snapshot file of the page global, read back in the parent.
    note("D6 ChromeUtils heap snapshot from a frame script", await chrome(m, `
      const mm = window.spikeBrowsers.a.messageManager;
      const got = new Promise((ok) => { const l = (msg) => { mm.removeMessageListener("spike:heap", l); ok(msg.data); }; mm.addMessageListener("spike:heap", l); });
      const fs = () => {
        try {
          const t0 = Date.now();
          const path = ChromeUtils.saveHeapSnapshot({ runtime: true });
          const snap = ChromeUtils.readHeapSnapshot(path);
          const c = snap.takeCensus({ breakdown: { by: "objectClass", then: { by: "count", count: true, bytes: true }, other: { by: "count", count: true, bytes: true } } });
          sendAsyncMessage("spike:heap", { ms: Date.now() - t0, path: path.replace(/.*\\//, "…/"), leaky: c.Object?.count ?? null, classes: Object.keys(c).length });
        } catch (e) { sendAsyncMessage("spike:heap", { error: String(e) }); }
      };
      mm.loadFrameScript("data:," + encodeURIComponent("(" + fs + ")()"), false);
      return await Promise.race([got, new Promise((ok) => setTimeout(() => ok("no answer in 10 s"), 10000))]);`));
  });

  it("D9: privileged code in the page's process without a new actor (frame script)", { timeout: 60_000 }, async () => {
    note("D9 frame script", await chrome(m, `
      const mm = window.spikeBrowsers.a.messageManager;
      const got = new Promise((ok) => { const l = (msg) => { mm.removeMessageListener("spike:fs", l); ok(msg.data); }; mm.addMessageListener("spike:fs", l); });
      const fs = () => {
        try {
          const d = content.document;
          sendAsyncMessage("spike:fs", { url: d.location.pathname, nodes: d.getElementsByTagName("*").length, allNodes: d.createTreeWalker(d, 0xFFFFFFFF).nextNode ? "walker ok" : null,
            framesReflowed: content.windowUtils.framesReflowed, framesConstructed: content.windowUtils.framesConstructed, system: Cu.getObjectPrincipal(this).isSystemPrincipal,
            pageGlobalXray: typeof content.burn, waived: typeof Cu.waiveXrays(content).burn, remoteType: Services.appinfo.remoteType, pid: Services.appinfo.processID });
        } catch (e) { sendAsyncMessage("spike:fs", { error: String(e) }); }
      };
      const pid = window.spikeBrowsers.a.browsingContext.currentWindowGlobal.osPid;
      mm.loadFrameScript("data:," + encodeURIComponent("(" + fs + ")()"), false);
      return { tabPid: pid, answer: await Promise.race([got, new Promise((ok) => setTimeout(() => ok("no answer in 10 s"), 10000))]) };`));
    note("D9 existing actors in the tab (window global)", await chrome(m, `
      const wg = window.spikeBrowsers.a.browsingContext.currentWindowGlobal;
      const out = {};
      for (const name of ["WebAiOsPage", "Conduits", "MarionetteCommands"]) { try { out[name] = !!wg.getActor(name); } catch (e) { out[name] = e.name; } }
      try { out["DevToolsProcess (process actor)"] = !!wg.domProcess.getActor("DevToolsProcess"); } catch (e) { out["DevToolsProcess (process actor)"] = e.name; }
      return out;`));
  });

  it("D7: the person's own toolbox on the same tab", { timeout: 90_000 }, async () => {
    const opened = await chrome(m, `
      const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
      const { gDevTools } = require("devtools/client/framework/devtools");
      const tab = gBrowser.getTabForBrowser(window.spikeBrowsers.a);
      const t0 = Date.now();
      const toolbox = await gDevTools.showToolboxForTab(tab, { toolId: "webconsole" });
      window.spikeToolbox = toolbox;
      return { ms: Date.now() - t0, host: toolbox.hostType, tool: toolbox.currentToolId };`);
    note("D7 toolbox opened", opened);
    const n = await chrome<number>(m, "return window.spikeSessions.agent.console.length;");
    const nNet = await chrome<number>(m, "return window.spikeSessions.agent.net.length;");
    await navigate(m, "a", `${pages.url}/p?do=console&tag=withtoolbox`);
    await sleep(1500);
    note("D7 agent console with the toolbox open", (await chrome<any[]>(m, CONSOLE, ["agent", n])).map((c) => `${c.kind}: ${c.text}`));
    note("D7 agent network with the toolbox open", (await chrome<any[]>(m, NETWORK, ["agent", nNet])).map((r) => `${r.method} ${r.url} ${r.status}`));
    note("D7 agent eval with the toolbox open", await chrome(m, EVAL, ["agent", "document.title + ' ' + location.search"]));
    note("D7 toolbox's own console output", await chrome(m, `
      const hud = window.spikeToolbox.getPanel("webconsole").hud;
      for (let i = 0; i < 50 && !hud.ui.outputNode.textContent.includes("withtoolbox"); i++) await new Promise((r) => setTimeout(r, 100));
      const text = hud.ui.outputNode.textContent;
      return { log: text.includes("spike-log"), uncaught: text.includes("spike-uncaught"), rejection: text.includes("spike-rejection"), sawAgentEval: text.includes("spike-from-eval") };`));
    note("D7 toolbox's own evaluation", await chrome(m, `const r = await window.spikeToolbox.commands.scriptCommand.execute("40 + 2"); return r.result;`));
    // The agent detaches while the toolbox stays open, then the toolbox closes; then the agent attaches again.
    note("D7 agent detaches, toolbox still evaluates", await chrome(m, `
      await window.spikeSessions.agent.commands.destroy();
      const r = await window.spikeToolbox.commands.scriptCommand.execute("1 + 1");
      return { toolbox: r.result, toolboxAlive: !!window.spikeToolbox.target && !window.spikeToolbox.target.isDestroyed() };`));
    note("D7 agent re-attaches with the toolbox open", await chrome(m, ATTACH, ["agent", "a"]));
    note("D7 toolbox closes", await chrome(m, `await window.spikeToolbox.destroy(); return "closed";`));
    note("D7 agent eval after the toolbox closed", await chrome(m, EVAL, ["agent", "6 * 7"]));
  });

  it("D3b: an endless loop in the page, and getting out of it", { timeout: 120_000 }, async () => {
    // Its own site (localhost, another process), so the hang only hits this page.
    await open(m, "loop", `${other.url.replace("127.0.0.1", "localhost")}/p`);
    note("D3b attach", await chrome(m, ATTACH, ["loop", "loop"]));
    await chrome(m, `
      // Marionette turns hang reports off (RecommendedPreferences); a person's Firefox has them on, after 10 s and a key or click.
      window.spikeHangPrefs = { report: Services.prefs.getBoolPref("dom.ipc.reportProcessHangs"), time: Services.prefs.getIntPref("dom.max_script_run_time"), input: Services.prefs.getBoolPref("dom.max_script_run_time.require_critical_input") };
      Services.prefs.setBoolPref("dom.ipc.reportProcessHangs", true);
      Services.prefs.setBoolPref("dom.max_script_run_time.require_critical_input", false);
      Services.prefs.setIntPref("dom.max_script_run_time", 2);
      window.spikeHang = [];
      window.spikeHangObserver = (subject) => {
        const r = subject.QueryInterface(Ci.nsIHangReport);
        const b = window.spikeBrowsers.loop;
        const ours = r.isReportForBrowserOrChildren(b.frameLoader);
        window.spikeHang.push({ t: Date.now(), ours, addonId: r.addonId || null, scriptFileName: r.scriptFileName?.replace(/^https?:\\/\\/[^/]+/, "") ?? null });
        if (ours) r.terminateScript();
      };
      Services.obs.addObserver(window.spikeHangObserver, "process-hang-report");
      const s = window.spikeSessions.loop;
      const t0 = Date.now();
      window.spikeLoop = s.commands.scriptCommand.execute("while (true) {}").then((r) => ({ ms: Date.now() - t0, result: r.result?.getGrip?.() ?? r.result, exception: r.exceptionMessage ?? null }), (e) => ({ ms: Date.now() - t0, error: String(e?.message ?? e?.error ?? e) }));`);
    let outcome: unknown = "pending";
    for (let i = 0; i < 40 && outcome === "pending"; i++) {
      await sleep(500);
      outcome = await chrome(m, `return await Promise.race([window.spikeLoop, new Promise((ok) => setTimeout(() => ok("pending"), 50))]);`);
    }
    note("D3b eval outcome", outcome);
    note("D3b hang reports", await chrome(m, "return { prefsBefore: window.spikeHangPrefs, reports: window.spikeHang };"));
    note("D3b Firefox's own slow-script UI", await chrome(m, `
      const b = window.spikeBrowsers.loop;
      const box = gBrowser.readNotificationBox?.(b);
      return { bars: box ? [...box.allNotifications].map((n) => n.getAttribute("value")) : [], global: [...(gNotificationBox?.allNotifications ?? [])].map((n) => n.getAttribute("value")) };`));
    note("D3b the page afterwards", await chrome(m, `return await Promise.race([window.spikeSessions.loop.commands.scriptCommand.execute("1 + 1").then((r) => r.result), new Promise((ok) => setTimeout(() => ok("no answer in 5 s"), 5000))]);`));
    await chrome(m, `Services.obs.removeObserver(window.spikeHangObserver, "process-hang-report"); for (const p of ["dom.max_script_run_time", "dom.ipc.reportProcessHangs", "dom.max_script_run_time.require_critical_input"]) Services.prefs.clearUserPref(p);`);
  });

  it("D8: no listening port after the probes (Marionette left out)", { timeout: 60_000 }, async () => {
    const after = await listening(m, w);
    note("D8 listening after the probes", after);
    note("D8 new listening sockets", after.listen.filter((l) => !before.listen.includes(l)));
    note("D8 remote debugging prefs", await chrome(m, `return { remoteEnabled: Services.prefs.getBoolPref("devtools.debugger.remote-enabled", false), chromeEnabled: Services.prefs.getBoolPref("devtools.chrome.enabled", false), bidi: Services.prefs.getIntPref("remote.active-protocols", -1) };`));
  });
});
