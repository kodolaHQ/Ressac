import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Action } from "../../navigateur/src/commun/api";
import { dispatch, state, waitFor } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { inUi, waitUi } from "./ui";

// The agent's dev tools on a WebAiOs-Firefox tab (plan 28, task 3): Electron's outils-dev.spec.ts for console, network,
// evaluation and reload. The third-party half (masked headers behind the consent card) comes with task 5.

const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const TEXTE_PRIVE = "Cet onglet est dans un espace privé : l'agent n'y a pas accès.";

/** The demo: logs `tag-<log>` at load when asked, "page chargée" always; boum() throws, parler() logs. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>Démo</title><p>Démo</p>
<script>
function boum() { throw new Error("boum"); }
function parler() { console.log("bonjour de la page"); console.warn("attention"); }
const log = new URLSearchParams(location.search).get("log");
if (log) { console.log("tag-" + log); fetch("/data.json?log=" + log); }
console.log("page chargée");
</script>`;

/** The demo server, on a random port given to the noyau as its demo range (never the real 5300-5319 of a running WebAiOs). */
async function startDemo(): Promise<{ port: number; url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }).end(PAGE);
    if (u.pathname === "/data.json") return res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "vu=1" }).end('{"ok":true}');
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => (server.close(() => ok()), server.closeAllConnections())) };
}

/** Each WebAiOs (Gecko) process's listening TCP sockets, Marionette's own port set apart (spike D8). */
async function listening(m: Marionette, w: LaunchedWebAiOs): Promise<string[]> {
  const pids = await m.execute<number[]>("return (async () => { const i = await ChromeUtils.requestProcInfo(); return [i.pid, ...i.children.map((c) => c.pid)]; })();");
  const marionettePort = (await readFile(path.join(w.profile, "MarionetteActivePort"), "utf8")).trim();
  // lsof exits 1 when one pid has nothing to list: its stdout still holds the others.
  const out = await promisify(execFile)("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(",")]).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? "");
  return out.split("\n").slice(1).filter(Boolean).map((l) => l.replace(/\s+/g, " ")).filter((l) => !l.includes(`:${marionettePort} `));
}

let demo: Awaited<ReturnType<typeof startDemo>>;
let w: LaunchedWebAiOs;
let m: Marionette;
let before: string[];
const config = () => path.join(w.dataDir, "espace", ".webaios", "mcp.json");

async function noyauUp(): Promise<void> {
  for (const deadline = Date.now() + 20_000; !existsSync(config()); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("the noyau did not write its MCP config");
}

beforeAll(async () => {
  demo = await startDemo();
  w = await launchWebAiOs({ env: { WEBAIOS_PORTS_CONTENEUR: `${demo.port}-${demo.port}` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.webaiosWindow && gBrowser.tabs.some((t) => t.hasAttribute('webaios-parking'))", (v) => v === true);
  await noyauUp();
  // The home page's panel starts the agent's session, which takes back every access: tools are called after it.
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('prêt>')", [], 20_000, "agent");
  before = await listening(m, w);
}, 90_000);
afterAll(async () => {
  await w?.close();
  await demo?.close();
});

const call = (name: string, args: Record<string, unknown> = {}) => callTool(w.dataDir, name, args);
const tool = async (name: string, args: Record<string, unknown> = {}) => (await call(name, args)).texte;
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

/** A demo opened by the agent (all four rights, no card), loaded; the first lire_console attaches. */
async function openDemo(query = ""): Promise<string> {
  const { texte: id, erreur } = await call("ouvrir_onglet", { url: `${demo.url}/${query}` });
  expect(erreur, id).toBe(false);
  await poll(() => tool("executer_js", { id, code: "document.readyState" }), (t) => t === '"complete"');
  expect(await tool("lire_console", { id })).not.toContain("Erreur");
  return id;
}

const noCard = async () => expect(await inUi(m, `return !!doc.querySelector('[data-testid="demande-permission"], [data-testid="demande-outils-dev"]')`)).toBe(false);

it("démo : lire_console renvoie le console.log et l'erreur non rattrapée avec sa pile, sans carte", async () => {
  const id = await openDemo();
  // Attached after the load: the page's own "page chargée" is not there.
  expect(await tool("lire_console", { id })).toBe("Aucun message.");
  expect(await tool("executer_js", { id, code: "setTimeout(boum); parler(); 1" })).toBe("1");
  const text = await poll(() => tool("lire_console", { id }), (t) => t.includes("[error] Uncaught Error: boum"));
  expect(text).toContain("[log] bonjour de la page");
  expect(text).toContain("[warn] attention");
  expect(text).toMatch(/at boum \(http:\/\/127\.0\.0\.1:\d+\/:\d+:\d+\)/);
  await noCard();
});

it("démo : executer_js renvoie document.title ; recharger garde les messages avec « — page rechargée — »", async () => {
  const id = await openDemo();
  expect(await tool("executer_js", { id, code: "document.title" })).toBe('"Démo"');
  expect(await tool("executer_js", { id, code: "await Promise.resolve({ a: [1, 2] })" })).toBe('{"a":[1,2]}');
  // Not serializable: a preview.
  expect(await tool("executer_js", { id, code: "window" })).toBe("Window");
  expect(await tool("executer_js", { id, code: "document.body" })).toBe("HTMLBodyElement");
  expect(await tool("executer_js", { id, code: "undefined" })).toBe("undefined");
  await tool("executer_js", { id, code: "parler()" });
  await poll(() => tool("lire_console", { id }), (t) => t.includes("bonjour de la page"));
  expect(await tool("recharger", { id })).toBe(`Onglet ${id} rechargé.`);
  await poll(() => tool("lire_console", { id }), (t) => /bonjour de la page[\s\S]*— page rechargée —[\s\S]*page chargée/.test(t));
  // Evaluation goes to the reloaded page (its new target), and a reload without cache works too.
  expect(await tool("executer_js", { id, code: "typeof boum" })).toBe('"function"');
  expect(await tool("recharger", { id, sans_cache: true })).toBe(`Onglet ${id} rechargé.`);
  expect(await tool("executer_js", { id, code: "document.title" })).toBe('"Démo"');
});

it("démo : executer_js attend une promesse ; une exception revient avec sa pile", async () => {
  const id = await openDemo();
  expect(await tool("executer_js", { id, code: "new Promise((r) => setTimeout(() => r(42), 50))" })).toBe("42");
  expect(await tool("executer_js", { id, code: "const v = await new Promise((r) => setTimeout(() => r(21), 50)); v * 2" })).toBe("42");
  expect(await tool("executer_js", { id, code: "(function f() { throw new Error('raté') })()" })).toMatch(/^Exception : Error: raté\n\s+at f/);
  expect(await tool("executer_js", { id, code: "await (async function g() { await null; throw new RangeError('rejet'); })()" })).toMatch(
    /^Exception : RangeError: rejet\n\s+at g/,
  );
  expect(await tool("executer_js", { id, code: "let = ;" })).toMatch(/^Exception : SyntaxError/);
});

it("démo : une promesse qui ne se résout jamais : executer_js répond sur son délai, l'appel suivant marche", async () => {
  const id = await openDemo();
  const t0 = Date.now();
  const r = await call("executer_js", { id, code: "new Promise(() => {})" });
  expect(r.texte).toContain("n'a pas répondu");
  expect(Date.now() - t0).toBeLessThan(20_000);
  expect(await tool("executer_js", { id, code: "1 + 1" })).toBe("2");
}, 60_000);

it("démo : lire_reseau liste un fetch (statut, durée) ; lire_requete rend son corps", async () => {
  const id = await openDemo();
  expect(await tool("executer_js", { id, code: "await (await fetch('/data.json?n=1')).text()" })).toBe('"{\\"ok\\":true}"');
  const line = await poll(() => tool("lire_reseau", { id, filtre: "data.json" }), (t) => / · 200 · /.test(t));
  expect(line).toMatch(/^\S+ · GET · 200 · http:\/\/127\.0\.0\.1:\d+\/data\.json\?n=1 · fetch · \d+ ms · \d+ o$/);
  const detail = await tool("lire_requete", { id, requete: line.split(" · ")[0] });
  expect(detail).toContain("Statut : 200");
  expect(detail).toContain('Corps :\n{"ok":true}');
});

it("démo : un message de console de 1 Mo est tronqué avec mention", async () => {
  const id = await openDemo();
  await tool("executer_js", { id, code: "console.log('x'.repeat(1_000_000)); 1" });
  const text = await poll(() => tool("lire_console", { id }), (t) => t.includes("xxxx"));
  expect(text).toContain("[tronqué]");
  expect(text.length).toBeLessThan(5000);
});

// The third-party half (masked behind a granted card) needs task 5's card: it is tested there.
it("Cookie et Authorization montrés sur une démo", async () => {
  const id = await openDemo();
  await tool("executer_js", { id, code: "document.cookie = 'essai=1'; await (await fetch('/data.json?h=1', { headers: { Authorization: 'Bearer demo' } })).text()" });
  const line = await poll(() => tool("lire_reseau", { id, filtre: "h=1" }), (t) => / · 200 · /.test(t));
  const detail = await tool("lire_requete", { id, requete: line.split(" · ")[0] });
  expect(detail).toMatch(/authorization: Bearer demo/i);
  // The cookie jar also holds vu=1, set by an earlier response.
  expect(detail).toMatch(/\n  cookie: .*essai=1/i);
  expect(detail).toMatch(/set-cookie: vu=1/i);
});

it("le même site dans un espace privé : rien de son onglet dans les tampons de l'onglet attaché", async () => {
  const id = await openDemo();
  const fenetreId = (await state(m)).fenetres[0]!.id;
  const home = (await state(m)).onglets[id]!.espaceId;
  /** Opens the demo with `?log=<log>` in that space, shown (a tab never shown is not loaded), and waits for its page. */
  const openIn = async (espaceId: string, log: string) => {
    const known = new Set(Object.keys((await state(m)).onglets));
    const s = await dispatch(m, { type: "ouvrirOnglet", fenetreId, url: `${demo.url}/?log=${log}`, espaceId, activer: true } as Action);
    await dispatch(m, { type: "activerOnglet", id: Object.keys(s.onglets).find((x) => !known.has(x))! } as Action);
    await waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec.endsWith("log=${log}") && t.linkedBrowser.contentTitle === "Démo")`, (v) => v === true);
  };
  try {
    // Same site, same container, private space.
    const secret = (await dispatch(m, { type: "creerEspace", nom: "Secret", icone: "🔒", prive: true, profil: "defaut", fenetreId } as Action)).espaces.at(-1)!;
    await openIn(secret.id, "prive");
    // Same site, another tab of the same space.
    await openIn(home, "autre");
    // Same site, another container.
    const other = (await dispatch(m, { type: "creerEspace", nom: "Autre", icone: "🅱️", prive: false, profil: "nouveau", fenetreId } as Action)).espaces.at(-1)!;
    await openIn(other.id, "conteneur");
  } finally {
    // Back to the demo's space: the next tests open their demos there.
    await dispatch(m, { type: "activerOnglet", id } as Action);
  }
  // The attached tab still hears itself.
  await tool("executer_js", { id, code: "console.log('ici'); 1" });
  const text = await poll(() => tool("lire_console", { id }), (t) => t.includes("ici"));
  await sleep(500);
  expect(await tool("lire_console", { id })).not.toMatch(/tag-|page chargée/);
  expect(await tool("lire_reseau", { id, filtre: "log=" })).toBe("Aucune requête.");
  expect(text).not.toContain("tag-");
});

it("un onglet d'un espace privé : lire_console répond TEXTE_PRIVE, sans carte", async () => {
  const id = await openDemo();
  const s = await state(m);
  const e = s.espaces.find((x) => x.id === s.onglets[id]!.espaceId)!;
  const setPrivate = (prive: boolean) => dispatch(m, { type: "reglerEspace", id: e.id, nom: e.nom, icone: e.icone, prive, profil: e.profil } as Action);
  await setPrivate(true);
  try {
    await poll(() => tool("lire_console", { id }), (t) => t === TEXTE_PRIVE);
    expect(await tool("executer_js", { id, code: "1" })).toBe(TEXTE_PRIVE);
    await noCard();
    // Detached when it turned private (refused before any DevTools client is made: test/devtools.test.ts).
    expect(await m.execute(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).devtools.attached())();`)).not.toContain(id);
  } finally {
    await setPrivate(false);
  }
});

it("changer de site vide les tampons", async () => {
  const id = await openDemo();
  await tool("executer_js", { id, code: "console.log('avant'); await fetch('/data.json?avant=1'); 1" });
  await poll(() => tool("lire_console", { id }), (t) => t.includes("avant"));
  await poll(() => tool("lire_reseau", { id, filtre: "avant=1" }), (t) => t.includes(" · 200 · "));
  // localhost: another origin, still the agent's demo (its port).
  expect(await tool("naviguer", { id, url: `http://localhost:${demo.port}/` })).toContain("→");
  await poll(() => tool("executer_js", { id, code: "location.host" }), (t) => t === `"localhost:${demo.port}"`);
  await tool("executer_js", { id, code: "console.log('après'); 1" });
  const text = await poll(() => tool("lire_console", { id }), (t) => t.includes("après"));
  expect(text).not.toContain("avant");
  expect(await tool("lire_reseau", { id, filtre: "avant=1" })).toBe("Aucune requête.");
});

it("l'hôte redémarre : le nouveau noyau ne voit pas les anciens messages", async () => {
  const id = await openDemo();
  await tool("executer_js", { id, code: "console.log('ancien noyau'); 1" });
  await poll(() => tool("lire_console", { id }), (t) => t.includes("ancien noyau"));
  const oldConfig = readFileSync(config(), "utf8");
  const pid = await m.execute<number>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`);
  process.kill(pid, "SIGKILL");
  await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`, (v) => v === null);
  await m.execute(`return (async () => { await (await ChromeUtils.importESModule("${STORE}").ready).agent.ensure().catch(() => {}); })();`);
  await poll(async () => (existsSync(config()) ? readFileSync(config(), "utf8") : oldConfig), (c) => c !== oldConfig, 20_000);
  // The new noyau knows nothing of this tab: given to the agent, then navigated by it (same page), it is its demo again.
  const url = `${demo.url}/`;
  await m.execute(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.notify("agent.envoi", { onglet: { id: arguments[0], url: arguments[1], titre: "Démo", espace: "" } }))();`, [id, url]);
  await poll(() => tool("naviguer", { id, url }), (t) => t.includes("→"));
  await poll(() => tool("executer_js", { id, code: "console.log('nouveau noyau'); 1" }), (t) => t === "1");
  const text = await poll(() => tool("lire_console", { id }), (t) => t.includes("nouveau noyau"));
  expect(text).not.toContain("ancien noyau");
}, 90_000);

it("aucun port de débogage n'écoute", async () => {
  // Every tool above ran in this browser: nothing new listens (Marionette's port set apart).
  expect((await listening(m, w)).filter((l) => !before.includes(l))).toEqual([]);
});
