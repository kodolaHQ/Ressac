import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserState } from "../shared/model";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { SHELL_SERVICE } from "../chrome/store/settings";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startD1Server, startServer } from "./server";
import { click, inUi, missingApi, pressKeys, waitUi } from "./ui";

// Plan 44 Task 6: the Settings page (agents, local AI, workshop, privacy, about).

const PAGE = '[data-testid="settings-page"]';
// Nothing listens there: the d1 download Ressac starts with AI fails at once, never the real 1.1 GB.
const DEAD = "http://127.0.0.1:9";
const STORE = "chrome://browser/content/ressac/store.sys.mjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const activeTab = (s: BrowserState) => s.tabs[s.windows[0]!.active[s.windows[0]!.activeSpace]!];

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

/** Launches with `files` written under the workspace (RESSAC_ROOT). Model downloads go to a dead address unless the test points them elsewhere. */
async function launch(env: Record<string, string> = {}, files: Record<string, string> = {}, dataDir?: string): Promise<void> {
  // The kernel's own decision-model address: an imposed one (RESSAC_KEV_URL) counts the model as installed.
  w = await launchRessac({ dataDir, env: { RESSAC_OLLAMA_URL: DEAD, RESSAC_KEV_URL: undefined, RESSAC_D1_URL: DEAD, RESSAC_EMBED_URL: DEAD, ...env } });
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

  it("Domaines autorisés: valid lines are saved, a bad line is listed and not saved", async () => {
    await launch();
    await openPage();
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="settings-agent-domains"]']);
    await inUi(
      m,
      `const t = doc.querySelector(arguments[0]); t.focus(); t.value = "exemple.com\\nbad domain"; t.dispatchEvent(new Event("input", { bubbles: true })); t.blur();`,
      ['[data-testid="settings-agent-domains"]'],
    );
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.settings.agentDomains)();`, (v) => JSON.stringify(v) === '["exemple.com"]');
    await shows("settings-agent-domains-ignored", "Ignoré : bad domain");
    // The workshop runs: the change re-applies the rules with the new list.
    const log = join(w!.dataDir, "workspace", "fake-docker-network.log");
    await waitFor(m, "return true", () => existsSync(log) && readFileSync(log, "utf8").split("\n").some((l) => l.includes('"exemple.com"')), 15_000);
    // Typed and never left (a click straight into the agent's terminal): saved anyway.
    await inUi(
      m,
      `const t = doc.querySelector(arguments[0]); t.focus(); t.value = "exemple.com\\nautre.org"; t.dispatchEvent(new Event("input", { bubbles: true }));`,
      ['[data-testid="settings-agent-domains"]'],
    );
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.settings.agentDomains)();`, (v) => JSON.stringify(v) === '["exemple.com","autre.org"]');
  });

  it("Zod never tries eval in the privileged bundles (Firefox reports it, Sentry 0.1.6)", async () => {
    await launch();
    await openPage();
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="settings-agent-domains"]']);
    const blocked = await m.execute<string[]>("return Services.console.getMessageArray().map((x) => x.message ?? x.errorMessage ?? String(x)).filter((t) => t.includes('eval()'));");
    expect(blocked).toEqual([]);
  });

  it("Domaines autorisés survive a restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ressac-domains-"));
    // After afterEach has closed the app.
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
    const relaunch = async () => {
      w = await launchRessac({ dataDir, env: { RESSAC_OLLAMA_URL: DEAD, RESSAC_KEV_URL: undefined, RESSAC_D1_URL: DEAD, RESSAC_EMBED_URL: DEAD } });
      m = w.marionette;
      await m.setContext("chrome");
      await waitReady(m);
    };
    await relaunch();
    await openPage();
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="settings-agent-domains"]']);
    await inUi(m, `const t = doc.querySelector(arguments[0]); t.focus(); t.value = "https://example.com/page"; t.dispatchEvent(new Event("input", { bubbles: true }));`, ['[data-testid="settings-agent-domains"]']);
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.settings.agentDomains)();`, (v) => JSON.stringify(v) === '["example.com"]');
    await w!.close();
    expect(JSON.parse(readFileSync(join(dataDir, "session.json"), "utf8")).settings.agentDomains).toEqual(["example.com"]);
    await relaunch();
    await waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.settings.agentDomains)();`, (v) => JSON.stringify(v) === '["example.com"]');
    // The page shows it again.
    await openPage();
    await waitUi(m, "return doc.querySelector(arguments[0])?.value === 'example.com'", ['[data-testid="settings-agent-domains"]']);
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

  describe("the workshop machine (fake)", () => {
    const calls = () => {
      const file = join(w!.dataDir, "workspace", "fake-machine-calls.log");
      return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
    };

    it("running: its state, memory and disk, restart and rebuild; « Supprimer la machine » asks, then removes", async () => {
      await launch({ RESSAC_TEST_MACHINE: "running" });
      await openPage();
      await go("workshop");
      await shows("machine-state", "Machine de l'atelier : démarrée");
      await shows("machine-usage", "0,6 Go de mémoire · 1,8 Go sur le disque");
      expect(await inUi(m, `return ["workshop-restart", "workshop-rebuild", "machine-remove"].every((id) => doc.querySelector('[data-testid="' + id + '"]'))`)).toBe(true);
      await click(m, '[data-testid="machine-remove"]');
      await shows("settings-workshop", "Les agents et les applis en cours s'arrêtent. Vos connexions Claude et Codex sont gardées. Elle ne sera téléchargée de nouveau (environ 500 Mo) que si vous cliquez sur « Installer la machine ».");
      expect(calls()).toEqual([]);
      await click(m, '[data-testid="confirm-machine"]');
      await waitFor(m, "return true", () => calls().includes("remove"), 10_000);
    });

    it("removed: still absent at the next launch (AI on installs nothing) until « Installer la machine », which downloads it", async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "ressac-data-"));
      onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
      await launch({ RESSAC_TEST_MACHINE: "running" }, {}, dataDir);
      await openPage();
      await go("workshop");
      await click(m, '[data-testid="machine-remove"]');
      await click(m, '[data-testid="confirm-machine"]');
      await shows("machine-state", "Machine de l'atelier : supprimée. Elle ne revient que si vous l'installez (environ 500 Mo).");
      await w!.close();
      w = undefined;
      await launch({ RESSAC_TEST_MACHINE: "running" }, {}, dataDir); // the next launch, AI on
      await openPage();
      await go("workshop");
      await shows("machine-state", "Machine de l'atelier : supprimée.");
      expect(calls()).toEqual(["remove"]);
      await click(m, '[data-testid="machine-install"]');
      await waitFor(m, "return true", () => calls().includes("install"), 10_000);
      await shows("machine-state", "Téléchargement de l'atelier…");
    });

    it("damaged: the message, « Réessayer », and « Supprimer quand même » behind the logins warning", async () => {
      await launch({ RESSAC_TEST_MACHINE: "error:damaged" });
      await openPage();
      await go("workshop");
      await shows("machine", "La machine de l'atelier est dans un état inattendu.");
      await click(m, '[data-testid="machine-retry"]');
      await waitFor(m, "return true", () => calls().includes("install"), 10_000);
      await click(m, '[data-testid="machine-force-remove"]');
      await shows("settings-workshop", "La machine ne démarre plus, ses connexions Claude et Codex ne peuvent pas être sauvées. La supprimer quand même ? Il faudra vous reconnecter.");
      expect(calls()).not.toContain("remove --force");
      await click(m, '[data-testid="confirm-machine"]');
      await waitFor(m, "return true", () => calls().includes("remove --force"), 10_000);
    });

    it("while « Réessayer » runs, the row's buttons are disabled; they come back once it answers", async () => {
      await launch({ RESSAC_TEST_MACHINE: "error:damaged", RESSAC_TEST_MACHINE_DELAY_MS: "3000" });
      await openPage();
      await go("workshop");
      await click(m, '[data-testid="machine-retry"]');
      await waitUi(m, `return ["machine-retry", "machine-force-remove"].every((id) => doc.querySelector('[data-testid="' + id + '"]').disabled)`);
      await waitFor(m, "return true", () => calls().includes("install"), 10_000);
      await waitUi(m, `return !doc.querySelector('[data-testid="machine-retry"]').disabled`, [], 10_000);
    });

    it("stopped: the disk only, no memory line", async () => {
      await launch({ RESSAC_TEST_MACHINE: "stopped" });
      await openPage();
      await go("workshop");
      await shows("machine-usage", "1,8 Go sur le disque");
      expect(await text("machine-usage")).not.toContain("mémoire");
    });

    it("unsupported, Docker stopped: today's Docker texts, no machine row", async () => {
      await launch({ RESSAC_TEST_MACHINE: "unsupported", FAKE_DOCKER_ABSENT: "1", RESSAC_TEST_DOCKER_KIND: "stopped" });
      await openPage();
      await go("workshop");
      await shows("docker-start", "Démarrer OrbStack");
      expect(await inUi(m, `return !!doc.querySelector('[data-testid="machine"]')`)).toBe(false);
    });
  });

  it("Rédaction: Claude when signed in, Codex with only Codex, none otherwise", async () => {
    for (const [files, wanted] of [
      [{ "fake-claude-auth.json": JSON.stringify({ loggedIn: true, email: "ami@example.com" }) }, "Claude Haiku, avec votre compte Claude Code"],
      [{ "fake-codex-auth": "" }, "Codex, avec votre compte ChatGPT"],
      [{}, "Aucun compte connecté"],
    ] as const) {
      await launch({}, files);
      await openPage();
      await go("ai");
      await shows("ai-writer", wanted);
      await w!.close();
      w = undefined;
    }
  });

  it("local AI: only Ressac's two models, no Ollama nor Gemma row; their failed downloads show", async () => {
    await launch();
    await openPage();
    await go("ai");
    await shows("ai-decision", "absent");
    await shows("ai-decision-error", "Téléchargement échoué");
    await shows("ai-search", "Modèle de recherche");
    await shows("ai-search", "absent");
    await shows("ai-search-error", "Téléchargement échoué");
    expect(await inUi(m, `return !!doc.querySelector('[data-testid="ai-ollama"], [data-testid="ai-gemma"]')`)).toBe(false);
    expect(await text("settings-ai")).not.toMatch(/Ollama|: Gemma|Plusieurs Go/);
  });

  it("local AI: the sort model then the search model download by themselves, show a percentage, then installed", async () => {
    const d1 = await startD1Server({ hold: true });
    try {
      await launch({ ...d1.env });
      await openPage();
      await go("ai");
      await shows("ai-decision", "Téléchargement 50 %");
      await shows("ai-search", "absent"); // queued behind d1
      d1.release();
      await shows("ai-decision", "installé");
      await shows("ai-search", "installé");
    } finally {
      await d1.close();
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

  it("language: switching to English retitles the page without reload, and back; Firefox's menus follow", async () => {
    await launch();
    await openPage();
    await go("privacy");
    const pick = (value: string) => inUi(m, `const s = doc.querySelector('[data-testid="settings-language"]'); s.value = arguments[0]; s.dispatchEvent(new Event("change", { bubbles: true }));`, [value]);
    const language = () => waitFor(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state.settings.language)();`, () => true);
    // Firefox's own menu bar, from Mozilla's translations packed in the build (scripts/locales.sh).
    const fileMenu = (label: string) => waitFor(m, `return document.getElementById("file-menu")?.label`, (v) => v === label);
    await fileMenu("Fichier");
    await pick("en");
    await shows("settings-nav-about", "About");
    await shows("settings-language-note", "The agent will speak English from its next session.");
    expect(await language()).toBe("en");
    await fileMenu("File");
    await pick("fr");
    await shows("settings-nav-about", "À propos");
    await shows("settings-language-note", "L'agent parlera français à sa prochaine session.");
    expect(await language()).toBe("fr");
    await fileMenu("Fichier");
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
    await launch({ RESSAC_TEST_NO_SYSTEM: "", RESSAC_TEST_MACHINE: "unsupported" }); // never the real machine
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
    // A local server takes whatever Sentry sends.
    const server = await startServer({ routes: {} });
    onTestFinished(() => server.close());
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
