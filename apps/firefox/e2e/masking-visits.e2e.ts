import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { tabInfos } from "../core/agent/bridge";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { answerHistory, callTool } from "./mcp";
import { startServer } from "./server";
import { agentPanelReady, click, inUi } from "./ui";

// Spec § 5.3: only the pages the user reached are their masking sources. A phone is masked in the sources and stays in
// clear on the rest of the web, so a read shows which zone the kernel put the page in.
const PHONE = "06 12 34 56 78";
const NAVIGABLES = "chrome://remote/content/shared/NavigableManager.sys.mjs";
const CARDS = '[data-testid="permission-request"] button, [data-testid="address-request"] button';

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
// `/compte/` makes the page sensitive (packages/kernel/src/access/sensitive.ts): a source when the user reached it.
const routes = {
  "/compte/releve.html": (_req: unknown, res: ServerResponse) => html(res, `<title>Relevé</title><p>Tél : ${PHONE}</p><a id="suite" href="/compte/suite.html">Suite</a>`),
  "/compte/suite.html": (_req: unknown, res: ServerResponse) => html(res, `<title>Suite</title><p>Tél : ${PHONE}</p>`),
  "/compte/connexion.html": (_req: unknown, res: ServerResponse) => html(res, `<title>Connexion</title><form action="/compte/espace.html"><input name="u" value="moi"><button id="entrer">Entrer</button></form>`),
  "/compte/espace.html": (_req: unknown, res: ServerResponse) => html(res, `<title>Espace</title><p>Tél : ${PHONE}</p>`),
  "/contact.html": (_req: unknown, res: ServerResponse) => html(res, `<title>Contact ${PHONE}</title><p>Écrivez-nous</p>`),
  "/repere.html": (_req: unknown, res: ServerResponse) => html(res, "<title>Repère</title><p>repère</p>"),
  // A load that never commits: the page in front stays.
  "/vide": (_req: unknown, res: ServerResponse) => void res.writeHead(204).end(),
  // Held until the test calls `release`: the user's load is pending meanwhile.
  "/compte/tenu.html": (_req: unknown, res: ServerResponse) => void held.then(() => html(res, `<title>Tenu</title><p>Tél : ${PHONE}</p>`)),
};
let release: () => void = () => {};
let held = new Promise<void>((ok) => (release = ok));

let server: Awaited<ReturnType<typeof startServer>>;
// A second origin, where the first one's 302 lands (case 4).
let other: Awaited<ReturnType<typeof startServer>>;
let w: LaunchedRessac | undefined;
let m: Marionette;
let dataDir: string | undefined;
let profile: string | undefined;
beforeAll(async () => {
  server = await startServer({ routes });
  other = await startServer({ routes: { "/arrivee.html": (_req, res) => html(res, `<title>Arrivée</title><p>Tél : ${PHONE}</p>`) } });
});
afterAll(() => Promise.all([server?.close(), other?.close()]));
afterEach(async () => {
  release();
  held = new Promise<void>((ok) => (release = ok));
  await w?.close();
  w = undefined;
  for (const d of [dataDir, profile]) if (d) await rm(d, { recursive: true, force: true });
  dataDir = profile = undefined;
});

/** Launches on this test's folders (kept across a restart), the kernel up and the agent's session open. */
async function start(): Promise<void> {
  dataDir ??= await mkdtemp(join(os.tmpdir(), "ressac-data-"));
  profile ??= await mkdtemp(join(os.tmpdir(), "ressac-firefox-"));
  w = await launchRessac({ dataDir, profile, env: { RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1", RESSAC_MEMORY_LOOP: "1", RESSAC_TEST_SEARCH_URL: `${server.url}/compte/connexion.html?q=%s` } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const config = join(w.dataDir, "workspace", ".ressac", "mcp.json");
  await until(async () => existsSync(config), Boolean, 20_000);
  // Opening the panel starts the agent's session, which takes back every access: tools are called after it.
  await agentPanelReady(m);
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out: last ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The tool call, every card it puts up (access, a sensitive page's re-ask, a composed address) allowed, until it answers. */
async function allowing(name: string, args: Record<string, unknown>): Promise<{ text: string; error: boolean }> {
  let done = false;
  const call = callTool(w!.dataDir, name, args).finally(() => (done = true));
  while (!done) {
    const label = await inUi<string | null>(m, `const b = [...doc.querySelectorAll(arguments[0])].find((x) => x.textContent.trim().startsWith("Autoriser")); return b ? b.textContent.trim() : null;`, [CARDS]);
    // The card may fall between the look and the press (the call answered): looked at again on the next turn.
    if (label) await click(m, CARDS, { text: label }).catch(() => {});
    else await new Promise((r) => setTimeout(r, 100));
  }
  return call;
}

/** The tab as the kernel's list_tabs gets it (chrome/agent/bridge.ts listTabs → tabInfos). */
const reached = async (id: string) => tabInfos(await state(m)).find((o) => o.id === id)?.agentReached;
const waitReached = (id: string, value: boolean) => until(() => reached(id), (v) => v === value);
const loaded = (url: string) =>
  waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true, 15_000);
/** A tab the user opens from Ressac's UI. */
async function userTab(url: string): Promise<string> {
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, agentReached: false });
  await loaded(url);
  return Object.keys(s.tabs).find((x) => !before.has(x))!;
}
/** Runs `script` in the page of tab `id` (content context), as the user's hand would act there. */
async function inPage(id: string, script: string): Promise<void> {
  const handle = await m.execute<string>(
    `const t = gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]);
     return ChromeUtils.importESModule("${NAVIGABLES}").NavigableManager.getIdForBrowser(t.linkedBrowser);`,
    [id],
  );
  await m.command("WebDriver:SwitchToWindow", { handle, focus: false });
  await m.setContext("content");
  try {
    await m.execute(script);
  } finally {
    await m.setContext("chrome");
  }
}
/** The address bar's own path (UrlBar.svelte → api.navigate → WindowController.navigate). */
const typeAddress = (id: string, url: string) => inUi(m, "ui.ressac.navigate(arguments[0], arguments[1])", [id, url]);

/** The URL's non-private rows in the history file: how many, and how many of their visits are the user's. */
function historyRows(url: string): { rows: number; user: number } {
  const db = new DatabaseSync(join(w!.dataDir, "history.sqlite"), { readOnly: true });
  try {
    const r = db.prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(user_visits), 0) AS user FROM visits WHERE url = ? AND private = 0").get(url) as { rows: number; user: number };
    return { rows: Number(r.rows), user: Number(r.user) };
  } finally {
    db.close();
  }
}
/** Waits for the URL's row (the visit is a notify to the host), then gives it. */
const historyRow = (url: string) => until(async () => historyRows(url), (r) => r.rows > 0);
const read = async (id: string) => (await allowing("read_tab", { id })).text;

it("a user tab taken over by the agent's navigate is the agent's, a click in it changes nothing, the address bar gives it back", async () => {
  await start();
  const page = `${server.url}/compte/releve.html`;
  const id = await userTab(page);
  await waitReached(id, false);
  const own = await read(id);
  expect(own).toMatch(/⟨tel-[a-z0-9]{8}⟩/);
  expect(own).not.toContain(PHONE);

  const taken = `${page}?agent=1`;
  expect((await allowing("navigate", { id, url: taken, reason: "relire le relevé" })).error).toBe(false);
  await loaded(taken);
  expect(await waitReached(id, true)).toBe(true);
  const web = await read(id);
  expect(web).toContain(PHONE);
  expect(web).not.toMatch(/⟨tel-/);

  // The user's click on a link of the agent's page: still the agent's (a trapped page's « continuer » proves nothing).
  await inPage(id, 'document.getElementById("suite").click()');
  await loaded(`${server.url}/compte/suite.html`);
  // Read once the click's page has loaded: the last thing that could have changed the flag.
  expect(await reached(id)).toBe(true);
  expect(await read(id)).toContain(PHONE);

  // The user types the address: their own top-level navigation, the tab is a source again.
  await typeAddress(id, page);
  await loaded(page);
  expect(await waitReached(id, false)).toBe(false);
  const back = await read(id);
  expect(back).toMatch(/⟨tel-[a-z0-9]{8}⟩/);
  expect(back).not.toContain(PHONE);
});

it("hand_over: the user signs in in the search tab, which stays the agent's; its page is never a user visit", async () => {
  await start();
  const id = /Onglet : (\S+)/.exec((await callTool(w!.dataDir, "search_web", { query: "x", goal: "se connecter" })).text)![1]!;
  const handing = callTool(w!.dataDir, "hand_over", { id, reason: "Connectez-vous", kind: "verification" });
  await until(async () => (await state(m)).tabs[id]?.agentSearch?.state, (v) => v === "yours");
  await loaded(`${server.url}/compte/connexion.html?q=x`);
  await inPage(id, 'document.getElementById("entrer").click()');
  const landed = `${server.url}/compte/espace.html?u=moi`;
  await loaded(landed);
  // Even the address bar, during the hand-over, does not make the agent's own profile the user's.
  await typeAddress(id, landed);
  await loaded(landed);
  expect(await reached(id)).toBe(true);
  // Visits are notified in order: once a later user visit is in the file, the search tab's would be too.
  const marker = `${server.url}/repere.html`;
  await userTab(marker);
  expect((await historyRow(marker)).user).toBe(1);
  expect(historyRows(landed).user).toBe(0);
  // The band shows on the search tab only: brought back before its Continuer is pressed.
  await dispatch(m, { type: "activateTab", id });
  await waitFor(m, `return !!document.querySelector('[data-testid="search-band"]')?.hasAttribute("data-shown")`, (v) => v === true);
  await m.execute(`document.querySelector('[data-testid="search-band"] [data-testid="search-continue"]').click();`);
  expect((await handing).text).toContain("La page est de nouveau à toi");
  expect(await reached(id)).toBe(true);
});

it("a page the agent opened is never the user's in search_history, in this conversation and after a restart", async () => {
  await start();
  const page = `${server.url}/contact.html`;
  const { text: id } = await allowing("open_tab", { url: page });
  await loaded(page);
  expect(await waitReached(id, true)).toBe(true);
  expect(await historyRow(page)).toMatchObject({ user: 0 });
  await answerHistory(m, w!.dataDir);
  const found = await until(async () => (await callTool(w!.dataDir, "search_history", { query: "contact" })).text, (t) => t.includes(page));
  // The rest of the web's zone: the phone stays in clear, never a source's label.
  expect(found).toContain(PHONE);
  expect(found).not.toMatch(/⟨tel-/);

  await w!.close();
  w = undefined;
  await start();
  // Restored from the session, the tab is still the agent's.
  expect(await waitReached(id, true)).toBe(true);
  expect(historyRows(page).user).toBe(0);
  await answerHistory(m, w!.dataDir);
  const again = await until(async () => (await callTool(w!.dataDir, "search_history", { query: "contact" })).text, (t) => t.includes(page));
  expect(again).toContain(PHONE);
  expect(again).not.toMatch(/⟨tel-/);
});

it("an agent navigation answered by a 302 to another origin lands in an agent-reached tab, its visit not the user's", async () => {
  await start();
  const id = await userTab(`${server.url}/repere.html`);
  await waitReached(id, false);
  const landing = `${other.url}/arrivee.html`;
  await allowing("navigate", { id, url: `${server.url}/redirige?vers=${encodeURIComponent(landing)}`, reason: "suivre le lien" });
  await loaded(landing);
  expect(await waitReached(id, true)).toBe(true);
  // A redirect notes only its target (history.e2e): the landing's row, the agent's.
  expect(await historyRow(landing)).toMatchObject({ user: 0 });
  expect(historyRows(`${server.url}/repere.html`).user).toBe(1);
});

it("the user's load gives an agent tab back only once it commits: a 204 or a download changes nothing, a note before the commit stays the agent's", async () => {
  await start();
  const page = `${server.url}/compte/releve.html`;
  const { text: id } = await allowing("open_tab", { url: page });
  await loaded(page);
  await waitReached(id, true);
  const stopped = async (path: string) => {
    await until(async () => server.paths.includes(path), Boolean);
    // The pending user load ends without a commit (loadStopped): the marker is gone, the tab still the agent's.
    await until(async () => (await state(m)).tabs[id]?.userLoad, (v) => v === undefined);
  };
  await typeAddress(id, `${server.url}/vide`);
  await stopped("/vide");
  expect(await reached(id)).toBe(true);
  expect(await read(id)).toContain(PHONE);
  await typeAddress(id, `${server.url}/telecharge`);
  await stopped("/telecharge");
  expect(await reached(id)).toBe(true);

  // A held user load: the agent's page changes its address meanwhile; that note is the agent's.
  const target = `${server.url}/compte/tenu.html`;
  await typeAddress(id, target);
  await until(async () => server.paths.includes("/compte/tenu.html"), Boolean);
  expect((await state(m)).tabs[id]?.userLoad).toBe(target);
  await inPage(id, 'history.pushState(null, "", "?pendant=1"); document.title = "Pendant";');
  expect(await historyRow(`${page}?pendant=1`)).toMatchObject({ user: 0 });
  expect(await reached(id)).toBe(true);
  release();
  await loaded(target);
  expect(await waitReached(id, false)).toBe(false);
  expect((await historyRow(target)).user).toBe(1);
});

it("Back to a page the agent reached makes the tab the agent's again", async () => {
  await start();
  const id = await userTab(`${server.url}/repere.html`);
  const taken = `${server.url}/compte/releve.html?agent=1`;
  await allowing("navigate", { id, url: taken, reason: "relire" });
  await loaded(taken);
  await waitReached(id, true);
  const mine = `${server.url}/compte/suite.html`;
  await typeAddress(id, mine);
  await loaded(mine);
  await waitReached(id, false);
  // Firefox's own Back (keys, swipe, menu): a session-history load.
  await m.execute(`gBrowser.tabs.find((t) => t.getAttribute("ressac-tab-id") === arguments[0]).linkedBrowser.goBack();`, [id]);
  await loaded(taken);
  expect(await waitReached(id, true)).toBe(true);
  const back = await read(id);
  expect(back).toContain(PHONE);
  expect(back).not.toMatch(/⟨tel-/);
});

it("« Recharger » or the agent tab's own address entered again keeps it the agent's", async () => {
  await start();
  const page = `${server.url}/compte/releve.html`;
  const { text: id } = await allowing("open_tab", { url: page });
  await loaded(page);
  await waitReached(id, true);
  const count = () => server.paths.filter((p) => p === "/compte/releve.html").length;
  const before = count();
  await typeAddress(id, page);
  // Wait for the reload's request and its end: the last thing that could have changed the flag.
  await until(async () => count(), (n) => n > before);
  await loaded(page);
  expect(await reached(id)).toBe(true);
  expect((await state(m)).tabs[id]?.userLoad).toBeUndefined();
});
