import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { BrowserState } from "../shared/model";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import { startModelServer, startServer } from "./server";
import { listen } from "./actions";
import { inPage, openTab } from "./actors";
import type { Marionette } from "./marionette";
import { click, inUi, keyDown, keyUp, missingApi, pressKeys, waitUi } from "./ui";

// Plan 47 Task 2: the first-launch welcome (page 4 chooses Navigateur or IA, Navigateur skips the agent and search pages)
// and « Revoir l'accueil » in Settings. Plan 68: the AI setup alone (Docker and local AI pages).

// Any https page the test opens fails on a dead proxy: no real web.
const NO_WEB = { "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": 1, "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": 1 };
const LAYER = '[data-testid="welcome-layer"]';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let w: LaunchedRessac | undefined;
let m: Marionette;
const dirs: string[] = [];
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  }
});

/** A launch that shows the welcome (unless `welcome` is false: the tests' default, which skips it). Model downloads go to a dead address. */
async function launch(o: { welcome?: boolean; env?: Record<string, string>; dataDir?: string; firstTimeNotes?: boolean; ai?: boolean } = {}): Promise<void> {
  const env = { RESSAC_OLLAMA_URL: "http://127.0.0.1:9", RESSAC_EMBED_URL: "http://127.0.0.1:9", ...(o.welcome === false ? {} : { RESSAC_SKIP_WELCOME: "0" }), ...o.env };
  w = await launchRessac({ env, prefs: NO_WEB, dataDir: o.dataDir, firstTimeNotes: o.firstTimeNotes, ai: o.ai });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
}
const shown = (id: string) => waitUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="${id}"]`]);
const shows = (id: string, wanted: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [`[data-testid="${id}"]`, wanted], ms);
/** Clicks a control of the page shown, once it is there. */
const press = async (id: string) => click(m, `${LAYER} [data-testid="${id}"]`);
/** From page `from` to page `to` of `pages`, by each page's main button (page 4 chooses IA first). */
async function forward(from: number, to: number, pages = [1, 2, 3, 8, 9, 4, 5, 6, 7]): Promise<void> {
  for (const p of pages.slice(pages.indexOf(from), pages.indexOf(to))) {
    await shown(`welcome-${p}`);
    if (p === 4) await press("welcome-tier-ai");
    await press("welcome-next");
  }
  await shown(`welcome-${to}`);
}
const dockerCalls = () => {
  const file = join(w!.dataDir, "workspace", "fake-docker-all.log");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
};
const fill = (id: string, value: string) =>
  inUi(m, "const f = doc.querySelector(arguments[0]); f.value = arguments[1]; f.dispatchEvent(new ui.Event('input', { bubbles: true }));", [`[data-testid="${id}"]`, value]);
const session = (): Partial<BrowserState> => {
  try {
    return JSON.parse(readFileSync(join(w!.dataDir, "session.json"), "utf8"));
  } catch {
    return {};
  }
};
const saved = (ok: (s: Partial<BrowserState>) => boolean) => waitFor(m, "return true", () => ok(session()), 15_000);
const activeSpace = (s: BrowserState) => s.spaces.find((e) => e.id === s.windows[0]!.activeSpace)!;
const layerGone = () => waitUi(m, "return !doc.querySelector(arguments[0])", [LAYER]);

describe("welcome", () => {
  it("fresh start shows the welcome", async () => {
    await launch();
    await shown("welcome-1");
    expect(await inUi(m, `return !!doc.querySelector('[data-testid="sidebar"]').closest('[inert]')`)).toBe(true);
    await shows("welcome-1", "Un navigateur calme, avec un agent quand vous le voulez.");
    await press("welcome-next");
    // No other browser in the test home: no « Plus tard », only « Continuer ».
    await shows("welcome-2", "Vous venez d'un autre navigateur ?");
    await shows("import-none", "Aucun autre navigateur trouvé sur ce Mac.");
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [`${LAYER} [data-testid="welcome-later"]`])).toBe(false);
    await press("welcome-next");
    await shows("welcome-3", "Vos onglets vivent à gauche");
    await press("welcome-next");
    await shows("welcome-8", "Quel moteur de recherche ?");
    await press("welcome-next");
    await shows("welcome-9", "Claire ou sombre ?");
    await press("welcome-next");
    await shows("welcome-4", "Comment voulez-vous utiliser Ressac ?");
    // « Retour » goes back a page.
    await press("welcome-back");
    await shown("welcome-9");
  });

  it("no docker, models missing, still through", async () => {
    await launch({ env: { FAKE_DOCKER_ABSENT: "1" } });
    await forward(1, 5);
    await shows("welcome-docker", "OrbStack n'est pas lancé ou pas installé.");
    // An install link opens its page and the welcome steps aside; the pill brings it back on the same step.
    await press("welcome-install-docker");
    await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready).state)();`, (s) =>
      Object.values(s.tabs).some((t) => t.url === "https://orbstack.dev/download"),
    );
    await layerGone();
    expect(await inUi(m, `return !!doc.querySelector('[data-testid="sidebar"]').closest('[inert]')`)).toBe(false);
    await click(m, '[data-testid="welcome-resume"]');
    await shows("welcome-docker", "OrbStack n'est pas lancé ou pas installé.");
    // The pill leaves with a fade.
    await waitUi(m, `return !doc.querySelector('[data-testid="welcome-resume"]')`);

    // While it shows, the window's shortcuts do nothing: ⌘T, ⌃Tab.
    const before = await state(m);
    await dispatch(m, { type: "openTab", windowId: before.windows[0]!.id, url: "about:blank", activate: false });
    await pressKeys(m, "Meta+t");
    await keyDown(m, "Control");
    await pressKeys(m, "Tab");
    await sleep(300);
    expect(await inUi(m, `return !!doc.querySelector('[data-testid="tabs-panel"], [data-testid="command-bar"]')`)).toBe(false);
    await keyUp(m, "Control");
    await sleep(300);
    const after = await state(m);
    expect(after.windows[0]!.active[after.windows[0]!.activeSpace]).toBe(before.windows[0]!.active[before.windows[0]!.activeSpace]);
    await shown("welcome-5");

    await press("welcome-later");
    // The background downloads failed at once (a dead address): the models are offered.
    await shows("welcome-models", "Le modèle de recherche et votre agent ne sont pas encore téléchargés.");
    await shown("welcome-pull");
    await press("welcome-later");
    await shown("welcome-7");
    await press("welcome-finish");
    await layerGone();
    expect(await inUi(m, `return !!doc.querySelector('[data-testid="sidebar"]').closest('[inert]')`)).toBe(false);
    await saved((s) => s.settings?.onboarded === true);
    // Finished: the shortcuts work again.
    await pressKeys(m, "Meta+t");
    await shown("command-bar");
  });

  it("the models' background download, started by « Oui », shows as under way; the welcome goes on", async () => {
    const model = await startModelServer({ hold: true });
    try {
      await launch({ env: model.env });
      await forward(1, 6);
      await waitFor(m, "return true", () => model.hits() > 0, 15_000);
      await shows("welcome-models", "Téléchargement en cours.");
      expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [`${LAYER} [data-testid="welcome-pull"]`])).toBe(false);
      await press("welcome-next");
      await shown("welcome-7");
      model.release();
      // The search model is the only download: nothing from Ollama, nothing else.
      await waitFor(m, "return true", () => model.hits() === 1, 15_000);
    } finally {
      await model.close();
    }
  });

  it("the workshop machine downloading: the agent and AI steps show its progress", async () => {
    await launch({ env: { RESSAC_TEST_MACHINE: "downloading:40" } });
    await forward(1, 5);
    await shows("welcome-machine", "Préparation de l'atelier… 40 %");
    await press("welcome-next");
    await shown("welcome-6");
    await shows("welcome-machine", "Préparation de l'atelier… 40 %");
    await shown("welcome-models");
  });

  it("a search server imposed by address counts its model as installed: the welcome says the models are in place", async () => {
    await launch({ env: { FAKE_DOCKER_ABSENT: "1", RESSAC_EMBED_SERVER_URL: "http://127.0.0.1:9" } });
    await forward(1, 5);
    await press("welcome-later");
    await shows("welcome-models", "Le modèle est installé.");
  });

  it("a container app installed but stopped: the welcome offers to start it", async () => {
    await launch({ env: { RESSAC_TEST_DOCKER_KIND: "stopped", FAKE_DOCKER_ABSENT: "1" } });
    await forward(1, 5);
    await shows("welcome-docker", "OrbStack est installé mais arrêté.");
    await shows("welcome-start-docker", "Démarrer OrbStack");
  });

  it("a silent host: neither state can be checked", async () => {
    await launch({ welcome: false });
    await m.execute(`return (async () => { await window.ressacWindow.store.agent.stop(); return true; })();`);
    await waitFor<number | null>(m, `return window.ressacWindow.store.agent.pid;`, (pid) => pid === null);
    // The AI setup alone (AI already on, so the host stays stopped): the Docker and local AI pages.
    await dispatch(m, { type: "enableAi" });
    await shown("welcome-5");
    await shows("welcome-docker", "Impossible de vérifier pour l'instant.");
    await shown("welcome-recheck");
    await press("welcome-next");
    await shows("welcome-models", "Impossible de vérifier pour l'instant.");
  });

  it("agent choice", async () => {
    await launch();
    await forward(1, 5);
    expect(await inUi(m, `return doc.querySelector('[data-testid="welcome-agent-claude"]').checked`)).toBe(true);
    await press("welcome-agent-codex");
    await saved((s) => s.settings?.agentProfile === "codex");
  });

  it("first space", async () => {
    await launch();
    await forward(1, 7);
    expect(await inUi(m, `return doc.querySelector('[data-testid="welcome-space-name"]').value`)).toBe("Perso");
    await fill("welcome-space-name", "Travail");
    await press("welcome-aura-lagon");
    await press("welcome-finish");
    await layerGone();
    const s = await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready).state)();`, (s) => s.settings.onboarded);
    expect(s.spaces).toHaveLength(1);
    expect(activeSpace(s)).toMatchObject({ name: "Travail", aura: "lagon", icon: "🏠", private: false });
    await w!.close();

    // An emptied name keeps the space's own.
    await launch();
    await forward(1, 7);
    await fill("welcome-space-name", "  ");
    await press("welcome-finish");
    await layerGone();
    const t = await state(m);
    expect(t.spaces).toHaveLength(1);
    expect(activeSpace(t)).toMatchObject({ name: "Perso", aura: "aube" });
  });

  it("the last page opens macOS's notification settings and stays", async () => {
    const dir = await mkdtemp(join(os.tmpdir(), "ressac-welcome-"));
    dirs.push(dir);
    const opened = join(dir, "opened.txt");
    await launch({ env: { RESSAC_TEST_REVEAL: opened } });
    await forward(1, 7);
    await press("welcome-notifications");
    const read = () => (existsSync(opened) ? readFileSync(opened, "utf8") : "");
    await waitFor(m, "return true", () => read().length > 0);
    expect(read()).toBe("x-apple.systempreferences:com.apple.Notifications-Settings.extension\n");
    await shown("welcome-7");
  });

  it("relaunch after finishing", async () => {
    const dataDir = await mkdtemp(join(os.tmpdir(), "ressac-welcome-"));
    dirs.push(dataDir);
    await launch({ dataDir });
    await forward(1, 7);
    await press("welcome-finish");
    await layerGone();
    await saved((s) => s.settings?.onboarded === true);
    await w!.close();
    await launch({ dataDir });
    await sleep(1_000);
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [LAYER])).toBe(false);
    expect(existsSync(join(dataDir, "session.json"))).toBe(true);
  });

  it("replay from settings", async () => {
    await launch({ welcome: false });
    await click(m, '[data-testid="settings-button"]');
    await click(m, '[data-testid="settings-nav-about"]');
    await click(m, '[data-testid="settings-replay-welcome"]');
    await shown("welcome-1");
    // AI already on: no question, no Docker or local AI page.
    await forward(1, 7, [1, 2, 3, 8, 9, 7]);
    await fill("welcome-space-name", "Maison");
    await press("welcome-finish");
    await layerGone();
    const s = await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/ressac/store.sys.mjs").ready).state)();`, (s) => s.settings.onboarded);
    expect(s.spaces).toHaveLength(1);
    expect(activeSpace(s).name).toBe("Maison");
    // Finished on the last page: a second replay starts at the beginning again.
    await click(m, '[data-testid="settings-replay-welcome"]');
    await shown("welcome-1");
  });

  it("first launch, whole journey", async () => {
    await launch({ firstTimeNotes: true });
    await forward(1, 7);
    await press("welcome-finish");
    await layerGone();
    // The agent panel stays closed: the tip shows.
    await shown("tip-card");
    // The user opens the panel: its note takes the keyboard, the tip waits for it.
    await click(m, '[data-testid="agent-button"]');
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="first-time-agent"]'], 10_000, "agent");
    await waitUi(m, "return document.activeElement?.id === 'ressac-agent' && doc.activeElement?.dataset.testid === 'first-time-ok'", [], 10_000, "agent");
    await waitUi(m, `return !doc.querySelector('[data-testid="tip-card"]')`);
    await click(m, '[data-testid="first-time-ok"]', { frame: "agent" });
    await waitUi(m, "return !doc.querySelector(arguments[0])", ['[data-testid="first-time-agent"]'], 10_000, "agent");
    // The tip takes its turn.
    await shown("tip-card");
  });

  it("later skips the AI pages, and nothing reaches Docker or Ollama", async () => {
    const ollama = await listen((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end('{"models":[]}'));
    try {
      await launch({ env: { RESSAC_OLLAMA_URL: ollama.url } });
      await forward(1, 4);
      await press("welcome-tier-browser");
      await press("welcome-next");
      await shown("welcome-7");
      // « Retour » after Navigateur comes back to the choice, still made.
      await press("welcome-back");
      await shown("welcome-4");
      expect(await inUi(m, "return doc.querySelector(arguments[0]).checked", [`${LAYER} [data-testid="welcome-tier-browser"]`])).toBe(true);
      await press("welcome-next");
      await shown("welcome-7");
      await press("welcome-finish");
      await layerGone();
      await saved((s) => s.settings?.onboarded === true && s.settings.aiEnabled === false);
      await sleep(2_000);
      expect(dockerCalls()).toEqual([]);
      expect(ollama.log).toEqual([]);
    } finally {
      await ollama.close();
    }
  });

  it("search engine: DuckDuckGo by default, another one picked is saved at the end", async () => {
    await launch();
    await forward(1, 8);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).checked", [`${LAYER} [data-testid="welcome-engine-duckduckgo"]`])).toBe(true);
    await press("welcome-engine-qwant");
    // Kept through « Retour » and back.
    await press("welcome-back");
    await press("welcome-next");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).checked", [`${LAYER} [data-testid="welcome-engine-qwant"]`])).toBe(true);
    await forward(8, 7);
    await press("welcome-finish");
    await layerGone();
    await saved((s) => s.settings?.onboarded === true && s.settings.engine === "qwant");
  });

  it("appearance: like the Mac by default, light or dark shows at once, web pages included", async () => {
    await launch();
    await forward(1, 9);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).checked", [`${LAYER} [data-testid="welcome-appearance-system"]`])).toBe(true);
    for (const [appearance, dark] of [["dark", true], ["light", false]] as const) {
      await press(`welcome-appearance-${appearance}`);
      await waitUi(m, "return matchMedia('(prefers-color-scheme: dark)').matches === arguments[0]", [dark]);
      await waitFor(m, "return window.matchMedia('(prefers-color-scheme: dark)').matches", (v) => v === dark);
    }
    await press("welcome-appearance-dark");
    await forward(9, 7);
    await press("welcome-finish");
    await layerGone();
    await saved((s) => s.settings?.appearance === "dark");
    // A web page follows it too.
    const page = await startServer({ routes: { "/": (_q, res) => res.end("<!doctype html><title>t</title>") } });
    try {
      const tab = await openTab(m, page.url + "/");
      expect(await inPage(m, tab, "return matchMedia('(prefers-color-scheme: dark)').matches")).toBe(true);
    } finally {
      await page.close();
    }
  });

  it("yes shows Docker then local AI, and saves AI on", async () => {
    await launch();
    await forward(1, 4);
    await press("welcome-tier-ai");
    await press("welcome-next");
    await shown("welcome-docker");
    await press("welcome-next");
    await shown("welcome-models");
    await press("welcome-next");
    await shown("welcome-7");
    await press("welcome-finish");
    await layerGone();
    await saved((s) => s.settings?.onboarded === true && s.settings.aiEnabled === true && s.settings.engine === "duckduckgo");
  });

  it("yes, back, then later saves AI off", async () => {
    await launch();
    await forward(1, 5);
    await press("welcome-back");
    await shown("welcome-4");
    await press("welcome-tier-browser");
    await press("welcome-next");
    await shown("welcome-7");
    await press("welcome-finish");
    await layerGone();
    await saved((s) => s.settings?.onboarded === true && s.settings.aiEnabled === false);
  });

  it("a first welcome left after yes asks again at the next launch", async () => {
    const dataDir = await mkdtemp(join(os.tmpdir(), "ressac-welcome-"));
    dirs.push(dataDir);
    await launch({ dataDir });
    await forward(1, 5);
    await saved((s) => s.settings?.aiEnabled === true && s.settings.onboarded === false);
    await w!.close();
    await launch({ dataDir });
    await forward(1, 4);
    await shown("welcome-tier-ai");
  });

  it("replay with AI on keeps it on", async () => {
    await launch({ welcome: false });
    await click(m, '[data-testid="settings-button"]');
    await click(m, '[data-testid="settings-nav-about"]');
    await click(m, '[data-testid="settings-replay-welcome"]');
    await forward(1, 7, [1, 2, 3, 8, 9, 7]);
    await press("welcome-finish");
    await layerGone();
    await saved((s) => s.settings?.onboarded === true && s.settings.aiEnabled === true);
  });

  it("AI setup alone: the Docker and local AI pages, then the browser", async () => {
    await launch({ welcome: false, ai: false });
    await shown("empty-page");
    await dispatch(m, { type: "enableAi" });
    await shown("welcome-docker");
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [`${LAYER} [data-testid="welcome-back"]`])).toBe(false);
    await press("welcome-next");
    await shown("welcome-models");
    await shows("welcome-next", "Terminer");
    await press("welcome-next");
    await layerGone();
    const s = await state(m);
    expect([s.aiSetup, s.settings.aiEnabled]).toEqual([false, true]);
    expect(await inUi(m, `return !!doc.querySelector('[data-testid="sidebar"]').closest('[inert]')`)).toBe(false);
  });

  it("page 4 propose Navigateur ou IA, jamais le labo", async () => {
    await launch();
    await forward(1, 4);
    await shows("welcome-tier-browser-card", "Un navigateur calme, sans IA.");
    await shows("welcome-tier-ai-card", "Il lui faut un compte Claude ou ChatGPT.");
    await shows("welcome-tier-later", "le labo, s'activent là aussi");
    // « labo » only in the note that says where it is turned on.
    const elsewhere = `const s = doc.querySelector(arguments[0]).cloneNode(true); s.querySelector('[data-testid="welcome-tier-later"]').remove(); return /labo/i.test(s.textContent);`;
    expect(await inUi(m, elsewhere, [`${LAYER} [data-testid="welcome-4"]`])).toBe(false);
    // A first launch preselects nothing: « Continuer » waits for a choice.
    const disabled = () => inUi(m, "return doc.querySelector(arguments[0]).disabled", [`${LAYER} [data-testid="welcome-next"]`]);
    expect(await inUi(m, "return [...doc.querySelectorAll('[name=welcome-tier]')].some((r) => r.checked)")).toBe(false);
    expect(await disabled()).toBe(true);
    // The disabled button cannot take the keyboard: the first card does.
    await waitUi(m, "return doc.activeElement?.dataset.testid === 'welcome-tier-browser'");
    expect(await inUi(m, "const r = doc.querySelector(arguments[0]); return [r.labels[0] && doc.getElementById(r.getAttribute('aria-labelledby')).textContent, doc.getElementById(r.getAttribute('aria-describedby')).textContent.startsWith('Un navigateur calme')]", [`${LAYER} [data-testid="welcome-tier-browser"]`])).toEqual(["Navigateur", true]);
    await press("welcome-tier-ai");
    await waitUi(m, "return !doc.querySelector(arguments[0]).disabled", [`${LAYER} [data-testid="welcome-next"]`]);
  });

  it("Navigateur saute les pages de l'IA", async () => {
    await launch();
    await forward(1, 4);
    await press("welcome-tier-browser");
    await press("welcome-next");
    await shown("welcome-7");
    await press("welcome-finish");
    await layerGone();
    await saved((s) => s.settings?.onboarded === true && s.settings.aiEnabled === false && s.settings.lab === false);
  });

  it("IA mène à l'agent puis à la recherche", async () => {
    // The CLIs' downloads go to a local server (dev overrides of agent-cli.ts): its log tells which one was asked for.
    const cli = await startServer({ routes: { "/claude.tgz": (_q, res) => res.writeHead(404).end(), "/codex.tgz": (_q, res) => res.writeHead(404).end() } });
    const sha = "0".repeat(64);
    try {
      await launch({ env: { RESSAC_TEST_CLI_PRESENT: "0", RESSAC_CLI_CLAUDE_URL: `${cli.url}/claude.tgz`, RESSAC_CLI_CLAUDE_SHA256: sha, RESSAC_CLI_CODEX_URL: `${cli.url}/codex.tgz`, RESSAC_CLI_CODEX_SHA256: sha } });
      await forward(1, 4);
      await shows("welcome-tier-ai-card", "votre agent (environ 170 Mo)");
      await press("welcome-tier-ai");
      await press("welcome-next");
      await shown("welcome-5");
      await press("welcome-agent-codex");
      await saved((s) => s.settings?.agentProfile === "codex");
      await press("welcome-next");
      // Page 6 starts the chosen agent's CLI as it shows, Codex here.
      await shows("welcome-6", "EmbeddingGemma");
      await waitFor(m, "return true", () => cli.paths.includes("/codex.tgz"), 15_000);
      expect(await inUi(m, "return /\\bd1\\b/.test(doc.querySelector(arguments[0]).textContent)", [`${LAYER} [data-testid="welcome-6"]`])).toBe(false);
      // The background search download failed at once (a dead address): the button is offered.
      await shown("welcome-pull");
      await press("welcome-pull");
    } finally {
      await cli.close();
    }
  });

  it("default launch skips it", async () => {
    await launch({ welcome: false });
    await shown("empty-page");
    await sleep(500);
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [LAYER])).toBe(false);
  });
});
