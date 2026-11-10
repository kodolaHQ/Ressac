import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserState } from "../shared/model";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// Plan 44 Task 6: the Settings page (agents, local AI, workshop, privacy, about).

const PAGE = '[data-testid="settings-page"]';
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const activeTab = (s: BrowserState) => s.tabs[s.windows[0]!.active[s.windows[0]!.activeSpace]!];

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer({
    routes: {
      "/api/tags": (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ models: [{ name: "gemma4:e4b-mlx" }, { name: "pplx-decider-flash:latest" }] })),
    },
  });
});
afterAll(() => server?.close());

let w: LaunchedWebAiOs | undefined;
let m: Marionette;
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
  }
});

/** Launches with `files` written under the workspace (WEBAIOS_ROOT). Ollama is unreachable unless the test points it elsewhere. */
async function launch(env: Record<string, string> = {}, files: Record<string, string> = {}): Promise<void> {
  w = await launchWebAiOs({ env: { WEBAIOS_OLLAMA_URL: "http://127.0.0.1:9", ...env } });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(w.dataDir, "workspace"), { recursive: true });
    writeFileSync(join(w.dataDir, "workspace", name), text);
  }
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
}
const openPage = async () => {
  await click(m, '[data-testid="settings-button"]');
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [PAGE]);
};
const text = (id: string) => inUi<string>(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ') ?? ''", [`[data-testid="${id}"]`]);
const shows = (id: string, wanted: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [`[data-testid="${id}"]`, wanted], ms);
const settingsTabs = async () => Object.values((await state(m)).tabs).filter((t) => t.url === "webaios://settings");

describe("Settings page", () => {
  it("opens from the sidebar button; ⌘, then keeps a single tab", async () => {
    await launch();
    await openPage();
    expect(await settingsTabs()).toMatchObject([{ title: "Réglages" }]);
    expect(await inUi(m, `return doc.querySelector('[data-testid="settings-button"]').getAttribute("aria-pressed")`)).toBe("true");
    await pressKeys(m, "Meta+,");
    await sleep(500);
    expect(await settingsTabs()).toHaveLength(1);
  });

  it("Claude Code's account: signed in, sign out, sign in opens the agent panel", async () => {
    await launch({}, { "fake-claude-auth.json": JSON.stringify({ loggedIn: true, email: "ami@example.com" }) });
    await openPage();
    await shows("agent-claude", "Connecté (ami@example.com)");
    await click(m, '[data-testid="agent-logout"]');
    await shows("agent-claude", "Non connecté");
    expect(existsSync(join(w!.dataDir, "workspace", "fake-claude-auth.json"))).toBe(false);
    await click(m, '[data-testid="agent-login"]');
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.windows[0].agentPanelOpen)();`, (v) => v === true);
  });

  it("Docker absent: the agents point to the workshop, which offers OrbStack", async () => {
    await launch({ FAKE_DOCKER_ABSENT: "1" });
    await openPage();
    await shows("settings-agents", "voir Conteneur");
    await shows("settings-workshop", "Installer OrbStack");
  });

  it("a slow Docker holds only its own sections", { timeout: 60_000 }, async () => {
    await launch({ FAKE_DOCKER_SLOW: "1" });
    const start = Date.now();
    await openPage();
    await waitUi(m, `return !!doc.querySelector('[data-testid="app-version"]')?.textContent.trim() && !!doc.querySelector('[data-testid="data-dir"]')?.textContent.trim()`, [], 2_000);
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(await text("settings-agents")).toContain("Vérification…");
    await shows("settings-agents", "Non connecté", 40_000);
  });

  it("restart and rebuild the workshop", { timeout: 60_000 }, async () => {
    await launch();
    await openPage();
    await shows("workshop-state", "Atelier démarré");
    const file = join(w!.dataDir, "workspace", "fake-docker-calls.log");
    const log = () => (existsSync(file) ? readFileSync(file, "utf8") : "");
    await click(m, '[data-testid="workshop-restart"]');
    await shows("settings-workshop", "Les agents et les applis en cours s'arrêtent, puis les agents se relancent.");
    await click(m, '[data-testid="confirm-workshop"]');
    await waitFor(m, "return true", () => log().includes("stop -t 2"), 20_000);
    await waitUi(m, `return !doc.querySelector('[data-testid="workshop-rebuild"]').disabled`, [], 20_000);
    await click(m, '[data-testid="workshop-rebuild"]');
    await shows("settings-workshop", "La reconstruction réinstalle Claude Code et prend quelques minutes.");
    await click(m, '[data-testid="confirm-workshop"]');
    await waitFor(m, "return true", () => log().split("\n").some((l) => l.startsWith("build ") && l.includes("--no-cache")), 20_000);
    await shows("workshop-state", "Atelier démarré", 20_000);
  });

  it("local AI: Ollama reachable, Gemma installed, Kev unavailable", async () => {
    await launch({ WEBAIOS_OLLAMA_URL: server.url });
    await openPage();
    await shows("ai-ollama", `joignable (${server.url})`);
    expect(await text("ai-ollama")).not.toContain("injoignable");
    await shows("ai-gemma", "Gemma : installé");
    expect(await inUi(m, `return doc.querySelector('[data-testid="ai-decision-model"] option[value="kev"]').disabled`)).toBe(true);
  });

  it("privacy: no DSN, the switch is greyed; with one, turning it off clears the pref", async () => {
    await launch();
    await openPage();
    await shows("settings-privacy", "Cette version n'envoie rien.");
    expect(await inUi(m, `return doc.querySelector('[data-testid="telemetry-switch"]').disabled`)).toBe(true);
    await w!.close();
    await launch({ WEBAIOS_SENTRY_DSN: `http://k@127.0.0.1:${server.port}/1` });
    await m.execute(`Services.prefs.setBoolPref("webaios.telemetry.enabled", true);`);
    await openPage();
    await waitUi(m, `const s = doc.querySelector('[data-testid="telemetry-switch"]'); return s && !s.disabled && s.checked`);
    await click(m, '[data-testid="telemetry-switch"]');
    await waitFor(m, `return Services.prefs.getBoolPref("webaios.telemetry.enabled", true)`, (v) => v === false);
  });

  it("about: the version, and the browser's advanced settings in the current space", async () => {
    await launch();
    await openPage();
    await shows("app-version", await m.execute<string>("return Services.appinfo.version"));
    await click(m, '[data-testid="open-advanced"]');
    const s = await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state)();`, (s) => activeTab(s)?.url === "about:preferences");
    expect(activeTab(s)!.spaceId).toBe(s.windows[0]!.activeSpace);
  });
});
