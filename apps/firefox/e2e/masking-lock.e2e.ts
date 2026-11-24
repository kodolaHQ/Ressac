import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { callMcpTool } from "../test/mcp";
import { dispatch, state, waitFor } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, pressKeys, startAgentSession, typeText, waitUi } from "./ui";

// Lifting the workspace lock (spec § 3): the files the agent changed since the reveal go to quarantine by default, the
// network gets its full list back, and « Rendre à l'atelier » puts a file back. The fake docker stands in for the
// container (test/tools/fake-docker.cjs: /workspace is the space folder, the reveal stamp a file beside it).
const PHONE = "06 12 34 56 78";
const REVEALED = "Valeur révélée pour cette conversation";
const CARD = '[data-testid="mask-request"]';
const ACCESS = '[data-testid="permission-request"] button, [data-testid="devtools-request"] button';

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
// `/compte/` makes the page sensitive: a masking source once the user reached it (e2e/masking-visits.e2e.ts).
const routes = { "/compte/releve.html": (_req: unknown, res: ServerResponse) => html(res, `<title>Relevé</title><p>Tél : ${PHONE}</p>`) };

let server: Awaited<ReturnType<typeof startServer>>;
/** « Afficher dans le Finder » writes the path here instead of opening the Finder (RESSAC_TEST_REVEAL). */
const reveals = join(mkdtempSync(join(tmpdir(), "ressac-reveal-")), "reveals.txt");
let w: LaunchedRessac | undefined;
let m: Marionette;
beforeAll(async () => (server = await startServer({ routes })));
afterAll(() => server?.close());
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const workspace = () => join(w!.dataDir, "workspace");
const lockFile = () => join(w!.dataDir, "masking", "lock.json");
/** Every file under the quarantine folder, as `<stamp>/<store>/<container path>`. */
const quarantined = (): string[] => {
  const root = join(w!.dataDir, "masking", "quarantine");
  return existsSync(root) ? readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(root.length + 1)) : [];
};
/** The network rules each apply carried, oldest first (the fake docker writes one JSON per line). */
const applies = (): { locked: boolean }[] => {
  const f = join(workspace(), "fake-docker-network.log");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

/** The session config of the window's conversation: its token resolves this conversation's labels. */
const sessionConfig = () => {
  const folder = join(workspace(), ".ressac", "sessions");
  const name = existsSync(folder) ? readdirSync(folder).find((f) => f.endsWith(".json")) : undefined;
  if (!name) throw new Error("no session config");
  return join(folder, name);
};
/** A tool call as the window's agent makes it, every access card it puts up allowed, until it answers. */
async function call(name: string, args: Record<string, unknown>, allow = false): Promise<{ text: string; error: boolean }> {
  let done = false;
  const reply = callMcpTool(workspace(), name, args, sessionConfig()).finally(() => (done = true));
  while (allow && !done) {
    const label = await inUi<string | null>(m, `const b = [...doc.querySelectorAll(arguments[0])].find((x) => /^Autoriser/.test(x.textContent.trim())); return b ? b.textContent.trim() : null;`, [ACCESS]);
    // The card may fall between the look and the press (the call answered): looked at again on the next turn.
    if (label) await click(m, ACCESS, { text: label }).catch(() => {});
    else await new Promise((r) => setTimeout(r, 100));
  }
  return reply;
}

/** Launched with the Touch ID seam passing, the user's sensitive tab open, the agent's session on it, then a reveal granted. */
async function revealed(): Promise<void> {
  w = await launchRessac({ env: { RESSAC_TEST_REAUTH: "pass", RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1", RESSAC_TEST_REVEAL: reveals } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitFor(m, "return !!window.ressacWindow && gBrowser.tabs.some((t) => t.hasAttribute('ressac-parking'))", (v) => v === true);
  const url = `${server.url}/compte/releve.html`;
  const before = new Set(Object.keys((await state(m)).tabs));
  const s = await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url, agentReached: false });
  await waitFor(m, `return gBrowser.tabs.some((t) => t.linkedBrowser.currentURI.spec === ${JSON.stringify(url)} && !t.linkedBrowser.webProgress.isLoadingDocument)`, (v) => v === true, 15_000);
  const id = Object.keys(s.tabs).find((x) => !before.has(x))!;
  await startAgentSession(m);
  const label = (await call("read_tab", { id }, true)).text.match(/⟨tel-[a-z0-9]{8}⟩/)![0];
  const reveal = call("reveal_value", { label, reason: "le donner au livreur" });
  await waitUi(m, "const c = doc.querySelector(arguments[0]); return c && c.dataset.kind && c.textContent;", [CARD], 15_000);
  await click(m, `${CARD} button`, { text: "Montrer" });
  expect((await reveal).text).toContain(REVEALED);
  await expect.poll(() => existsSync(lockFile())).toBe(true);
  await expect.poll(() => applies().at(-1)?.locked).toBe(true);
}

/** The agent panel open on its terminal. */
async function openPanel(): Promise<void> {
  if (await m.execute("return document.getElementById('ressac-agent').hidden")) await click(m, '[data-testid="agent-button"]');
  await waitFor(m, "return !document.getElementById('ressac-agent').hidden", (v) => v === true);
}
/** The conversation ends the way the user ends it: `quit` typed in the terminal (the fake agent exits). */
async function endConversation(): Promise<void> {
  await openPanel();
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
  await click(m, ".xterm-screen", { frame: "agent" });
  await typeText(m, "quit");
  await pressKeys(m, "Enter");
  await waitUi(m, `return doc.querySelector('[data-testid="agent-panel"]').textContent.includes("L'agent s'est arrêté.")`, [], 15_000, "agent");
}
/** The lift card, opened from the lock banner, once it lists `path`. */
async function openLiftCard(path: string): Promise<void> {
  await click(m, '[data-testid="agent-lift-open"]', { frame: "agent" });
  await waitUi(m, "return [...doc.querySelectorAll('[data-testid=\"lift-lock-file\"]')].some((f) => f.dataset.path === arguments[0])", [path], 15_000, "agent");
}

it("the default lift quarantines what the agent wrote, gives the network its full list back, and « Rendre » puts it back", async () => {
  await revealed();
  // The agent's own Write tool skips the MCP server: a file in the workspace, after the reveal.
  mkdirSync(join(workspace(), "notes"), { recursive: true });
  writeFileSync(join(workspace(), "notes", "livreur.txt"), `appeler ${PHONE}\n`);
  await endConversation();
  // A folder made since the reveal is one entry: its name may hold the value too, it goes whole.
  await openLiftCard("/workspace/notes");
  expect(await inUi<string>(m, "return doc.querySelector('[data-testid=\"lift-lock\"]').textContent", [], "agent")).toContain("L'atelier peut contenir votre téléphone sous une forme que Ressac ne reconnaît pas.");
  // Entrée takes the default choice: wait for the quarantine button to hold the keyboard (the card focuses it once listed).
  await waitUi(m, "return doc.activeElement?.dataset.testid === 'lift-lock-quarantine'", [], 10_000, "agent");
  // The opening click can hand the frame's focus back to the terminal after the list shows (late under load): the card
  // takes it back, since the user has not acted.
  await inUi(m, "doc.querySelector('.xterm-helper-textarea').focus(); return true;", [], "agent");
  await waitUi(m, "return doc.activeElement?.dataset.testid === 'lift-lock-quarantine'", [], 10_000, "agent");
  await pressKeys(m, "Enter");
  await expect.poll(() => existsSync(lockFile()), { timeout: 20_000 }).toBe(false);
  expect(existsSync(join(workspace(), "notes"))).toBe(false);
  const moved = quarantined().find((p) => p.endsWith("/workspace/workspace/notes/livreur.txt"));
  expect(moved).toBeDefined();
  expect(readFileSync(join(w!.dataDir, "masking", "quarantine", moved!), "utf8")).toContain(PHONE);
  // The lock file's listener applies the rules again, unlocked: the proxy takes the full list.
  await expect.poll(() => applies().at(-1)?.locked, { timeout: 15_000 }).toBe(false);
  await waitUi(m, "return !doc.querySelector('[data-testid=\"agent-mask-locked\"]') && !doc.querySelector('[data-testid=\"lift-lock\"]')", [], 10_000, "agent");

  // Réglages › Agent lists it; « Rendre à l'atelier » copies it back and empties the list. Off the agent's tab, the pill
  // of that tab floats over the page's bottom right, where the button may land: hidden first, as the user would.
  await click(m, '[data-testid="settings-button"]');
  await click(m, '[data-testid="settings-nav-agent"]');
  await click(m, '[data-testid="agent-pill-close"]', { frame: "agentview" });
  await waitFor(m, "return document.getElementById('ressac-agent-pill').getBoundingClientRect().width", (v) => v === 0);
  await waitUi(m, "return [...doc.querySelectorAll('[data-testid=\"settings-quarantine-file\"]')].some((f) => f.dataset.path === '/workspace/notes/livreur.txt')", [], 15_000);
  // « Afficher dans le Finder » shows the quarantined file itself, so the user can read it before giving it back.
  await click(m, '[data-testid="settings-quarantine-reveal"]');
  await expect.poll(() => (existsSync(reveals) ? readFileSync(reveals, "utf8") : "")).toContain(`/masking/quarantine/${moved}\n`);
  await click(m, '[data-testid="settings-quarantine-restore"]');
  await expect.poll(() => existsSync(join(workspace(), "notes", "livreur.txt")), { timeout: 15_000 }).toBe(true);
  expect(readFileSync(join(workspace(), "notes", "livreur.txt"), "utf8")).toContain(PHONE);
  // The copy lands before the quarantine entry goes: its removal is waited for.
  await expect.poll(() => quarantined()).toEqual([]);
  await waitUi(m, "return !doc.querySelector('[data-testid=\"settings-quarantine\"]')", [], 10_000);
});

it("a lift while the conversation runs is refused with its reason: the lock and the file stay", async () => {
  await revealed();
  writeFileSync(join(workspace(), "brouillon.txt"), PHONE);
  await openPanel();
  await openLiftCard("/workspace/brouillon.txt");
  await click(m, '[data-testid="lift-lock-quarantine"]', { frame: "agent" });
  const error = await waitUi<string>(m, "return doc.querySelector('[data-testid=\"lift-lock-error\"]')?.textContent", [], 15_000, "agent");
  expect(error).toContain("Arrêtez la conversation pour lever le verrou");
  // While locked no agent app starts (the lock stopped the running ones).
  expect((await call("launch_app", { folder: "demo" })).text).toContain("aucune application ne se lance");
  expect(existsSync(lockFile())).toBe(true);
  expect(existsSync(join(workspace(), "brouillon.txt"))).toBe(true);
  expect(quarantined()).toEqual([]);
});
