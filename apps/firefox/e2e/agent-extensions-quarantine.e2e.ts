import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { callMcpTool } from "../test/mcp";
import { writeAgentExtension } from "./extensions/fixtures";
import { agentAddons, grant, inPage, launchWithAmo, openTab } from "./agent-extensions";
import { dispatch, state, waitFor } from "./firefox";
import type { LaunchedRessac } from "./launch";
import { startServer } from "./server";
import { click, inUi, pressKeys, startAgentSession, typeText, waitUi } from "./ui";

// Masking, Task 15: an agent extension reads pages past the masker. It runs only in Atelier, never under the workspace
// lock, and Firefox's quarantine keeps it off the user's sensitive hosts.
const SENSITIVE = "webmail.exemple.test";
const ID = "cacheur@agent.ressac";
const PHONE = "06 12 34 56 78";
const CARD = '[data-testid="mask-request"]';
const ACCESS = '[data-testid="permission-request"] button, [data-testid="devtools-request"] button';
const manifest = { manifest_version: 3, name: "Cacheur de l'agent", version: "1.0.0", content_scripts: [{ matches: ["http://127.0.0.1/*", `http://${SENSITIVE}/*`], css: ["cache.css"] }] };
const GRANT = { permissions: [], hosts: ["http://127.0.0.1/*", `http://${SENSITIVE}/*`], network: [], allSites: false, allSitesScripts: false, scripts: true };
const DISPLAY = "return [getComputedStyle(document.getElementById('cache-moi')).display, getComputedStyle(document.getElementById('reste')).display].join()";

const html = (res: ServerResponse, body: string) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
// `/compte/` makes the page sensitive: the reveal's source (e2e/masking-lock.e2e.ts).
const routes = { "/compte/releve.html": (_req: unknown, res: ServerResponse) => html(res, `<title>Relevé</title><p>Tél : ${PHONE}</p>`) };

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => (server = await startServer({ routes })));
afterAll(() => server?.close());

const dirs: string[] = [];
let w: LaunchedRessac | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Ressac with the hider granted in the default profile, `SENSITIVE` resolving to this machine. */
async function launch(env: Record<string, string> = {}): Promise<LaunchedRessac> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ressac-data-"));
  const profile = mkdtempSync(path.join(os.tmpdir(), "ressac-firefox-"));
  dirs.push(dataDir, profile);
  writeAgentExtension(path.join(dataDir, "workspace"), "cacheur", { "manifest.json": manifest, "cache.css": "#cache-moi { display: none !important; }\n" });
  grant(dataDir, "cacheur", GRANT);
  w = await launchWithAmo({ dataDir, profile, prefs: { "network.dns.localDomains": SENSITIVE }, env });
  return w;
}
/** The hider installed and in the state `active` (Firefox's own isActive), whatever its version. */
const addonActive = (l: LaunchedRessac, active: boolean) =>
  expect.poll(async () => (await agentAddons(l.marionette)).find((a) => a.id === ID)?.isActive, { timeout: 30_000 }).toBe(active);
/** The page of Ressac tab `tab` hides #cache-moi (and only it). */
const hidden = (l: LaunchedRessac, tab: string) => expect.poll(() => inPage<string>(l.marionette, tab, DISPLAY), { timeout: 15_000 }).toBe("none,block");

it("Atelier: the extension runs on an ordinary host but never on a sensitive one, first visit included", async () => {
  const l = await launch();
  await addonActive(l, true);
  // The static list is in Firefox's quarantine; a host outside it (webmail.*) is refused by the parent checkpoint.
  await waitFor(l.marionette, `return Services.prefs.getStringPref("extensions.quarantinedDomains.list", "").split(",").includes("mail.google.com")`, (v) => v === true, 15_000);
  expect(await l.marionette.execute("return Services.prefs.getBoolPref('extensions.quarantinedDomains.enabled', false)")).toBe(true);
  expect(await l.marionette.execute(`return Services.prefs.getStringPref("extensions.quarantinedDomains.list", "").split(",").includes(${JSON.stringify(SENSITIVE)})`)).toBe(false);
  const blocked = await openTab(l.marionette, `http://${SENSITIVE}:${server.port}/cache.html`);
  const control = await openTab(l.marionette, `${server.url}/cache.html`);
  await hidden(l, control);
  // Must not happen: the control tab, opened after it, was injected, so the sensitive one had its turn.
  await new Promise((r) => setTimeout(r, 1_000));
  expect(await inPage<string>(l.marionette, blocked, DISPLAY)).toBe("block,block");
  // The user's exemption in about:addons never holds for it.
  await l.marionette.execute(`Services.prefs.setBoolPref("extensions.quarantineIgnoredByUser.${ID}", true)`);
  await waitFor(l.marionette, `return Services.prefs.getBoolPref("extensions.quarantineIgnoredByUser.${ID}", false)`, (v) => v === false);
});

it("Navigateur disables it, Atelier enables it again; the panel's notice follows", { timeout: 120_000 }, async () => {
  const l = await launch();
  await addonActive(l, true);
  await dispatch(l.marionette, { type: "chooseAgentMode", mode: "browser" });
  await addonActive(l, false);
  await dispatch(l.marionette, { type: "chooseAgentMode", mode: "workshop" });
  await addonActive(l, true);
  const tab = await openTab(l.marionette, `${server.url}/cache.html`);
  await hidden(l, tab);
  await click(l.marionette, '[data-testid="agent-button"]');
  const notice = await waitUi<string>(l.marionette, "return doc.querySelector('[data-testid=\"agent-mask-extension\"]')?.textContent", [], 15_000, "agent");
  expect(notice).toBe("Une extension de l'agent peut lire les pages hors de vos sources.");
  await dispatch(l.marionette, { type: "chooseAgentMode", mode: "browser" });
  await waitUi(l.marionette, "return !doc.querySelector('[data-testid=\"agent-mask-extension\"]')", [], 15_000, "agent");
});

it("the workspace lock disables it; lifting it in Atelier enables it again", { timeout: 180_000 }, async () => {
  const l = await launch({ RESSAC_TEST_REAUTH: "pass", RESSAC_TEST_PUBLIC_ADDRESSES: "127.0.0.1" });
  const m = l.marionette;
  const workspace = path.join(l.dataDir, "workspace");
  const lockFile = path.join(l.dataDir, "masking", "lock.json");
  await addonActive(l, true);
  const sessionConfig = () => {
    const folder = path.join(workspace, ".ressac", "sessions");
    const name = existsSync(folder) ? readdirSync(folder).find((f) => f.endsWith(".json")) : undefined;
    if (!name) throw new Error("no session config");
    return path.join(folder, name);
  };
  /** A tool call as the window's agent makes it, every access card allowed, until it answers. */
  const call = async (name: string, args: Record<string, unknown>, allow = false) => {
    let done = false;
    const reply = callMcpTool(workspace, name, args, sessionConfig()).finally(() => (done = true));
    while (allow && !done) {
      const label = await inUi<string | null>(m, `const b = [...doc.querySelectorAll(arguments[0])].find((x) => /^Autoriser/.test(x.textContent.trim())); return b ? b.textContent.trim() : null;`, [ACCESS]);
      if (label) await click(m, ACCESS, { text: label }).catch(() => {});
      else await new Promise((r) => setTimeout(r, 100));
    }
    return reply;
  };

  // A reveal locks the workspace (as in e2e/masking-lock.e2e.ts).
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
  await reveal;
  await expect.poll(() => existsSync(lockFile)).toBe(true);
  await addonActive(l, false);

  // The conversation ends, then the default lift (quarantine) with a file the agent wrote since the reveal.
  mkdirSync(path.join(workspace, "notes"), { recursive: true });
  writeFileSync(path.join(workspace, "notes", "livreur.txt"), `appeler ${PHONE}\n`);
  if (await m.execute("return document.getElementById('ressac-agent').hidden")) await click(m, '[data-testid="agent-button"]');
  await waitUi(m, "return doc.querySelector('.xterm-rows')?.textContent.includes('ready>')", [], 20_000, "agent");
  await click(m, ".xterm-screen", { frame: "agent" });
  await typeText(m, "quit");
  await pressKeys(m, "Enter");
  await waitUi(m, `return doc.querySelector('[data-testid="agent-panel"]').textContent.includes("L'agent s'est arrêté.")`, [], 15_000, "agent");
  await click(m, '[data-testid="agent-lift-open"]', { frame: "agent" });
  // The list first (the card focuses its safe choice once listed), then the keyboard on it: Entrée quarantines.
  await waitUi(m, "return [...doc.querySelectorAll('[data-testid=\"lift-lock-file\"]')].some((f) => f.dataset.path === '/workspace/notes')", [], 15_000, "agent");
  await waitUi(m, "return doc.activeElement?.dataset.testid === 'lift-lock-quarantine'", [], 15_000, "agent");
  await pressKeys(m, "Enter");
  await expect.poll(() => existsSync(lockFile), { timeout: 20_000 }).toBe(false);
  await addonActive(l, true);
});
