import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { callMcpTool } from "../test/mcp";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, startAgentSession, waitUi } from "./ui";

// Task 13 (spec § 3): Firefox's parent judges each hop of an agent load (chrome/agent/load-guard.ts). Under the lock,
// a redirect off the revealed value's origin is cancelled and the kernel answers the locked refusal; a handle whose
// server redirects elsewhere asks the handle card. What a page sends by itself is not judged: it carries only what it
// knew plus what the followed link gave it.
const PHONE = "06 12 34 56 78";
const EMAIL = "camille.exemple" + "@" + "novacourriel.test";
const LOCKED_REFUSED = "Conversation verrouillée : cette sortie n'a pas reçu votre accord.";
const HANDLE_REFUSED = "Adresse refusée par l'utilisateur : elle emporte une donnée masquée vers un autre site.";
const MASK_CARD = '[data-testid="mask-request"]';
const ACCESS = '[data-testid="permission-request"] button, [data-testid="devtools-request"] button';
const ADDRESS = '[data-testid="address-request"]';

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);

let other: Awaited<ReturnType<typeof startServer>>; // B: where the redirects lead
let third: Awaited<ReturnType<typeof startServer>>; // C: where a page posts by itself
/** What reached C's /collecte: body and Referer, in order. */
const posted: { body: string; referer: string }[] = [];
const collect = (req: IncomingMessage, res: ServerResponse) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    posted.push({ body, referer: String(req.headers.referer ?? "") });
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" }).end();
  });
};
// `/compte/` makes the page sensitive: a masking source once the user reached it (e2e/masking-visits.e2e.ts).
let server: Awaited<ReturnType<typeof startServer>>;
const routes = {
  "/compte/releve.html": (_req: unknown, res: ServerResponse) =>
    html(
      res,
      `<title>Relevé</title><p>Tél : ${PHONE}</p>` +
        `<a href="/compte/saute">Saute</a> <a href="/compte/aller?u=${EMAIL}">Aller</a> <a href="/compte/envoie.html?x=1">Envoie</a> <a href="/compte/rebond.html">Rebond</a>`,
    ),
  "/compte/saute": (_req: unknown, res: ServerResponse) => void res.writeHead(302, { Location: `${other.url}/arrivee.html` }).end(),
  "/compte/aller": (_req: unknown, res: ServerResponse) => void res.writeHead(302, { Location: `${other.url}/arrivee.html` }).end(),
  // An open redirect by script, once loaded and without user activation; 1 s later the page, still there, says so.
  "/compte/rebond.html": (_req: unknown, res: ServerResponse) =>
    html(
      res,
      `<title>Rebond</title><script>addEventListener("load", () => setTimeout(() => { location.replace(${JSON.stringify(`${other.url}/arrivee.html`)}); setTimeout(() => fetch("/compte/reste"), 1000); }, 0))</script>`,
    ),
  "/compte/reste": (_req: unknown, res: ServerResponse) => void res.writeHead(204).end(),
  // The page sends by itself, to a third origin: its own title and the query the link gave it, nothing else.
  "/compte/envoie.html": (_req: unknown, res: ServerResponse) =>
    html(res, `<title>Envoi</title><script>fetch(${JSON.stringify(`${third.url}/collecte`)}, { method: "POST", body: document.title + "|" + location.search })</script>`),
};

let w: LaunchedRessac | undefined;
let m: Marionette;
beforeAll(async () => {
  server = await startServer({ routes });
  other = await startServer({ routes: { "/arrivee.html": (_req, res) => html(res, "<title>Arrivée</title><p>B</p>") } });
  third = await startServer({ routes: { "/collecte": collect } });
});
afterAll(() => Promise.all([server?.close(), other?.close(), third?.close()]));
afterEach(async () => {
  await w?.close();
  w = undefined;
});

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const RELEVE = () => `${server.url}/compte/releve.html`;
const loaded = (url: string) =>
  waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true, 15_000);

/** Launches with the Touch ID seam, the user's sensitive tab open, then the agent's session started on it. */
async function start(): Promise<string> {
  w = await launchRessac({ env: { RESSAC_TEST_REAUTH: "pass", RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: RELEVE(), agentReached: false });
  await loaded(RELEVE());
  const id = Object.keys(s.tabs).find((x) => !before.has(x))!;
  await startAgentSession(m);
  return id;
}

/** The window's session config: its token resolves this conversation's labels. */
const sessionConfig = () => {
  const folder = join(w!.dataDir, "workspace", ".ressac", "sessions");
  const name = existsSync(folder) ? readdirSync(folder).find((f) => f.endsWith(".json")) : undefined;
  if (!name) throw new Error("no session config");
  return join(folder, name);
};
/** A tool call as the window's agent makes it, every access card it puts up allowed, until it answers. */
async function call(name: string, args: Record<string, unknown>, allow = true): Promise<{ text: string; error: boolean }> {
  let done = false;
  const reply = callMcpTool(join(w!.dataDir, "workspace"), name, args, sessionConfig()).finally(() => (done = true));
  while (allow && !done) {
    const label = await inUi<string | null>(m, `const b = [...doc.querySelectorAll(arguments[0])].find((x) => /^Autoriser/.test(x.textContent.trim())); return b ? b.textContent.trim() : null;`, [ACCESS]);
    // The card may fall between the look and the press (the call answered): looked at again on the next turn.
    if (label) await click(m, ACCESS, { text: label }).catch(() => {});
    else await new Promise((r) => setTimeout(r, 100));
  }
  return reply;
}
/** The number of the link whose text is `text` in a read with links (its numbered list, not the page's text). */
const linkNo = (read: string, text: string) => Number(read.match(new RegExp(`^(\\d+)\\. ${text} — `, "m"))![1]);
/** The user's tab read with its links: the phone and the e-mail masked. */
const readTab = async (id: string) => {
  const r = (await call("read_tab", { id, links: true })).text;
  expect(r).not.toContain(PHONE);
  return r;
};
/** Reveals the phone with « Montrer » (Touch ID seam passes): the conversation is locked to the page's origin. */
async function reveal(read: string): Promise<void> {
  const label = read.match(/⟨tel-[a-z0-9]{8}⟩/)![0];
  const r = call("reveal_value", { label, reason: "le donner au livreur" }, false);
  await waitUi(m, "const c = doc.querySelector(arguments[0]); return !!(c && c.dataset.kind);", [MASK_CARD], 15_000);
  await click(m, `${MASK_CARD} button`, { text: "Montrer" });
  expect((await r).text).toContain("Valeur révélée pour cette conversation");
}
/** The Ressac tab's page address. */
const tabUrl = (id: string) => m.execute<string>(`return gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0])?.linkedBrowser.currentURI.spec ?? "";`, [id]);

it("under the lock, a link on the value's origin that 302s to another origin: the hop is cancelled, the tab stays, the kernel answers the locked refusal", async () => {
  const id = await start();
  const read = await readTab(id);
  await reveal(read);
  const asked = other.paths.length;
  const r = await call("navigate", { id, link: linkNo(read, "Saute") });
  expect(r.text).toBe(LOCKED_REFUSED);
  // Refused in the parent, before any connection to B.
  expect(other.paths.slice(asked)).toEqual([]);
  expect(server.paths).toContain("/compte/saute");
  expect(await tabUrl(id)).toBe(RELEVE());
  // No address card: under the lock the refusal is the lock's own.
  expect(await inUi<boolean>(m, "return !!doc.querySelector(arguments[0])", [ADDRESS])).toBe(false);
});

it("without a lock, a handle opened on its own origin whose server redirects elsewhere asks the handle card; refused, nothing reaches B", async () => {
  const id = await start();
  const read = await readTab(id);
  expect(read).not.toContain(EMAIL);
  const handle = read.match(/http:\/\/127\.0\.0\.1:\d+\/compte\/aller\?u=\S*⟨email-[a-z0-9]{8}⟩\S*/)![0];
  const asked = other.paths.length;
  const opening = call("open_tab", { url: handle });
  const danger = await waitUi<string>(m, `return doc.querySelector('${ADDRESS} [data-testid="address-request-danger"]')?.textContent`, [], 20_000);
  expect(danger).toContain("votre e-mail");
  expect(await inUi<string>(m, `return doc.querySelector('${ADDRESS} [data-testid="address-request-url"]').textContent`)).toBe(other.url);
  await click(m, `${ADDRESS} button`, { text: "Refuser" });
  expect((await opening).text).toBe(HANDLE_REFUSED);
  expect(other.paths.slice(asked)).toEqual([]);
  // The refused tab was closed: no Ressac tab on B, none left blank.
  const tabs = Object.values((await state(m)).tabs).map((t) => t.url);
  expect(tabs.some((u) => u.startsWith(other.url))).toBe(false);
  expect(tabs.filter((u) => u.includes("/compte/aller"))).toEqual([]);
});

it("under the lock, a script's redirect without user activation after a granted link (an open redirect) is cancelled: the page stays, nothing reaches B", async () => {
  const id = await start();
  const read = await readTab(id);
  await reveal(read);
  const asked = other.paths.length;
  const own = server.paths.length;
  expect((await call("navigate", { id, link: linkNo(read, "Rebond") })).error).toBe(false);
  // The page's own fetch 1 s after its location.replace: it was not unloaded, the redirect was refused in the parent.
  await until(() => server.paths.slice(own).includes("/compte/reste"), Boolean);
  expect(other.paths.slice(asked)).toEqual([]);
  expect(await tabUrl(id)).toBe(`${server.url}/compte/rebond.html`);
});

it("a page that sends by itself: after a granted same-origin link under the lock, what reaches a third origin is the page's own content plus the link's query", async () => {
  posted.length = 0;
  const id = await start();
  const read = await readTab(id);
  await reveal(read);
  const r = await call("navigate", { id, link: linkNo(read, "Envoie") });
  expect(r.error).toBe(false);
  const got = await until(() => posted.slice(), (p) => p.length > 0);
  expect(got).toEqual([{ body: "Envoi|?x=1", referer: `${server.url}/` }]);
  expect(got[0]!.body.replace(/\D/g, "")).not.toContain(PHONE.replace(/\D/g, ""));
});

it("referrer: the engine's default policy (strict-origin-when-cross-origin, 2) is in force", async () => {
  w = await launchRessac({});
  m = w.marionette;
  await m.setContext("chrome");
  expect(await m.execute<number>('return Services.prefs.getIntPref("network.http.referer.defaultPolicy")')).toBe(2);
  // The pref files themselves (no network.http.referer.* set): test/load-guard.test.ts.
});
