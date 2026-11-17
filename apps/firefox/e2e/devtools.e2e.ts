import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Action } from "../shared/api";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { cleanupXpis, installAddon, uninstallAddon } from "./addons";
import { click, inUi, pressKeys, waitUi, agentPanelReady } from "./ui";
import { TEXT_CUT, SITE_CHANGED_TEXT } from "../../../packages/kernel/src/mcp/devtools";

// Which one the kernel answers depends on whether the new page committed before it read the tab list.
const CUT_BY_OWN_NAVIGATION = [TEXT_CUT, SITE_CHANGED_TEXT];

// The agent's dev tools on a Ressac tab (plan 28, task 3): console, network,
// evaluation and reload; task 4 for profiling and memory; task 5 for the consent card of a third-party tab, the badge and cuts.

const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const PRIVATE_TEXT = "Cet onglet est dans un espace privé : l'agent n'y a pas accès.";

/** The demo: logs `tag-<log>` at load when asked, "page chargée" always; boum() throws, parler() logs. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>Démo</title><p>Démo</p>
<script>
function boum() { throw new Error("boum"); }
function parler() { console.log("bonjour de la page"); console.warn("attention"); }
function busyLoop(ms) { const end = performance.now() + ms; let x = 0; while (performance.now() < end) x += Math.sqrt(x + 1); return x; }
class LeakyThing { constructor(i) { this.i = i; this.j = i * 2; } }
window.leak = [];
if (location.search.includes("busy")) busyLoop(300);
document.addEventListener("declencher", () => { console.log("PAGE-LOG"); fetch("/data.json?depuis-page"); });
const log = new URLSearchParams(location.search).get("log");
if (log) { console.log("tag-" + log); fetch("/data.json?log=" + log); }
console.log("page chargée");
</script>`;

/** The demo server, on a random port given to the kernel as its demo range (never the real 5300-5319 of a running Ressac). */
async function startDemo(): Promise<{ port: number; url: string; hits: string[]; close(): Promise<void> }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(PAGE);
    // A load that never commits: the tab stays on its page.
    if (u.pathname === "/vide") return res.writeHead(204).end();
    if (u.pathname === "/data.json") return res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "vu=1" }).end('{"ok":true}');
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((ok) => (server.close(() => ok()), server.closeAllConnections())) };
}

/** Each Ressac (Gecko) process's listening TCP sockets, Marionette's own port set apart (spike D8). */
async function listening(m: Marionette, w: LaunchedRessac): Promise<string[]> {
  const pids = await m.execute<number[]>("return (async () => { const i = await ChromeUtils.requestProcInfo(); return [i.pid, ...i.children.map((c) => c.pid)]; })();");
  const marionettePort = (await readFile(path.join(w.profile, "MarionetteActivePort"), "utf8")).trim();
  // lsof exits 1 when one pid has nothing to list: its stdout still holds the others.
  const out = await promisify(execFile)("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(",")]).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? "");
  return out.split("\n").slice(1).filter(Boolean).map((l) => l.replace(/\s+/g, " ")).filter((l) => !l.includes(`:${marionettePort} `));
}

let demo: Awaited<ReturnType<typeof startDemo>>;
/** The same page on another random port: not a demo, a third-party site. */
let third: Awaited<ReturnType<typeof startDemo>>;
let w: LaunchedRessac;
let m: Marionette;
let before: string[];
const config = () => path.join(w.dataDir, "workspace", ".ressac", "mcp.json");

async function kernelUp(): Promise<void> {
  for (const deadline = Date.now() + 20_000; !existsSync(config()); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
}

beforeAll(async () => {
  demo = await startDemo();
  third = await startDemo();
  w = await launchRessac({ env: { RESSAC_CONTAINER_PORTS: `${demo.port}-${demo.port}` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await kernelUp();
  // Opening the agent panel starts the window's session, which takes back every access: tools are called after it.
  await agentPanelReady(m);
  before = await listening(m, w);
}, 90_000);
afterAll(async () => {
  await w?.close();
  await demo?.close();
  await third?.close();
  await cleanupXpis();
});

const call = (name: string, args: Record<string, unknown> = {}) => callTool(w.dataDir, name, args);
const tool = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).text;
async function poll<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A demo opened by the agent (all four rights, no card), loaded; the first read_console attaches. */
async function openDemo(query = ""): Promise<string> {
  const { text: id, error } = await call("open_tab", { url: `${demo.url}/${query}` });
  expect(error, id).toBe(false);
  await poll(() => tool("run_js", { id, code: "document.readyState" }), (t) => t === '"complete"');
  expect(await tool("read_console", { id })).not.toContain("Erreur");
  return id;
}

const noCard = async () => expect(await inUi(m, `return !!doc.querySelector('[data-testid="permission-request"], [data-testid="devtools-request"]')`)).toBe(false);

it("demo: read_console returns the console.log and the uncaught error with its stack, without a card", async () => {
  const id = await openDemo();
  // Attached after the load: the page's own "page chargée" is not there.
  expect(await tool("read_console", { id })).toBe("Aucun message.");
  expect(await tool("run_js", { id, code: "setTimeout(boum); parler(); 1" })).toBe("1");
  const text = await poll(() => tool("read_console", { id }), (t) => t.includes("[error] Uncaught Error: boum"));
  expect(text).toContain("[log] bonjour de la page");
  expect(text).toContain("[warn] attention");
  expect(text).toMatch(/at boum \(http:\/\/127\.0\.0\.1:\d+\/:\d+:\d+\)/);
  await noCard();
});

it("demo: run_js returns document.title; recharger keeps the messages with « — page rechargée — »", async () => {
  const id = await openDemo();
  expect(await tool("run_js", { id, code: "document.title" })).toBe('"Démo"');
  expect(await tool("run_js", { id, code: "await Promise.resolve({ a: [1, 2] })" })).toBe('{"a":[1,2]}');
  // Not serializable: a preview.
  expect(await tool("run_js", { id, code: "window" })).toBe("Window");
  expect(await tool("run_js", { id, code: "document.body" })).toBe("HTMLBodyElement");
  expect(await tool("run_js", { id, code: "undefined" })).toBe("undefined");
  await tool("run_js", { id, code: "parler()" });
  await poll(() => tool("read_console", { id }), (t) => t.includes("bonjour de la page"));
  expect(await tool("reload", { id })).toBe(`Onglet ${id} rechargé.`);
  await poll(() => tool("read_console", { id }), (t) => /bonjour de la page[\s\S]*— page rechargée —[\s\S]*page chargée/.test(t));
  // Evaluation goes to the reloaded page (its new target), and a reload without cache works too.
  expect(await tool("run_js", { id, code: "typeof boum" })).toBe('"function"');
  expect(await tool("reload", { id, no_cache: true })).toBe(`Onglet ${id} rechargé.`);
  expect(await tool("run_js", { id, code: "document.title" })).toBe('"Démo"');
});

it("demo: run_js waits for a promise; an exception comes back with its stack", async () => {
  const id = await openDemo();
  expect(await tool("run_js", { id, code: "new Promise((r) => setTimeout(() => r(42), 50))" })).toBe("42");
  expect(await tool("run_js", { id, code: "const v = await new Promise((r) => setTimeout(() => r(21), 50)); v * 2" })).toBe("42");
  expect(await tool("run_js", { id, code: "(function f() { throw new Error('raté') })()" })).toMatch(/^Exception : Error: raté\n\s+at f/);
  expect(await tool("run_js", { id, code: "await (async function g() { await null; throw new RangeError('rejet'); })()" })).toMatch(
    /^Exception : RangeError: rejet\n\s+at g/,
  );
  expect(await tool("run_js", { id, code: "let = ;" })).toMatch(/^Exception : SyntaxError/);
  // The rejection was given back: Firefox's own « unhandled » report of it is not the page's.
  await tool("run_js", { id, code: "console.log('fin'); 1" });
  const text = await poll(() => tool("read_console", { id }), (t) => t.includes("fin"));
  expect(text).not.toContain("rejet");
});

it("demo: a promise that never resolves: run_js answers on its deadline, the next call works", async () => {
  const id = await openDemo();
  const t0 = Date.now();
  const r = await call("run_js", { id, code: "new Promise(() => {})" });
  expect(r.text).toContain("n'a pas répondu");
  expect(Date.now() - t0).toBeLessThan(20_000);
  expect(await tool("run_js", { id, code: "1 + 1" })).toBe("2");
}, 60_000);

it("demo: read_network lists a fetch (status, duration); read_request returns its body", async () => {
  const id = await openDemo();
  expect(await tool("run_js", { id, code: "await (await fetch('/data.json?n=1')).text()" })).toBe('"{\\"ok\\":true}"');
  const line = await poll(() => tool("read_network", { id, filter: "data.json" }), (t) => / · 200 · /.test(t));
  expect(line).toMatch(/^\S+ · GET · 200 · http:\/\/127\.0\.0\.1:\d+\/data\.json\?n=1 · fetch · \d+ ms · \d+ o$/);
  const detail = await tool("read_request", { id, request: line.split(" · ")[0] });
  expect(detail).toContain("Statut : 200");
  expect(detail).toContain('Corps :\n{"ok":true}');
});

it("demo: a 1 MB console message is truncated with a mention", async () => {
  const id = await openDemo();
  await tool("run_js", { id, code: "console.log('x'.repeat(1_000_000)); 1" });
  const text = await poll(() => tool("read_console", { id }), (t) => t.includes("xxxx"));
  expect(text).toContain("[tronqué]");
  expect(text.length).toBeLessThan(5000);
});

it("Cookie and Authorization shown on a demo", async () => {
  const id = await openDemo();
  await tool("run_js", { id, code: "document.cookie = 'essai=1'; await (await fetch('/data.json?h=1', { headers: { Authorization: 'Bearer demo' } })).text()" });
  const line = await poll(() => tool("read_network", { id, filter: "h=1" }), (t) => / · 200 · /.test(t));
  const detail = await tool("read_request", { id, request: line.split(" · ")[0] });
  expect(detail).toMatch(/authorization: Bearer demo/i);
  // The cookie jar also holds vu=1, set by an earlier response.
  expect(detail).toMatch(/\n  cookie: .*essai=1/i);
  expect(detail).toMatch(/set-cookie: vu=1/i);
});

it("read_console and read_network show nothing from an extension that writes to the console and makes requests from its content script", async () => {
  // Its content script, on the event the page also hears: a log, a fetch of the page's own origin with a header, a 404,
  // a cross-origin fetch that CORS refuses, and an exception; then a mark on the page.
  const script = `document.addEventListener("declencher", async () => {
    console.log("BAVARD-EXT");
    await fetch(location.origin + "/data.json?depuis-extension", { headers: { "X-Bavard": "1" } }).catch(() => {});
    await fetch(location.origin + "/absent-depuis-extension").catch(() => {});
    await fetch("http://localhost:${demo.port}/data.json?cors-depuis-extension", { headers: { "X-Bavard": "1" } }).catch(() => {});
    document.documentElement.setAttribute("data-bavard-fini", "1");
    throw new Error("BAVARD-EXCEPTION");
  });`;
  const addon = await installAddon(m, {
    id: "bavard@ressac.test",
    manifest: { manifest_version: 2, name: "Bavard", version: "1.0", browser_specific_settings: { gecko: { id: "bavard@ressac.test" } },
      content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["cs.js"], run_at: "document_start" }] },
    files: { "cs.js": script },
  });
  try {
    const id = await openDemo("?bavarde");
    await tool("run_js", { id, code: "document.dispatchEvent(new CustomEvent('declencher')); 1" });
    await poll(() => tool("read_console", { id }), (t) => t.includes("PAGE-LOG"));
    await poll(() => tool("read_network", { id }), (t) => t.includes("depuis-page"));
    await poll(() => tool("run_js", { id, code: "document.documentElement.getAttribute('data-bavard-fini')" }), (t) => t === '"1"');
    await sleep(500); // the last resources
    const console_ = await tool("read_console", { id });
    const network = await tool("read_network", { id });
    expect(console_).not.toContain("BAVARD");
    expect(network).not.toContain("depuis-extension");
    for (const trace of ["absent-depuis-extension", "cors-depuis-extension", "CORS", "Cross-Origin"]) {
      expect(console_).not.toContain(trace);
      expect(network).not.toContain(trace);
    }
    expect(network).toContain("depuis-page");
    // The extension's requests did happen: Firefox keeps them out of the tab's network resources.
    expect(demo.hits).toContain("/data.json?depuis-extension");
    expect(demo.hits).toContain("/absent-depuis-extension");
  } finally {
    await uninstallAddon(m, addon);
  }
});

it("the same site in a private space: nothing of its tab in the attached tab's buffers", async () => {
  const id = await openDemo();
  const windowId = (await state(m)).windows[0]!.id;
  const home = (await state(m)).tabs[id]!.spaceId;
  /** Opens the demo with `?log=<log>` in that space, shown (a tab never shown is not loaded), and waits for its page. */
  const openIn = async (spaceId: string, log: string) => {
    const known = new Set(Object.keys((await state(m)).tabs));
    const s = await dispatch(m, { type: "openTab", windowId: windowId, url: `${demo.url}/?log=${log}`, spaceId: spaceId, activate: true } as Action);
    await dispatch(m, { type: "activateTab", id: Object.keys(s.tabs).find((x) => !known.has(x))! } as Action);
    await waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec.endsWith("log=${log}") && t.linkedBrowser.contentTitle === "Démo")`, (v) => v === true);
  };
  try {
    // Same site, same container, private space.
    const secret = (await dispatch(m, { type: "createSpace", name: "Secret", icon: "🔒", private: true, profile: "default", windowId: windowId } as Action)).spaces.at(-1)!;
    await openIn(secret.id, "prive");
    // Same site, another tab of the same space.
    await openIn(home, "autre");
    // Same site, another container.
    const other = (await dispatch(m, { type: "createSpace", name: "Autre", icon: "🅱️", private: false, profile: "new", windowId: windowId } as Action)).spaces.at(-1)!;
    await openIn(other.id, "conteneur");
  } finally {
    // Back to the demo's space: the next tests open their demos there.
    await dispatch(m, { type: "activateTab", id } as Action);
  }
  // The attached tab still hears itself.
  await tool("run_js", { id, code: "console.log('ici'); 1" });
  const text = await poll(() => tool("read_console", { id }), (t) => t.includes("ici"));
  await sleep(500);
  expect(await tool("read_console", { id })).not.toMatch(/tag-|page chargée/);
  expect(await tool("read_network", { id, filter: "log=" })).toBe("Aucune requête.");
  expect(text).not.toContain("tag-");
});

it("a private space's tab: read_console answers PRIVATE_TEXT, without a card", async () => {
  const id = await openDemo();
  const s = await state(m);
  const e = s.spaces.find((x) => x.id === s.tabs[id]!.spaceId)!;
  const setPrivate = (isPrivate: boolean) => dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: isPrivate, profile: e.profile } as Action);
  await setPrivate(true);
  try {
    await poll(() => tool("read_console", { id }), (t) => t === PRIVATE_TEXT);
    expect(await tool("run_js", { id, code: "1" })).toBe(PRIVATE_TEXT);
    await noCard();
    // Detached when it turned private (refused before any DevTools client is made: test/devtools.test.ts).
    expect(await m.execute(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).devtools.attached())();`)).not.toContain(id);
  } finally {
    await setPrivate(false);
  }
});

it("changing site empties the buffers", async () => {
  const id = await openDemo();
  await tool("run_js", { id, code: "console.log('avant'); await fetch('/data.json?avant=1'); 1" });
  await poll(() => tool("read_console", { id }), (t) => t.includes("avant"));
  await poll(() => tool("read_network", { id, filter: "avant=1" }), (t) => t.includes(" · 200 · "));
  // localhost: another origin, still the agent's demo (its port).
  expect(await tool("navigate", { id, url: `http://localhost:${demo.port}/` })).toContain("→");
  await poll(() => tool("run_js", { id, code: "location.host" }), (t) => t === `"localhost:${demo.port}"`);
  await tool("run_js", { id, code: "console.log('après'); 1" });
  const text = await poll(() => tool("read_console", { id }), (t) => t.includes("après"));
  expect(text).not.toContain("avant");
  expect(await tool("read_network", { id, filter: "avant=1" })).toBe("Aucune requête.");
});

// The consent card, on a tab the user opened on a third-party site.
const CARD = '[data-testid="devtools-request"]';
const MODAL = '[data-testid="request-modal"]';
const READ_CARD = '[data-testid="permission-request"]';
const BADGE = '[data-testid="access-pill"]';
const BUBBLE = '[data-testid="access-bubble"]';
const DENIAL = "Accès refusé par l'utilisateur à cet outil sur cet onglet.";
let thirdTabs = 0;

/** A tab the user opens on the third-party site, in the active space, loaded; its URL is unique. */
async function openThird(): Promise<string> {
  const url = `${third.url}/?tiers=${++thirdTabs}`;
  const s0 = await state(m);
  const known = new Set(Object.keys(s0.tabs));
  const s = await dispatch(m, { type: "openTab", windowId: s0.windows[0]!.id, url, activate: true } as Action);
  const id = Object.keys(s.tabs).find((x) => !known.has(x))!;
  await waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && t.linkedBrowser.contentTitle === "Démo")`, (v) => v === true);
  return id;
}
const cardText = () => waitUi<string>(m, `return doc.querySelector('${CARD}')?.textContent`);
const cardGone = () => waitUi(m, `return !doc.querySelector('${MODAL}')`);
const answerCard = (button: "Refuser" | "Autoriser la sélection") => click(m, `${CARD} button`, { text: button });
const checked = (right: string) => inUi<boolean>(m, `return doc.querySelector('${CARD} input[data-right="${right}"]').checked`);
/** Asks `droits` on the tab and allows them all on the card. */
async function grant(id: string, rights: string[]): Promise<string> {
  const pending = tool("request_devtools", { id, rights: rights, reason: "Essai de la pastille." });
  await cardText();
  await answerCard("Autoriser la sélection");
  return pending;
}
const tabBadge = (id: string) => `[data-testid="tab-${id}"] ${BADGE}`;
/** Clicks the tab's badge, scrolled into view first: the tab list grows with every test. */
async function clickBadge(id: string): Promise<void> {
  await waitUi(m, "const b = doc.querySelector(arguments[0]); b?.scrollIntoView({ block: 'center' }); return !!b;", [tabBadge(id)]);
  await click(m, tabBadge(id));
}
/** The card has the keyboard, and Enter is armed. */
const armed = () => waitUi(m, `return !!doc.querySelector('${MODAL}[data-armed]') && !!doc.activeElement?.closest('${MODAL}')`);

it("third-party tab: read_console shows the card with « Console et erreurs » ticked and the reason; Autoriser la sélection → messages returned", async () => {
  const id = await openThird();
  const pending = tool("read_console", { id });
  const text = await cardText();
  expect(text).toContain("veut accéder aux outils de développement");
  expect(text).toContain("Démo");
  expect(text).toContain("« L'agent veut utiliser read_console. »");
  expect(text).toContain("Valable pour cette conversation · tombe si l'onglet change de site");
  expect(await checked("console")).toBe(true);
  for (const d of ["network", "performance", "act"]) expect(await checked(d)).toBe(false);
  await answerCard("Autoriser la sélection");
  expect(await pending).toBe("Aucun message.");
  await cardGone();
});

it("unticking Réseau in a console+reseau request: only console is granted; the next read_network answers refused without a card", async () => {
  const id = await openThird();
  const pending = tool("request_devtools", { id, rights: ["console", "network"], reason: "Le bouton ne réagit pas." });
  const text = await cardText();
  expect(text).toContain("« Le bouton ne réagit pas. »");
  expect(text).toContain("peut contenir des données de connexion");
  expect(await checked("console")).toBe(true);
  await click(m, `${CARD} input[data-right="network"]`);
  await waitUi(m, `return !doc.querySelector('${CARD} input[data-right="network"]').checked`);
  await answerCard("Autoriser la sélection");
  expect(await pending).toBe("Droits accordés : console\nRefusés : network");
  expect(await tool("read_network", { id })).toBe(DENIAL);
  await noCard();
});

it("navigating a third-party tab to a demo URL that answers 204: the tab stays third-party, run_js does not run there without a card", async () => {
  const id = await openThird();
  const url = (await state(m)).tabs[id]!.url;
  const navigating = tool("navigate", { id, url: `${demo.url}/vide` });
  await waitUi(m, `return !!doc.querySelector('${READ_CARD}')`);
  await click(m, `${READ_CARD} button`, { text: "Autoriser une fois" });
  expect(await navigating).toContain("→");
  await poll(async () => demo.hits.includes("/vide"), (v) => v);
  await sleep(500);
  // The tab is still on the third-party page: its read access (given to the demo origin) no longer covers it.
  expect((await state(m)).tabs[id]!.url).toBe(url);
  const line = (await tool("list_tabs")).split("\n").find((l) => l.startsWith(`${id} · `));
  expect(line).toBeDefined();
  expect(line).not.toContain("/vide");
  // Without demo rights, the policy asks; whatever it answers, the third-party page's code does not run.
  let answer: string | undefined;
  const pending = tool("run_js", { id, code: "location.href" }).then((t) => (answer = t));
  await poll(async () => answer !== undefined || (await inUi<boolean>(m, `return !!doc.querySelector('${CARD}')`)), (v) => v === true);
  if (answer === undefined) {
    await answerCard("Refuser");
    await pending;
  }
  expect(answer).not.toContain("tiers=");
});

it("two requests: only one card at a time, the second after the first is answered", async () => {
  const id = await openThird();
  const other = await openThird();
  const first = tool("request_devtools", { id, rights: ["console"], reason: "Première." });
  expect(await cardText()).toContain("Première.");
  const second = tool("request_devtools", { id: other, rights: ["console"], reason: "Seconde." });
  await sleep(500);
  expect(await inUi(m, `return doc.querySelectorAll('${CARD}').length`)).toBe(1);
  expect(await cardText()).toContain("Première.");
  await answerCard("Autoriser la sélection");
  expect(await first).toBe("Droits accordés : console");
  await waitUi(m, `return doc.querySelector('${CARD}')?.textContent.includes("Seconde.")`);
  await answerCard("Refuser");
  expect(await second).toBe(DENIAL);
  await cardGone();
});

it("Refuser: the tool answers refused", async () => {
  const id = await openThird();
  const pending = tool("read_console", { id });
  await cardText();
  await answerCard("Refuser");
  expect(await pending).toBe(DENIAL);
  await cardGone();
});

it("Cookie and Authorization masked on a third-party tab", async () => {
  const id = await openThird();
  await grant(id, ["network", "act"]);
  await tool("run_js", { id, code: "document.cookie = 'tiers=1'; await (await fetch('/data.json?tiers-h=1', { headers: { Authorization: 'Bearer secret' } })).text()" });
  const line = await poll(() => tool("read_network", { id, filter: "tiers-h=1" }), (t) => / · 200 · /.test(t));
  const detail = await tool("read_request", { id, request: line.split(" · ")[0] });
  expect(detail).not.toContain("Bearer secret");
  expect(detail).not.toContain("tiers=1");
  expect(detail).not.toMatch(/set-cookie: vu=1/i);
  expect(detail).toMatch(/authorization: «masqué»/i);
  expect(detail).toMatch(/\n  cookie: «masqué»/i);
  expect(detail).toMatch(/set-cookie: «masqué»/i);
});

it("read granted (Autoriser une fois): 👁 badge on the tab and in the address bar", async () => {
  const id = await openThird();
  expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [tabBadge(id)])).toBe(false);
  const reading = call("read_tab", { id });
  await waitUi(m, `return !!doc.querySelector('${READ_CARD}')`);
  await click(m, `${READ_CARD} button`, { text: "Autoriser une fois" });
  await reading;
  await waitUi(m, `return doc.querySelector(arguments[0])?.dataset.level === "read"`, [tabBadge(id)]);
  await waitUi(m, `return doc.querySelector('form ${BADGE}')?.dataset.level === "read"`);
});

it("act granted: ⚡ badge", async () => {
  const id = await openThird();
  await grant(id, ["act"]);
  await waitUi(m, `const p = doc.querySelector(arguments[0]); return p?.dataset.level === "act" && !!p.querySelector("svg")`, [tabBadge(id)]);
});

it("click on the badge: the bubble lists the rights; Couper on « console » removes that right (read_console asks again)", async () => {
  const id = await openThird();
  await grant(id, ["console", "network"]);
  await clickBadge(id);
  const bubble = await waitUi<string>(m, `return doc.querySelector('${BUBBLE}')?.textContent`);
  for (const t of ["Console et erreurs", "Réseau", "Cette conversation · tombe si l'onglet change de site"]) expect(bubble).toContain(t);
  await click(m, `${BUBBLE} button[data-right="console"]`);
  await waitUi(m, `return !doc.querySelector('${BUBBLE} button[data-right="console"]') && !!doc.querySelector('${BUBBLE} button[data-right="network"]')`);
  await pressKeys(m, "Escape");
  await waitUi(m, `return !doc.querySelector('${BUBBLE}')`);
  const pending = tool("read_console", { id });
  await cardText();
  await answerCard("Refuser");
  expect(await pending).toBe(DENIAL);
});

it("Couper l'accès: the badge disappears, read_tab asks again", async () => {
  const id = await openThird();
  await grant(id, ["console"]);
  await clickBadge(id);
  await click(m, `${BUBBLE} button`, { text: "Couper l'accès" });
  await waitUi(m, `return !doc.querySelector(arguments[0]) && !doc.querySelector('${BUBBLE}')`, [tabBadge(id)]);
  const reading = call("read_tab", { id });
  await waitUi(m, `return !!doc.querySelector('${READ_CARD}')`);
  await click(m, `${READ_CARD} button`, { text: "Refuser" });
  await reading;
});

it("cutting « Agir » during an run_js: the call answers the cut text", async () => {
  const id = await openThird();
  await grant(id, ["console", "act"]);
  const t0 = Date.now();
  const pending = tool("run_js", { id, code: "new Promise((r) => setTimeout(() => r(1), 8000))" });
  // The badge pulses while the call runs.
  await waitUi(m, `return !!doc.querySelector(arguments[0])?.classList.contains("pulse")`, [tabBadge(id)]);
  await clickBadge(id);
  await click(m, `${BUBBLE} button[data-right="act"]`);
  expect(await pending).toBe(TEXT_CUT);
  expect(Date.now() - t0).toBeLessThan(6000);
  // Console is kept: the badge goes back to 👁, still and quiet.
  await waitUi(m, `const p = doc.querySelector(arguments[0]); return p?.dataset.level === "read" && !p.classList.contains("pulse")`, [tabBadge(id)]);
  await pressKeys(m, "Escape");
}, 30_000);

it("space turned private: the badge disappears, the debugger is detached and the tools answer private without a card", async () => {
  const id = await openThird();
  await grant(id, ["console", "act"]);
  await waitUi(m, `return doc.querySelector(arguments[0])?.dataset.level === "act"`, [tabBadge(id)]);
  const attached = () => m.execute<string[]>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).devtools.attached())();`);
  await tool("read_console", { id });
  expect(await attached()).toContain(id);
  const s = await state(m);
  const e = s.spaces.find((x) => x.id === s.tabs[id]!.spaceId)!;
  const setPrivate = (isPrivate: boolean) => dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: isPrivate, profile: e.profile } as Action);
  await setPrivate(true);
  try {
    await waitUi(m, `return !doc.querySelector('${BADGE}')`);
    expect(await attached()).not.toContain(id);
    await poll(() => tool("read_console", { id }), (t) => t === PRIVATE_TEXT);
    expect(await tool("run_js", { id, code: "document.title" })).toBe(PRIVATE_TEXT);
    await noCard();
  } finally {
    await setPrivate(false);
  }
  // Shared again: the rights do not come back, the tool asks.
  const pending = tool("read_console", { id });
  await cardText();
  await answerCard("Refuser");
  expect(await pending).toBe(DENIAL);
});

it("Esc refuses the devtools card; Enter allows the selection", async () => {
  const id = await openThird();
  const pending = tool("request_devtools", { id, rights: ["console", "network"], reason: "Au clavier." });
  expect(await cardText()).toContain("Au clavier.");
  await armed();
  // The focus stays trapped in the modal.
  for (let i = 0; i < 12; i++) {
    await pressKeys(m, "Tab");
    expect(await inUi(m, `return !!doc.activeElement?.closest('${MODAL}')`)).toBe(true);
  }
  // Space unticks « Réseau » without answering; Enter, on the box, allows the selection.
  await inUi(m, `doc.querySelector('${CARD} input[data-right="network"]').focus()`);
  await pressKeys(m, " ");
  await waitUi(m, `return !doc.querySelector('${CARD} input[data-right="network"]').checked`);
  expect(await inUi(m, `return !!doc.querySelector('${MODAL}[data-armed]')`)).toBe(true);
  await pressKeys(m, "Enter");
  expect(await pending).toBe("Droits accordés : console\nRefusés : network");
  await cardGone();

  const refusal = tool("request_devtools", { id, rights: ["performance"], reason: "Échap." });
  expect(await cardText()).toContain("Échap.");
  await armed();
  await pressKeys(m, "Escape");
  expect(await refusal).toBe(DENIAL);
  await cardGone();
});

it("Enter pressed as soon as the request arrives allows nothing; once the card has been visible for a while, it does", async () => {
  const id = await openThird();
  let answered = false;
  const pending = tool("request_devtools", { id, rights: ["console"], reason: "Trop tôt." }).finally(() => (answered = true));
  await cardText();
  // Typing in the page the moment the card comes: that key is no consent.
  await pressKeys(m, "Enter");
  await sleep(300);
  expect(answered).toBe(false);
  await armed();
  await pressKeys(m, "Enter");
  expect(await pending).toBe("Droits accordés : console");
  await cardGone();
});

it("the user's devtools open on the tab: they stay usable, and the agent reads the console", async () => {
  const id = await openDemo("?boite");
  const url = `${demo.url}/?boite`;
  await m.execute(
    `return (async () => {
      const { require } = ChromeUtils.importESModule("resource://devtools/shared/loader/Loader.sys.mjs");
      const { gDevTools } = require("devtools/client/framework/devtools");
      const tab = gBrowser.tabs.find((t) => t.linkedBrowser.currentURI.spec === arguments[0]);
      window.testToolbox = await gDevTools.showToolboxForTab(tab, { toolId: "webconsole" });
    })();`,
    [url],
  );
  try {
    await tool("run_js", { id, code: "console.log('avec-boite'); 1" });
    expect(await poll(() => tool("read_console", { id }), (t) => t.includes("avec-boite"))).toContain("[log] avec-boite");
    // The user's toolbox still shows the page's console and evaluates.
    const own = await m.execute<{ shown: boolean; result: number }>(`return (async () => {
      const hud = window.testToolbox.getPanel("webconsole").hud;
      for (let i = 0; i < 50 && !hud.ui.outputNode.textContent.includes("avec-boite"); i++) await new Promise((r) => setTimeout(r, 100));
      const r = await window.testToolbox.commands.scriptCommand.execute("40 + 2");
      return { shown: hud.ui.outputNode.textContent.includes("avec-boite"), result: r.result };
    })();`);
    expect(own).toEqual({ shown: true, result: 42 });
    expect(await tool("run_js", { id, code: "6 * 7" })).toBe("42");
  } finally {
    await m.execute("return (async () => { await window.testToolbox?.destroy(); delete window.testToolbox; })();");
  }
  // Closed: the agent still reads.
  await tool("run_js", { id, code: "console.log('apres-boite'); 1" });
  await poll(() => tool("read_console", { id }), (t) => t.includes("apres-boite"));
}, 60_000);

const PROFILING = () => path.join(w.dataDir, "workspace", ".ressac", "profiling");
const profiles = () => (existsSync(PROFILING()) ? readdirSync(PROFILING()) : []);
const profilerActive = () => m.execute<boolean>("return Services.profiler.IsActive();");

it("demo: profile_performance (2 s) returns a summary with the page's costly function and writes the file in the workspace", async () => {
  const id = await openDemo();
  await tool("run_js", { id, code: "window.busy = setInterval(() => busyLoop(50), 100); 1" });
  try {
    const r = await tool("profile_performance", { id, duration_s: 2 });
    expect(r).toMatch(/^busyLoop \(http:\/\/127\.0\.0\.1:\d+\/:\d+\) — [\d.]+ ms, [\d.]+ %$/m);
    for (const metric of ["Nodes", "JSHeapUsedSize", "LayoutCount", "ScriptDuration", "TaskDuration"]) expect(r).toContain(`${metric} : `);
    const relPath = /Profil : \/workspace\/(\.ressac\/profiling\/\S+\.cpuprofile)$/m.exec(r)?.[1];
    expect(relPath, r).toBeDefined();
    const profile = JSON.parse(readFileSync(path.join(w.dataDir, "workspace", relPath!), "utf8"));
    expect(profile.nodes.some((n: { callFrame: { functionName: string } }) => n.callFrame.functionName === "busyLoop")).toBe(true);
    expect(profile.samples.length).toBe(profile.timeDeltas.length);
    expect(await profilerActive()).toBe(false);
  } finally {
    await tool("run_js", { id, code: "clearInterval(window.busy); 1" });
  }
}, 60_000);

it("demo: profile_performance with recharger returns a summary", async () => {
  const id = await openDemo("?busy");
  const r = await tool("profile_performance", { id, reload: true });
  expect(r).toMatch(/^busyLoop \(/m);
  expect(r).toContain("ScriptDuration : ");
  expect(r).toMatch(/Profil : \/workspace\/\.ressac\/profiling\/\S+\.cpuprofile$/m);
  expect(await profilerActive()).toBe(false);
}, 60_000);

it("Firefox's profiler already running: profile_performance refuses and does not stop it", async () => {
  const id = await openDemo();
  await m.execute("return (async () => { await Services.profiler.StartProfiler(1 << 20, 1, ['js'], ['GeckoMain']); })();");
  try {
    const before = profiles();
    expect(await tool("profile_performance", { id, duration_s: 0.5 })).toContain("Le profileur de Firefox est déjà en cours (about:profiling ou un autre profil de l'agent)");
    expect(await profilerActive()).toBe(true);
    expect(profiles()).toEqual(before);
  } finally {
    await m.execute("return (async () => { await Services.profiler.StopProfiler(); })();");
  }
});

it("demo: two memory_snapshot then compare_memory: the type the page makes grow comes first", async () => {
  const id = await openDemo();
  const snapshot = async () => {
    const r = await tool("memory_snapshot", { id });
    expect(r).toMatch(/^Total : [\d.]+ Ko$/m);
    const relPath = /Instantané : (\/workspace\/\.ressac\/profiling\/\S+\.heapsnapshot)$/m.exec(r)?.[1];
    expect(relPath, r).toBeDefined();
    return relPath!;
  };
  const a = await snapshot();
  await tool("run_js", { id, code: "for (let i = 0; i < 20000; i++) window.leak.push(new LeakyThing(i)); 1" });
  const b = await snapshot();
  const r = await tool("compare_memory", { id, a, b });
  // Firefox's census counts classes, not constructors: LeakyThing instances count as Object.
  expect(r.split("\n")[1], r).toMatch(/^Object \+\d{5}/);
});

it("third-party: the file goes into the profiling folder and the agent receives a profile: reference", async () => {
  const id = await openThird();
  await grant(id, ["performance"]);
  const before = profiles();
  const r = await tool("profile_performance", { id, duration_s: 0.5 });
  const name = /^Profil : profile:(\S+\.cpuprofile)$/m.exec(r)?.[1];
  expect(name, r).toBeDefined();
  expect(existsSync(path.join(w.dataDir, "profiling", name!))).toBe(true);
  // Nothing of the third-party site in the space the agent reads.
  expect(profiles()).toEqual(before);
}, 60_000);

/** A 20 s profile cut by `leave(id)` taking the tab to another site: it answers `text` at once, writes nothing, stops the profiler. */
async function profileCutBySiteChange(leave: (id: string) => Promise<unknown>, texts: string[]): Promise<void> {
  const id = await openDemo();
  const before = profiles();
  const t0 = Date.now();
  const pending = call("profile_performance", { id, duration_s: 20 });
  await sleep(1000);
  await leave(id);
  const r = await pending;
  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(texts.some((t) => r.text.includes(t))).toBe(true);
  expect(r.text).not.toContain("Profil :");
  expect(profiles()).toEqual(before);
  expect(await profilerActive()).toBe(false);
}

it("navigating to another site during profile_performance: the call answers the cut text, no partial file", async () => {
  // localhost: another origin, still the agent's demo (its port). The kernel cuts the right before the load commits.
  await profileCutBySiteChange(async (id) => expect(await tool("navigate", { id, url: `http://localhost:${demo.port}/` })).toContain("→"), CUT_BY_OWN_NAVIGATION);
}, 60_000);

it("the page leaves by itself during profile_performance: the call answers, no partial file", async () => {
  await profileCutBySiteChange((id) => tool("run_js", { id, code: `setTimeout(() => (location.href = "http://localhost:${demo.port}/"), 0); 1` }), ["L'onglet a changé de site."]);
}, 60_000);

it("run_js cut by navigating to another site quickly answers the cut text", async () => {
  const id = await openDemo();
  const t0 = Date.now();
  const pending = call("run_js", { id, code: "new Promise((r) => setTimeout(() => r(1), 8000))" });
  await sleep(500);
  expect(await tool("navigate", { id, url: `http://localhost:${demo.port}/` })).toContain("→");
  expect(CUT_BY_OWN_NAVIGATION).toContain((await pending).text);
  expect(Date.now() - t0).toBeLessThan(6000);
}, 60_000);

it("the host restarts: the new kernel does not see the old messages", async () => {
  const id = await openDemo();
  await tool("run_js", { id, code: "console.log('old kernel'); 1" });
  await poll(() => tool("read_console", { id }), (t) => t.includes("old kernel"));
  const oldConfig = readFileSync(config(), "utf8");
  const pid = await m.execute<number>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`);
  process.kill(pid, "SIGKILL");
  await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`, (v) => v === null);
  await m.execute(`return (async () => { await (await ChromeUtils.importESModule("${STORE}").ready).agent.ensure().catch(() => {}); })();`);
  await poll(async () => (existsSync(config()) ? readFileSync(config(), "utf8") : oldConfig), (c) => c !== oldConfig, 20_000);
  // The new kernel knows nothing of this tab: given to the agent, then navigated by it (same page), it is its demo again.
  const url = `${demo.url}/`;
  await m.execute(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.notify("agent.send", { tab: { id: arguments[0], url: arguments[1], title: "Démo", space: "" } }))();`, [id, url]);
  await poll(() => tool("navigate", { id, url }), (t) => t.includes("→"));
  await poll(() => tool("run_js", { id, code: "console.log('new kernel'); 1" }), (t) => t === "1");
  const text = await poll(() => tool("read_console", { id }), (t) => t.includes("new kernel"));
  expect(text).not.toContain("old kernel");
}, 90_000);

it("no debugging port is listening", async () => {
  // Every tool above ran in this browser: nothing new listens (Marionette's port set apart).
  expect((await listening(m, w)).filter((l) => !before.includes(l))).toEqual([]);
});
