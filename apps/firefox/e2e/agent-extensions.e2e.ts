import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeAgentExtension } from "./extensions/fixtures";
import { agentAddons, grant, inPage, launchWithAmo, openTab } from "./agent-extensions";
import { waitFor } from "./firefox";
import type { LaunchedWebAiOs } from "./launch";
import { callTool } from "./mcp";
import { startServer } from "./server";

// Agent extensions: grants are written to the registry before the launch, and the effects
// checked after a restart (the agent's tools and their card: agent-extensions-cards.e2e.ts).
const HOST = "http://127.0.0.1/*";
const manifest = (matches: string[]) => ({ manifest_version: 3, name: "Cacheur de l'agent", version: "1.0.0", content_scripts: [{ matches, css: ["cache.css"] }] });
const CACHE = "#cache-moi { display: none !important; }\n";
const CACHE_ALL = "#cache-moi, #reste { display: none !important; }\n";
const GRANT = { permissions: [], hosts: [HOST], network: [], allSites: false, allSitesScripts: false, scripts: true };
const ID = "cacheur@agent.webaios";

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => (server = await startServer()));
afterAll(() => server?.close());

const dirs: string[] = [];
const opened: LaunchedWebAiOs[] = [];
afterEach(async () => {
  for (const w of opened.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A data folder (the agent's ~/WebAiOs is its espace/) and a profile, kept across restarts. */
const folders = () => {
  const d = { dataDir: mkdtempSync(path.join(os.tmpdir(), "webaios-data-")), profile: mkdtempSync(path.join(os.tmpdir(), "webaios-firefox-")) };
  dirs.push(d.dataDir, d.profile);
  return d;
};
const root = (dataDir: string) => path.join(dataDir, "workspace");
const launch = async (o: Parameters<typeof launchWithAmo>[0]) => {
  const w = await launchWithAmo(o);
  opened.push(w);
  return w;
};
const registry = (dataDir: string) =>
  (JSON.parse(readFileSync(path.join(dataDir, "extensions", "state.json"), "utf8")) as { extensions: Record<string, unknown> }).extensions;
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
/** The first host answered extensions.pret: every granted extension is handled. */
const settle = (w: LaunchedWebAiOs) =>
  w.marionette.execute(`return (async () => { await (await ChromeUtils.importESModule("${STORE}").ready).agentExtensions.ready; })();`);
/** The agent's add-on installed, active, at `version` (a signing with the fake AMO takes a few seconds). */
const waitAddon = (w: LaunchedWebAiOs, version: string) =>
  waitFor(w.marionette, `return (async () => {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const a = await AddonManager.getAddonByID(${JSON.stringify(ID)});
    return a && a.isActive ? a.version : null;
  })();`, (v) => v === version, 30_000);
async function until(ok: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("agent extensions: registry, signed install, restart", () => {
  it("an agent extension laid in the folder is never loaded without a grant (restart included)", async () => {
    const f = folders();
    writeAgentExtension(root(f.dataDir), "cacheur", { "manifest.json": manifest([HOST]), "cache.css": CACHE });
    for (let i = 0; i < 2; i++) {
      const w = await launch(f);
      await settle(w);
      expect(await agentAddons(w.marionette)).toEqual([]);
      expect(w.amo.sends).toEqual([]);
      await w.close();
    }
    expect(existsSync(path.join(f.dataDir, "extensions", "copies", "cacheur"))).toBe(false);
  });

  it("a fake grant written in the agent folder activates nothing", async () => {
    const f = folders();
    writeAgentExtension(root(f.dataDir), "cacheur", { "manifest.json": manifest([HOST]), "cache.css": CACHE });
    // The registry as WebAiOs would write it, but in the agent's folder (and in the extension's own).
    grant(root(f.dataDir), "cacheur", GRANT);
    copyFileSync(path.join(root(f.dataDir), "extensions", "state.json"), path.join(root(f.dataDir), "extensions", "cacheur", "state.json"));
    const w = await launch(f);
    await settle(w);
    expect(await agentAddons(w.marionette)).toEqual([]);
    expect(w.amo.sends).toEqual([]);
    expect(existsSync(path.join(f.dataDir, "extensions", "copies", "cacheur"))).toBe(false);
  });

  it("granted: installed and active, version <agent version>.<counter>", async () => {
    const f = folders();
    writeAgentExtension(root(f.dataDir), "cacheur", { "manifest.json": manifest([HOST]), "cache.css": CACHE });
    grant(f.dataDir, "cacheur", GRANT);
    const w = await launch(f);
    await waitAddon(w, "1.0.0.1");
    expect(w.amo.sends.map((e) => [e.guid, e.version])).toEqual([[ID, "1.0.0.1"]]);
    // The registry is written once Firefox installed it: a moment after the add-on shows.
    await until(() => (registry(f.dataDir)["agent:cacheur"] as { addonId?: string }).addonId === ID);
    expect(registry(f.dataDir)["agent:cacheur"]).toMatchObject({ addonId: ID, grant: GRANT, disabled: null });
  });

  // The page half of extensions-agent.spec.ts:102: the page guard asks the background, which injects the CSS once the
  // extension actor answers estOnglet for this WebAiOs tab.
  it("granted: its content script hides #cache-moi", async () => {
    const f = folders();
    writeAgentExtension(root(f.dataDir), "cacheur", { "manifest.json": manifest([HOST]), "cache.css": CACHE });
    grant(f.dataDir, "cacheur", GRANT);
    const w = await launch(f);
    await waitAddon(w, "1.0.0.1");
    const tab = await openTab(w.marionette, `${server.url}/cache.html`);
    const display = "return [getComputedStyle(document.getElementById('cache-moi')).display, getComputedStyle(document.getElementById('reste')).display].join()";
    const deadline = Date.now() + 10_000;
    let seen = await inPage<string>(w.marionette, tab, display);
    while (seen !== "none,block" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      seen = await inPage<string>(w.marionette, tab, display);
    }
    expect(seen).toBe("none,block");
  });

  it("quit during a signature: the previous version runs after restart, the change is signed again", async () => {
    const f = folders();
    writeAgentExtension(root(f.dataDir), "cacheur", { "manifest.json": manifest([HOST]), "cache.css": CACHE });
    grant(f.dataDir, "cacheur", GRANT);
    let w = await launch(f);
    await waitAddon(w, "1.0.0.1");
    await w.close();
    // Written again by the next kernel: its own port and token.
    rmSync(path.join(root(f.dataDir), ".webaios", "mcp.json"));

    w = await launch({ ...f, amo: { delayMs: 60_000 } });
    await waitAddon(w, "1.0.0.1");
    writeAgentExtension(root(f.dataDir), "cacheur", { "cache.css": CACHE_ALL });
    await until(() => existsSync(path.join(root(f.dataDir), ".webaios", "mcp.json")));
    // Never answered: the app quits during the signature.
    callTool(f.dataDir, "reload_extension", { id: "cacheur" }).catch(() => {});
    const amo = w.amo;
    await until(() => amo.sends.some((e) => e.version === "1.0.0.2"));
    expect(await agentAddons(w.marionette)).toEqual([{ id: ID, version: "1.0.0.1", isActive: true }]);
    await w.close();
    expect(JSON.parse(readFileSync(path.join(f.dataDir, "extensions", "signed", "cacheur.json"), "utf8")).version).toBe("1.0.0.1");

    w = await launch(f);
    await waitAddon(w, "1.0.0.3");
    expect(w.amo.sends.map((e) => e.version)).toEqual(["1.0.0.3"]);
    expect(JSON.parse(readFileSync(path.join(f.dataDir, "extensions", "amo-versions.json"), "utf8"))).toEqual({ hider: 3 });
  });

  it("uninstalled from about:addons: gone from the registry", async () => {
    const f = folders();
    writeAgentExtension(root(f.dataDir), "cacheur", { "manifest.json": manifest([HOST]), "cache.css": CACHE });
    grant(f.dataDir, "cacheur", GRANT);
    const w = await launch(f);
    await waitAddon(w, "1.0.0.1");
    await w.marionette.execute(`return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      await (await AddonManager.getAddonByID(${JSON.stringify(ID)})).uninstall();
    })();`);
    await until(() => !("agent:cacheur" in registry(f.dataDir)));
    expect(await agentAddons(w.marionette)).toEqual([]);
  });

  // A removal landing while WebAiOs still installs the add-on (Firefox's onInstalled comes before install() resolves):
  // it is the user's, not WebAiOs's; the kernel must not install it back.
  it("uninstalled from about:addons during an install of ours: gone from the registry, not installed back", async () => {
    const f = folders();
    writeAgentExtension(root(f.dataDir), "cacheur", { "manifest.json": manifest([HOST]), "cache.css": CACHE });
    grant(f.dataDir, "cacheur", GRANT);
    const w = await launch(f);
    await waitAddon(w, "1.0.0.1");
    await w.marionette.execute(`return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      const l = { onInstalled(a) {
        if (a.id !== ${JSON.stringify(ID)} || a.version !== "1.0.0.2") return;
        AddonManager.removeAddonListener(l);
        void a.uninstall();
      } };
      AddonManager.addAddonListener(l);
    })();`);
    writeAgentExtension(root(f.dataDir), "cacheur", { "cache.css": CACHE_ALL });
    await until(() => existsSync(path.join(root(f.dataDir), ".webaios", "mcp.json")));
    await callTool(f.dataDir, "reload_extension", { id: "cacheur" }).catch(() => {});
    await until(() => !("agent:cacheur" in registry(f.dataDir)));
    await settle(w);
    expect(await agentAddons(w.marionette)).toEqual([]);
  });

  // about:addons' Remove button: a pending uninstall (Undo shown), only onUninstalling until the page unloads.
  it("removed with about:addons' Remove (pending uninstall): gone from the registry, not back after a restart", async () => {
    const f = folders();
    writeAgentExtension(root(f.dataDir), "cacheur", { "manifest.json": manifest([HOST]), "cache.css": CACHE });
    grant(f.dataDir, "cacheur", GRANT);
    let w = await launch(f);
    await waitAddon(w, "1.0.0.1");
    await w.marionette.execute(`return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      await (await AddonManager.getAddonByID(${JSON.stringify(ID)})).uninstall(true);
    })();`);
    // The kernel writes the registry after a round trip: under the full parallel suite it can take more than 15 s.
    await until(() => !("agent:cacheur" in registry(f.dataDir)), 30_000);
    expect(await agentAddons(w.marionette)).toEqual([]);
    await w.close();
    rmSync(path.join(root(f.dataDir), ".webaios", "mcp.json"));

    w = await launch(f);
    await settle(w);
    expect("agent:cacheur" in registry(f.dataDir)).toBe(false);
    expect(await agentAddons(w.marionette)).toEqual([]);
    expect(w.amo.sends).toEqual([]);
  });

  it("an inactive grant is never installed nor active", async () => {
    const f = folders();
    writeAgentExtension(root(f.dataDir), "cacheur", { "manifest.json": manifest([HOST]), "cache.css": CACHE });
    grant(f.dataDir, "cacheur", GRANT, []);
    const w = await launch(f);
    await settle(w);
    expect(w.amo.sends.map((e) => e.version)).toEqual(["1.0.0.1"]);
    expect(await agentAddons(w.marionette)).toEqual([]);
  });

  it("uninstalled from about:addons while the host is down: not reinstalled when it starts again", async () => {
    const f = folders();
    writeAgentExtension(root(f.dataDir), "cacheur", { "manifest.json": manifest([HOST]), "cache.css": CACHE });
    grant(f.dataDir, "cacheur", GRANT);
    const w = await launch(f);
    await waitAddon(w, "1.0.0.1");
    const pid = await w.marionette.execute<number>(`return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`);
    process.kill(pid, "SIGKILL");
    await waitFor(w.marionette, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).agent.pid)();`, (v) => v === null);
    await w.marionette.execute(`return (async () => {
      const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
      await (await AddonManager.getAddonByID(${JSON.stringify(ID)})).uninstall();
    })();`);
    expect("agent:cacheur" in registry(f.dataDir)).toBe(true);
    await w.marionette.execute(`return (async () => { await (await ChromeUtils.importESModule("${STORE}").ready).agent.ensure().catch(() => {}); })();`);
    await until(() => !("agent:cacheur" in registry(f.dataDir)));
    expect(await agentAddons(w.marionette)).toEqual([]);
  });
});
