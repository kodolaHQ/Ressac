import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserState } from "../shared/model";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { SHELL_SERVICE } from "../chrome/store/settings";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// Plan 44 Task 6: the Settings page (agents, local AI, workshop, privacy, about).

const PAGE = '[data-testid="settings-page"]';
const STORE = "chrome://browser/content/ressac/store.sys.mjs";
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

let w: LaunchedRessac | undefined;
let m: Marionette;
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
  }
});

/** Launches with `files` written under the workspace (RESSAC_ROOT). Ollama is unreachable unless the test points it elsewhere. */
async function launch(env: Record<string, string> = {}, files: Record<string, string> = {}): Promise<void> {
  // The kernel's own decision-model address: these tests read the decision model found in Ollama, which an imposed one hides.
  w = await launchRessac({ env: { RESSAC_OLLAMA_URL: "http://127.0.0.1:9", RESSAC_KEV_URL: undefined, ...env } });
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
const SECTIONS = ["agents", "ai", "workshop", "permissions", "data", "privacy", "shortcuts", "about"];
/** Shows one section of the page (Agents is the one it opens on). */
const go = async (id: string) => {
  await click(m, `[data-testid="settings-nav-${id}"]`);
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="settings-${id}"]`]);
};
const text = (id: string) => inUi<string>(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ') ?? ''", [`[data-testid="${id}"]`]);
const shows = (id: string, wanted: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [`[data-testid="${id}"]`, wanted], ms);
const settingsTabs = async () => Object.values((await state(m)).tabs).filter((t) => t.url === "ressac://settings");

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
    expect(await text("agent-claude")).not.toContain("tapez /login");
    await click(m, '[data-testid="agent-claude"] [data-testid="agent-logout"]');
    await shows("agent-claude", "Non connecté");
    await shows("agent-claude", "Claude Code vous demande de vous connecter dans le panneau de l'agent ; sinon, tapez /login.");
    expect(existsSync(join(w!.dataDir, "workspace", "fake-claude-auth.json"))).toBe(false);
    await click(m, '[data-testid="agent-claude"] [data-testid="agent-login"]');
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.windows[0].agentPanelOpen)();`, (v) => v === true);
  });

  it("no workshop yet: Se connecter opens the agent panel, which starts it, and the account is re-read", { timeout: 60_000 }, async () => {
    // The launch's own start fails (port taken): no container until the agent panel starts it again.
    await launch({ FAKE_DOCKER_NO_CONTAINER: "1", FAKE_DOCKER_RUN_FAILED: "1" });
    await openPage();
    await shows("agent-claude", "L'atelier de l'agent n'est pas démarré");
    await click(m, '[data-testid="agent-claude"] [data-testid="agent-login"]');
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.windows[0].agentPanelOpen)();`, (v) => v === true);
    await click(m, "button", { text: "Réessayer", frame: "agent" });
    await shows("agent-claude", "Non connecté", 30_000);
  });

  it("host stopped: agents and local AI say the agent does not answer", async () => {
    await launch();
    await m.execute(`return (async () => { await window.ressacWindow.store.agent.stop(); return true; })();`);
    await waitFor<number | null>(m, `return window.ressacWindow.store.agent.pid;`, (pid) => pid === null);
    await openPage();
    await shows("settings-agents", "L'agent ne répond pas.");
    await go("ai");
    await shows("ai-error", "L'agent ne répond pas");
    expect(await text("settings-ai")).not.toContain("undefined");
  });

  it("Docker absent: the agents point to the workshop, which offers OrbStack", async () => {
    await launch({ FAKE_DOCKER_ABSENT: "1" });
    await openPage();
    await shows("settings-agents", "voir Conteneur");
    await go("workshop");
    await shows("settings-workshop", "Installer OrbStack");
  });

  it("a slow Docker holds only its own sections", { timeout: 60_000 }, async () => {
    await launch({ FAKE_DOCKER_SLOW: "1" });
    const start = Date.now();
    await openPage();
    await go("about");
    await waitUi(m, `return !!doc.querySelector('[data-testid="app-version"]')?.textContent.trim()`, [], 2_000);
    await go("data");
    await waitUi(m, `return !!doc.querySelector('[data-testid="data-dir"]')?.textContent.trim()`, [], 2_000);
    expect(Date.now() - start).toBeLessThan(4_000);
    await go("agents");
    expect(await text("settings-agents")).toContain("Vérification…");
    await shows("settings-agents", "Non connecté", 40_000);
  });

  it("restart and rebuild the workshop", { timeout: 60_000 }, async () => {
    await launch();
    await openPage();
    await go("workshop");
    await shows("workshop-state", "Atelier démarré");
    const file = join(w!.dataDir, "workspace", "fake-docker-calls.log");
    const log = () => (existsSync(file) ? readFileSync(file, "utf8") : "");
    await click(m, '[data-testid="workshop-restart"]');
    await shows("settings-workshop", "Les agents et les applis en cours s'arrêtent, puis les agents se relancent.");
    await click(m, '[data-testid="confirm-workshop"]');
    await waitFor(m, "return true", () => log().includes("stop -t 2"), 20_000);
    await waitUi(m, `return !doc.querySelector('[data-testid="workshop-rebuild"]').disabled`, [], 20_000);
    await click(m, '[data-testid="workshop-rebuild"]');
    await shows("settings-workshop", "La reconstruction réinstalle Claude Code et Codex et prend quelques minutes. Les agents et les applis en cours s'arrêtent ; vos projets et les connexions de Claude et de Codex restent.");
    await click(m, '[data-testid="confirm-workshop"]');
    await waitFor(m, "return true", () => log().split("\n").some((l) => l.startsWith("build ") && l.includes("--no-cache")), 20_000);
    await shows("workshop-state", "Atelier démarré", 20_000);
  });

  it("workshop: a container app installed but stopped offers « Démarrer OrbStack »", async () => {
    await launch({ FAKE_DOCKER_ABSENT: "1", RESSAC_TEST_DOCKER_KIND: "stopped" });
    await openPage();
    await go("workshop");
    await shows("docker-start", "Démarrer OrbStack");
  });

  it("local AI: an absent Ollama offers its download, a stopped one « Démarrer », an old one « Mettre à jour Ollama »", async () => {
    for (const [kind, id, label] of [["absent", "pull-ollama", "Télécharger Ollama (190 Mo)"], ["stopped", "ollama-start", "Démarrer"], ["outdated", "ollama-update", "Mettre à jour Ollama"]] as const) {
      await launch({ RESSAC_TEST_OLLAMA_KIND: kind });
      await openPage();
      await go("ai");
      await shows(id, label);
      if (kind === "outdated") expect(await text("ai-ollama")).toContain("version 0.30.0, il faut la 0.40.0");
      await w!.close();
      w = undefined;
    }
  });

  it("local AI: Ollama reachable, Gemma installed, Kev unavailable", async () => {
    await launch({ RESSAC_OLLAMA_URL: server.url });
    await openPage();
    await go("ai");
    await shows("ai-ollama", "joignable");
    expect(await text("ai-ollama")).toContain(server.url);
    expect(await text("ai-ollama")).not.toContain("injoignable");
    await shows("ai-gemma", "installé");
    expect(await text("ai-gemma")).toContain("Gemma (gemma4:e4b-mlx)");
    expect(await inUi(m, `return doc.querySelector('[data-testid="ai-decision-model"] option[value="kev"]').disabled`)).toBe(true);
  });

  it("local AI: Download pulls the missing Gemma through Ollama, shows a percentage, then installed", async () => {
    let pulled = false;
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const ollama = await startServer({
      routes: {
        "/api/tags": (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ models: [{ name: "pplx-decider-flash:latest" }, ...(pulled ? [{ name: "gemma4:e4b-mlx" }] : [])] })),
        "/api/pull": (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/x-ndjson" });
          res.write('{"status":"pulling manifest"}\n{"status":"downloading","total":100,"completed":40}\n');
          void gate.then(() => {
            pulled = true;
            res.end('{"status":"success"}\n');
          });
        },
      },
    });
    try {
      await launch({ RESSAC_OLLAMA_URL: ollama.url });
      await openPage();
      await go("ai");
      await shows("ai-gemma", "absent");
      expect(await text("settings-ai")).toContain("Plusieurs Go : le téléchargement peut prendre un moment.");
      expect(await inUi(m, `return doc.querySelectorAll('[data-testid="pull-decision"]').length`)).toBe(0); // installed: no button
      await click(m, '[data-testid="pull-gemma"]');
      await shows("ai-gemma", "Téléchargement 40 %");
      if (process.env.RESSAC_SHOT) writeFileSync(process.env.RESSAC_SHOT, Buffer.from((await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value, "base64"));
      release();
      await shows("ai-gemma", "installé");
      expect(await text("ai-gemma")).not.toContain("Télécharger");
    } finally {
      release();
      await ollama.close();
    }
  });

  it("start on home: the switch follows the setting and changes it", async () => {
    await launch();
    await openPage();
    await go("privacy");
    // The test launcher turns it off (tests restart on the tab they left).
    expect(await inUi(m, `return doc.querySelector('[data-testid="settings-start-home"]').checked`)).toBe(false);
    await click(m, '[data-testid="settings-start-home"]');
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.settings.startOnHome)();`, (v) => v === true);
  });

  it("search engine: a known one at once; « Autre… » takes an https address with %s, refused otherwise", async () => {
    await launch();
    await openPage();
    await go("privacy");
    const engine = () => waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.settings)();`, () => true) as Promise<BrowserState["settings"]>;
    const pick = (value: string) => inUi(m, `const s = doc.querySelector('[data-testid="settings-engine"]'); s.value = arguments[0]; s.dispatchEvent(new Event("change", { bubbles: true }));`, [value]);
    await pick("duckduckgo");
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.settings.engine)();`, (v) => v === "duckduckgo");
    await pick("custom");
    await waitUi(m, `return doc.activeElement?.dataset.testid === "settings-engine-custom"`);
    expect((await engine()).engine).toBe("duckduckgo");
    // Some address characters have no key for the test keyboard: the value is set, Enter is a real key.
    const fill = (url: string) => inUi(m, `doc.querySelector('[data-testid="settings-engine-custom"]').value = arguments[0]`, [url]);
    await fill("http://x.com/?q=%s");
    await pressKeys(m, "Enter");
    await shows("settings-engine-error", "L'adresse doit commencer par https://");
    expect((await engine()).engine).toBe("duckduckgo");
    await fill("https://kagi.com/search?q=%s");
    await pressKeys(m, "Enter");
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.settings.engine)();`, (v) => v === "custom");
    expect(await engine()).toMatchObject({ engine: "custom", customEngine: "https://kagi.com/search?q=%s" });
    expect(await inUi(m, `return !doc.querySelector('[data-testid="settings-engine-error"]')`)).toBe(true);
  });

  it("default browser: the button asks, then the row says it is the default", async () => {
    await launch();
    await openPage();
    await go("privacy");
    await click(m, '[data-testid="default-browser-set"]');
    await shows("settings-default-browser", "Par défaut");
    expect(await inUi(m, `return !doc.querySelector('[data-testid="default-browser-set"]')`)).toBe(true);
  });

  it("default browser: without the test guard, the row shows what macOS says (read only)", async () => {
    await launch({ RESSAC_TEST_NO_SYSTEM: "" });
    const real = await m.execute<boolean>(`return ChromeUtils.importESModule(arguments[0]).ShellService.isDefaultBrowser(false)`, [SHELL_SERVICE]);
    await openPage();
    await go("privacy");
    await waitUi(m, `return !!doc.querySelector('[data-testid="default-browser-state"], [data-testid="default-browser-set"]')`);
    expect(await inUi(m, `return !!doc.querySelector('[data-testid="default-browser-state"]')`)).toBe(real);
  });

  it("privacy: no DSN, the switch is greyed; with one, turning it off clears the pref", async () => {
    await launch();
    await openPage();
    await go("privacy");
    await shows("settings-privacy", "Cette version n'envoie rien.");
    expect(await inUi(m, `return doc.querySelector('[data-testid="telemetry-switch"]').disabled`)).toBe(true);
    await w!.close();
    await launch({ RESSAC_SENTRY_DSN: `http://k@127.0.0.1:${server.port}/1` });
    await m.execute(`Services.prefs.setBoolPref("ressac.telemetry.enabled", true);`);
    await openPage();
    await go("privacy");
    await waitUi(m, `const s = doc.querySelector('[data-testid="telemetry-switch"]'); return s && !s.disabled && s.checked`);
    await click(m, '[data-testid="telemetry-switch"]');
    await waitFor(m, `return Services.prefs.getBoolPref("ressac.telemetry.enabled", true)`, (v) => v === false);
  });

  it("privacy: the navigation sidebar's side is saved", async () => {
    await launch();
    await openPage();
    await go("privacy");
    const radio = (side: string) => `[data-testid="settings-sidebar-${side}"]`;
    await shows("settings-privacy", "Barre de navigation");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).checked", [radio("left")])).toBe(true);
    await click(m, radio("right"));
    const saved = () => {
      try {
        return JSON.parse(readFileSync(join(w!.dataDir, "session.json"), "utf8")).settings?.sidebarSide;
      } catch {
        return undefined;
      }
    };
    await waitFor(m, "return true", () => saved() === "right", 15_000);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).checked", [radio("right")])).toBe(true);
  });

  it("about: the version, and the browser's advanced settings in the current space", async () => {
    await launch();
    await openPage();
    await go("about");
    await shows("app-version", JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    await click(m, '[data-testid="open-advanced"]');
    const s = await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state)();`, (s) => activeTab(s)?.url === "about:preferences");
    expect(activeTab(s)!.spaceId).toBe(s.windows[0]!.activeSpace);
  });

  it("the menu shows one section at a time, and the page comes back on the last one", async () => {
    await launch();
    await openPage();
    const shown = () => inUi<string[]>(m, "return arguments[0].filter((id) => doc.querySelector(`[data-testid=\"settings-${id}\"]`))", [SECTIONS]);
    expect(await shown()).toEqual(["agents"]);
    for (const id of SECTIONS) {
      await go(id);
      expect(await shown()).toEqual([id]);
      expect(await inUi(m, "return doc.querySelector(arguments[0]).getAttribute('aria-current')", [`[data-testid="settings-nav-${id}"]`])).toBe("page");
    }
    await go("privacy");
    await dispatch(m, { type: "openTab", windowId: (await state(m)).windows[0]!.id, url: "about:blank", activate: true });
    await waitUi(m, "return !doc.querySelector(arguments[0])", [PAGE]);
    await openPage();
    expect(await shown()).toEqual(["privacy"]);
  });
});
