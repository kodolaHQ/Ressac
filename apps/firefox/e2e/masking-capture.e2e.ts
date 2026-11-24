import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { agentPanelReady, click, inUi, waitUi } from "./ui";
// Test values built at run time: a Luhn-valid card, a French IBAN.
import { CARD, IBAN } from "../../../packages/kernel/test/mask/values";

// What a capture shows and a read leaves out (SECURITY.md « Carrier tabs »): a field's typed value, a frame of another
// site. And a tab that moves within its site while its access card is up is read as the page it moved to.
const REFUSED = "Capture refusée : cet onglet montre vos données.";
const PHONE = "06 12 34 56 78";
const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const CARDS = '[data-testid="permission-request"] button, [data-testid="address-request"] button';

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
let other: Awaited<ReturnType<typeof startServer>>;
let server: Awaited<ReturnType<typeof startServer>>;
// The frame tells its parent it loaded: a cross-site frame's document is not the test's to look into.
const frame = (body: string) => `<title>Cadre</title>${body}<script>parent.postMessage("pret", "*")</script>`;
const framed = (src: string) =>
  `<title>Intranet</title><p>Intranet</p><iframe src="${src}"></iframe><script>addEventListener("message", (e) => { if (e.data === "pret") window.framePret = true; })</script>`;

let w: LaunchedRessac | undefined;
let m: Marionette;
let dataDir: string | undefined;
let profile: string | undefined;
beforeAll(async () => {
  other = await startServer({
    routes: {
      "/paie.html": (_req: unknown, res: ServerResponse) => html(res, frame(`<p>Virement du salaire sur ${IBAN}</p>`)),
      "/vide.html": (_req: unknown, res: ServerResponse) => html(res, frame("<p>Bulletins de paie</p>")),
    },
  });
  server = await startServer({
    routes: {
      "/paiement.html": (_req: unknown, res: ServerResponse) => html(res, `<title>Paiement</title><p>Paiement</p><input id="carte" autocomplete="off">`),
      "/intranet.html": (_req: unknown, res: ServerResponse) => html(res, framed(`${other.url}/paie.html`)),
      "/intranet-vide.html": (_req: unknown, res: ServerResponse) => html(res, framed(`${other.url}/vide.html`)),
      "/boutique.html": (_req: unknown, res: ServerResponse) => html(res, `<title>Boutique</title><p>Service client : ${PHONE}</p>`),
      // `/compte/` makes the page sensitive (packages/kernel/src/access/sensitive.ts): a source when the user reached it.
      "/compte/coordonnees.html": (_req: unknown, res: ServerResponse) => html(res, `<title>Coordonnées</title><p>Votre téléphone : ${PHONE}</p>`),
    },
  });
});
afterAll(() => Promise.all([server?.close(), other?.close()]));
afterEach(async () => {
  await w?.close();
  w = undefined;
  for (const d of [dataDir, profile]) if (d) await rm(d, { recursive: true, force: true });
  dataDir = profile = undefined;
});

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function start(): Promise<void> {
  dataDir ??= await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  profile ??= await mkdtemp(join(os.tmpdir(), "ressac-firefox-"));
  w = await launchRessac({ dataDir, profile, env: { RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1" } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  await until(async () => existsSync(join(w!.dataDir, "workspace", ".ressac", "mcp.json")), Boolean, 20_000);
  // Opening the panel starts the agent's session, which takes back every access: tools are called after it.
  await agentPanelReady(m);
}

const loaded = (url: string) =>
  waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true, 15_000);
/** A tab the user opens from Ressac's UI. */
async function userTab(url: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, agentReached: false });
  await loaded(url);
  return Object.keys(s.tabs).find((x) => !before.has(x))!;
}
/** Runs `script` in the page of tab `id` (content context). */
async function inPage<T = unknown>(id: string, script: string): Promise<T> {
  const handle = await m.execute<string>(
    `const t = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]);
     return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(t.linkedBrowser);`,
    [id],
  );
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    return await m.execute<T>(script);
  } finally {
    await m.setContext("chrome");
  }
}
/** The tool call, every access card it puts up allowed, until it answers. */
async function allowing(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean; image?: string }> {
  let done = false;
  const call = callTool(w!.dataDir, name, args).finally(() => (done = true));
  while (!done) {
    const label = await inUi<string | null>(m, `const b = [...doc.querySelectorAll(arguments[0])].find((x) => x.textContent.trim().startsWith("Autoriser")); return b ? b.textContent.trim() : null;`, [CARDS]);
    if (label) await click(m, CARDS, { text: label }).catch(() => {});
    else await new Promise((r) => setTimeout(r, 100));
  }
  return call;
}

it("a card number typed into a plain field: the capture goes before, is refused after", async () => {
  await start();
  const id = await userTab(`${server.url}/paiement.html`);
  expect((await allowing("capture_screen", { id })).image?.startsWith("iVBOR")).toBe(true);
  await inPage(id, `document.getElementById("carte").value = ${JSON.stringify(CARD)}; return true;`);
  expect((await allowing("capture_screen", { id })).text).toBe(REFUSED);
});

it("a frame of another site showing an IBAN: the capture is refused; the same frame showing nothing private: it goes", async () => {
  await start();
  const plain = await userTab(`${server.url}/intranet-vide.html`);
  await until(() => inPage<boolean>(plain, "return window.framePret === true"), Boolean);
  expect((await allowing("capture_screen", { id: plain })).image?.startsWith("iVBOR")).toBe(true);
  const id = await userTab(`${server.url}/intranet.html`);
  await until(() => inPage<boolean>(id, "return window.framePret === true"), Boolean);
  expect((await allowing("capture_screen", { id })).text).toBe(REFUSED);
});

it("a tab that moves to its site's account page while the read card is up is read as that page: the phone masked", async () => {
  await start();
  const id = await userTab(`${server.url}/boutique.html`);
  const reading = callTool(w!.dataDir, "read_tab", { id });
  await waitUi(m, `return !!doc.querySelector('[data-testid="permission-request"]')`, [], 20_000);
  const account = `${server.url}/compte/coordonnees.html`;
  await inPage(id, `location.href = ${JSON.stringify(account)}; return true;`);
  await loaded(account);
  await click(m, CARDS, { text: "Autoriser" });
  const text = (await reading).text;
  expect(text).toContain("/compte/coordonnees.html");
  expect(text).not.toContain(PHONE);
  expect(text).toMatch(/⟨tel-[a-z0-9]{8}⟩/);
});

it("an address card shows each red line on its own, the lock line kept whole after a long one", async () => {
  await start();
  const win = await m.execute<string>("return window.ressacWindow.windowId");
  const long = `Cette adresse contient votre e-mail, lu sur mail.example : elle l'envoie à ${"suivi-colis.".repeat(30)}example.`;
  const lock = "Conversation verrouillée : votre code a été révélé. Cette sortie demande votre accord.";
  await m.execute(
    `return (async () => {
      const s = await ChromeUtils.importESModule("${STORE}").ready;
      s.questions.askAddress(JSON.parse(arguments[0]), arguments[1]);
    })();`,
    [JSON.stringify({ url: "https://exemple.com/", reason: "test", agent: "A", danger: `${lock}\n${long}` }), win],
  );
  const lines = await waitUi<string[]>(m, `const l = [...doc.querySelectorAll('[data-testid="address-request-danger"]')].map((p) => p.textContent); return l.length ? l : null;`);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe(`⚠ ${lock}`);
  expect(lines[1]!.length).toBeLessThan(long.length);
});
