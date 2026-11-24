import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Action } from "../shared/api";
import { writeAgentExtension } from "./extensions/fixtures";
import { agentAddons, grant, inPage, launchWithAmo, openTab } from "./agent-extensions";
import { dispatch, state, waitFor } from "./firefox";
import type { LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { callTool } from "./mcp";
import { startServer } from "./server";
import { click, inUi, waitUi, agentPanelReady } from "./ui";

// The space settings' Extensions section (A7, N1, Review Focus 5), plus spec choice 2: an agent extension's content scripts run only in the spaces it is active in.
const HOST = "http://127.0.0.1/*";
const GRANT = { permissions: [], hosts: [HOST], network: [], allSites: false, allSitesScripts: false, scripts: true };
const PRIVATE_PROFILE_ERROR = "Donne à cet espace privé son propre profil pour y utiliser des extensions de l'agent";
const HIDER = {
  "manifest.json": { manifest_version: 3, name: "Cacheur de l'agent", version: "1.0.0", content_scripts: [{ matches: [HOST], css: ["cache.css"] }] },
  "cache.css": "#cache-moi { display: none !important; }\n",
};
const tic = (matches: string[]) => ({
  "manifest.json": { manifest_version: 3, name: "Tic de l'agent", version: "1.0.0", content_scripts: [{ matches, js: ["tic.js"] }] },
  "tic.js": 'let n = 0;\nsetInterval(() => document.documentElement.setAttribute("data-tic", String(++n)), 100);\n',
});
const MODAL = '[data-testid="space-modal"]';
const REQUEST = '[data-testid="request-modal"]';

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());

const dirs: string[] = [];
const opened: LaunchedRessac[] = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Ressac with the fake AMO; `prepare` writes the agent's folder and the registry first. `agent`: the kernel's MCP
 * config written and the agent's session started (a new conversation takes down the cards asked before it).
 */
async function launch(prepare: (root: string, dataDir: string) => void = () => {}, o: { agent?: boolean } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ressac-data-"));
  const profile = mkdtempSync(path.join(os.tmpdir(), "ressac-firefox-"));
  dirs.push(dataDir, profile);
  const root = path.join(dataDir, "workspace");
  prepare(root, dataDir);
  const w = await launchWithAmo({ dataDir, profile });
  opened.push(w);
  if (o.agent) {
    const config = path.join(root, ".ressac", "mcp.json");
    for (const deadline = Date.now() + 20_000; !existsSync(config); await new Promise((r) => setTimeout(r, 100)))
      if (Date.now() > deadline) throw new Error("the kernel did not write its MCP config");
    await agentPanelReady(w.marionette);
  }
  return { ...w, root: root, call: (name: string, args: Record<string, unknown> = {}) => callTool(dataDir, name, args) };
}

const registry = (dataDir: string) => {
  const f = path.join(dataDir, "extensions", "state.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { extensions: Record<string, { profiles: string[]; addonId: string | null }> }).extensions : {};
};
/** The agent's add-on `id` installed and active (or not) in Firefox. */
const waitActive = (m: Marionette, id: string, active: boolean) =>
  waitFor(m, `return (async () => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    return !!(await AddonManager.getAddonByID(${JSON.stringify(id)}))?.isActive;
  })();`, (v) => v === active, 30_000);
async function until(ok: () => boolean, ms = 15_000): Promise<void> {
  for (const deadline = Date.now() + ms; !ok(); await new Promise((r) => setTimeout(r, 100)))
    if (Date.now() > deadline) throw new Error("timed out");
}
async function poll<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
}
const activeSpace = async (m: Marionette) => {
  const s = await state(m);
  return s.spaces.find((e) => e.id === s.windows[0]!.activeSpace)!;
};
async function setPrivate(m: Marionette, isPrivate: boolean): Promise<void> {
  const e = await activeSpace(m);
  await dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: isPrivate, profile: e.profile } as Action);
}
async function setSpacePrivate(m: Marionette, id: string): Promise<void> {
  const e = (await state(m)).spaces.find((x) => x.id === id)!;
  await dispatch(m, { type: "updateSpace", id: e.id, name: e.name, icon: e.icon, private: true, profile: e.profile } as Action);
}
const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const hostPid = (m: Marionette) => m.execute<number | null>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`);
async function openSettings(m: Marionette, spaceId: string): Promise<void> {
  await click(m, `[data-testid="space-${spaceId}"]`, { button: 2 });
  await click(m, '[role="menuitem"]', { text: "Réglages" });
  await waitUi(m, "return doc.querySelector(arguments[0] + ' h2')?.textContent === \"Réglages de l'espace\"", [MODAL]);
}
/** The modal's extension line named `nom`: its switch (checked, disabled) and its text. */
const line = (m: Marionette, name: string) =>
  waitUi<{ checked: boolean; disabled: boolean; text: string }>(
    m,
    `const l = [...doc.querySelectorAll(arguments[0] + ' [data-testid="extension-row"]')].find((x) => x.querySelector("b")?.textContent === arguments[1]);
     const s = l?.querySelector('[role="switch"]');
     return s && { checked: s.checked, disabled: s.disabled, text: l.textContent };`,
    [MODAL, name],
  );
const display = (m: Marionette, tab: string) =>
  inPage<string>(m, tab, "return [getComputedStyle(document.getElementById('cache-moi')).display, getComputedStyle(document.getElementById('reste')).display].join()");
const ticks = (m: Marionette, tab: string) => inPage<number>(m, tab, "return Number(document.documentElement.getAttribute('data-tic'))");
/** A mark on the page's document: gone once the tab reloaded. */
const mark = (m: Marionette, tab: string) => inPage(m, tab, "document.documentElement.setAttribute('data-avant', '1')");
const reloaded = (m: Marionette, tab: string) =>
  // readyState first: mid-reload, the new document has no documentElement yet.
  poll(() => inPage<boolean>(m, tab, "return document.readyState === 'complete' && !document.documentElement.hasAttribute('data-avant')"), (v) => v);

describe("agent extensions per space", () => {
  it("active in space A only: its content script runs in A's tab, not in B's (another profile)", async () => {
    const w = await launch((root, dataDir) => (writeAgentExtension(root, "cacheur", HIDER), grant(dataDir, "cacheur", GRANT)));
    const m = w.marionette;
    await waitActive(m, "cacheur@agent.ressac", true);
    const a = await openTab(m, `${server.url}/cache.html`);
    expect(await poll(() => display(m, a), (v) => v === "none,block")).toBe("none,block");
    await dispatch(m, { type: "createSpace", name: "B", icon: "🅱️", private: false, profile: "new", windowId: (await state(m)).windows[0]!.id } as Action);
    const b = await openTab(m, `${server.url}/cache.html`);
    expect((await state(m)).tabs[b]!.spaceId).not.toBe((await state(m)).tabs[a]!.spaceId);
    await new Promise((r) => setTimeout(r, 3000));
    expect(await display(m, b)).toBe("block,block");
  });

  it("the extensions menu lists an agent extension only in the spaces where it runs", async () => {
    const w = await launch((root, dataDir) => (writeAgentExtension(root, "cacheur", HIDER), grant(dataDir, "cacheur", GRANT)));
    const m = w.marionette;
    await waitActive(m, "cacheur@agent.ressac", true);
    await openTab(m, `${server.url}/cache.html`);
    const listed = () =>
      waitUi(m, `
        if (!doc.querySelector('[data-testid="extensions-panel"]')) doc.querySelector('[data-testid="menu-extensions"]').click();
        const p = doc.querySelector('[data-testid="extensions-panel"]');
        return p ? p.textContent : null;`);
    expect(await listed()).toContain("Cacheur");
    await dispatch(m, { type: "createSpace", name: "B", icon: "🅱️", private: false, profile: "new", windowId: (await state(m)).windows[0]!.id } as Action);
    await openTab(m, `${server.url}/cache.html`);
    await waitUi(m, `return !doc.querySelector('[data-testid="extensions-panel"]')?.textContent.includes("Cacheur") || null`);
    expect(await listed()).not.toContain("Cacheur");
  });

  // extensions-interface.spec.ts:278
  it("the switch of an agent extension is greyed in a private space, with PRIVATE_PROFILE_ERROR", async () => {
    const w = await launch((root, dataDir) => {
      writeAgentExtension(root, "cacheur", HIDER);
      // A folder of the agent never granted is listed too, greyed the same.
      writeAgentExtension(root, "jamais-accordee", { "manifest.json": { manifest_version: 3, name: "Jamais", version: "1.0.0" } });
      grant(dataDir, "cacheur", GRANT, []);
    });
    const m = w.marionette;
    await setPrivate(m, true);
    const e = await activeSpace(m);
    await openSettings(m, e.id);
    for (const name of ["cacheur", "jamais-accordee"]) expect(await line(m, name)).toMatchObject({ disabled: true, text: expect.stringContaining(PRIVATE_PROFILE_ERROR) });
    // The kernel refuses too, without the switch.
    expect(await inUi(m, "return ui.ressac.extensions.toggle('agent:cacheur', arguments[0], true).then((r) => JSON.parse(JSON.stringify(r)))", [e.id])).toEqual({
      ok: false,
      error: PRIVATE_PROFILE_ERROR,
    });
  });

  // extensions-interface.spec.ts:303
  it("ticking « Espace privé » shows the warning and the extensions disabled; after Enregistrer, the agent's extension no longer runs", async () => {
    const w = await launch((root, dataDir) => (writeAgentExtension(root, "cacheur", HIDER), grant(dataDir, "cacheur", GRANT)));
    const m = w.marionette;
    await waitActive(m, "cacheur@agent.ressac", true);
    await until(() => registry(w.dataDir)["agent:cacheur"]?.addonId === "cacheur@agent.ressac");
    const personal = await activeSpace(m);
    await dispatch(m, { type: "createSpace", name: "Lecture", icon: "📚", private: false, profile: "default", windowId: (await state(m)).windows[0]!.id } as Action);
    await openSettings(m, personal.id);
    expect(await line(m, "Cacheur de l'agent")).toMatchObject({ checked: true, text: expect.stringContaining("Active aussi dans « Lecture » (même profil)") });
    const shown = (id: string) => inUi<string | null>(m, `return doc.querySelector('[data-testid="${id}"]')?.textContent ?? null`);
    expect(await shown("private-extensions-warning")).toBeNull();
    expect(await shown("extensions-disabled")).toBeNull();
    await inUi(m, `doc.querySelector(arguments[0] + ' input[type="checkbox"]:not([role])').click()`, [MODAL]);
    expect(await waitUi(m, `return doc.querySelector('[data-testid="private-extensions-warning"]')?.textContent`)).toContain(
      "Cet espace privé partage son profil avec « Lecture » : les extensions actives dans ce profil tournent aussi ici. Pour qu'elles n'y tournent jamais, donnez-lui son propre profil.",
    );
    expect(await shown("extensions-disabled")).toContain(
      "En enregistrant, ces extensions de l'agent seront désactivées pour ce profil : Cacheur de l'agent. Les onglets ouverts où elles tournent seront rechargés.",
    );
    await click(m, `${MODAL} button[type="submit"]`, { text: "Enregistrer" });
    await until(() => registry(w.dataDir)["agent:cacheur"]?.profiles.length === 0);
    await waitActive(m, "cacheur@agent.ressac", false);
  });

  // extensions-interface.spec.ts:327
  it("creating a private space on a shared profile disables the agent's extension of that profile", async () => {
    const w = await launch((root, dataDir) => (writeAgentExtension(root, "cacheur", HIDER), grant(dataDir, "cacheur", GRANT)));
    const m = w.marionette;
    await waitActive(m, "cacheur@agent.ressac", true);
    // Without the modal: the creerEspace action, as another window would send it.
    await dispatch(m, { type: "createSpace", name: "Secret", icon: "🔒", private: true, profile: "default", windowId: (await state(m)).windows[0]!.id } as Action);
    await waitActive(m, "cacheur@agent.ressac", false);
    await until(() => registry(w.dataDir)["agent:cacheur"]?.profiles.length === 0);
  });

  // extensions-agent.spec.ts:1552
  it("A7 the space turns private: the open tabs its scripts run in are reloaded, the script stops", async () => {
    const w = await launch((root, dataDir) => (writeAgentExtension(root, "tic", tic([HOST])), grant(dataDir, "tic", GRANT)));
    const m = w.marionette;
    await waitActive(m, "tic@agent.ressac", true);
    const a = await openTab(m, `${server.url}/a.html`);
    expect(await poll(() => ticks(m, a), (n) => n > 2)).toBeGreaterThan(2);
    await mark(m, a);
    await setPrivate(m, true);
    // Reloaded: the mark set before is gone, and the script no longer runs.
    expect(await reloaded(m, a)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(await inPage(m, a, "return document.documentElement.getAttribute('data-tic')")).toBeNull();
  });

  // extensions-agent.spec.ts:1576
  it("N1 disabled (broadened scope) then the space turns private: the tab its script ran in is reloaded", async () => {
    const w = await launch((root, dataDir) => (writeAgentExtension(root, "tic", tic([HOST])), grant(dataDir, "tic", GRANT)), { agent: true });
    const m = w.marionette;
    await waitActive(m, "tic@agent.ressac", true);
    const a = await openTab(m, `${server.url}/a.html`);
    expect(await poll(() => ticks(m, a), (n) => n > 2)).toBeGreaterThan(2);
    // One more site: disabled, without a reload.
    writeAgentExtension(w.root, "tic", tic([HOST, "https://exemple.com/*"]));
    expect((await w.call("reload_extension", { id: "tic" })).text).toContain("disabled");
    await waitActive(m, "tic@agent.ressac", false);
    await mark(m, a);
    await setPrivate(m, true);
    expect(await reloaded(m, a)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(await inPage(m, a, "return document.documentElement.getAttribute('data-tic')")).toBeNull();
  });

  // A profile turned private reloads every agent-script tab of a profile turned private, « même ceux d'une
  // extension déjà retirée sans rechargement »: here switched off in A, still active (and enabled) for B's profile.
  it("switched off in A, active in B's profile: A turns private, the tab its script still runs in is reloaded", async () => {
    const w = await launch((root, dataDir) => (writeAgentExtension(root, "tic", tic([HOST])), grant(dataDir, "tic", GRANT)));
    const m = w.marionette;
    await waitActive(m, "tic@agent.ressac", true);
    const spaceA = (await activeSpace(m)).id;
    const a = await openTab(m, `${server.url}/a.html`);
    expect(await poll(() => ticks(m, a), (n) => n > 2)).toBeGreaterThan(2);
    await dispatch(m, { type: "createSpace", name: "B", icon: "🅱️", private: false, profile: "new", windowId: (await state(m)).windows[0]!.id } as Action);
    const spaceB = (await activeSpace(m)).id;
    const toggle = (space: string, active: boolean) =>
      inUi(m, "return ui.ressac.extensions.toggle('agent:tic', arguments[0], arguments[1]).then((r) => JSON.parse(JSON.stringify(r)))", [space, active]);
    expect(await toggle(spaceB, true)).toEqual({ ok: true });
    expect(await toggle(spaceA, false)).toEqual({ ok: true });
    await waitActive(m, "tic@agent.ressac", true);
    const before = await ticks(m, a);
    expect(await poll(() => ticks(m, a), (n) => n > before)).toBeGreaterThan(before);
    await mark(m, a);
    await setSpacePrivate(m, spaceA);
    expect(await reloaded(m, a)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(await inPage(m, a, "return document.documentElement.getAttribute('data-tic')")).toBeNull();
  });

  it("the host down: a space turned private still reloads the tab an agent script runs in", async () => {
    const w = await launch((root, dataDir) => (writeAgentExtension(root, "tic", tic([HOST])), grant(dataDir, "tic", GRANT)));
    const m = w.marionette;
    await waitActive(m, "tic@agent.ressac", true);
    const a = await openTab(m, `${server.url}/a.html`);
    expect(await poll(() => ticks(m, a), (n) => n > 2)).toBeGreaterThan(2);
    process.kill((await hostPid(m))!, "SIGKILL");
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`, (v) => v === null);
    await mark(m, a);
    await setPrivate(m, true);
    expect(await reloaded(m, a)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(await inPage(m, a, "return document.documentElement.getAttribute('data-tic')")).toBeNull();
  });

  // extensions-agent.spec.ts:1433
  it("an agent card taken down before the answer (the space turns private): « Demande retirée avant la réponse de l'utilisateur. »", async () => {
    const w = await launch((root) => writeAgentExtension(root, "cacheur", HIDER), { agent: true });
    const m = w.marionette;
    const call = w.call("request_extension", { id: "cacheur" });
    await waitUi(m, `return doc.querySelector(${JSON.stringify(REQUEST)})?.textContent.includes("Cacheur de l'agent")`, [], 15_000);
    await setPrivate(m, true);
    expect((await call).text).toBe("Demande retirée avant la réponse de l'utilisateur.");
    await waitUi(m, `return !doc.querySelector(${JSON.stringify(REQUEST)})`);
    expect(await agentAddons(m)).toEqual([]);
  });
});
