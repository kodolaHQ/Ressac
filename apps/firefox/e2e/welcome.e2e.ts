import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { BrowserState } from "../shared/model";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import { startServer } from "./server";
import type { Marionette } from "./marionette";
import { click, inUi, keyDown, keyUp, missingApi, pressKeys, waitUi } from "./ui";

// Plan 47 Task 2: the first-launch welcome (six pages since plan 55 on the aura) and « Revoir l'accueil » in Settings.

// Any https page the test opens fails on a dead proxy: no real web.
const NO_WEB = { "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": 1, "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": 1 };
const LAYER = '[data-testid="welcome-layer"]';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let w: LaunchedWebAiOs | undefined;
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

/** A launch that shows the welcome (unless `welcome` is false: the tests' default, which skips it). Ollama unreachable. */
async function launch(o: { welcome?: boolean; env?: Record<string, string>; dataDir?: string; firstTimeNotes?: boolean } = {}): Promise<void> {
  const env = { WEBAIOS_OLLAMA_URL: "http://127.0.0.1:9", ...(o.welcome === false ? {} : { WEBAIOS_SKIP_WELCOME: "0" }), ...o.env };
  w = await launchWebAiOs({ env, prefs: NO_WEB, dataDir: o.dataDir, firstTimeNotes: o.firstTimeNotes });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
}
const shown = (id: string) => waitUi(m, "return !!doc.querySelector(arguments[0])", [`[data-testid="${id}"]`]);
const shows = (id: string, wanted: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [`[data-testid="${id}"]`, wanted], ms);
/** Clicks a control of the page shown, once it is there. */
const press = async (id: string) => click(m, `${LAYER} [data-testid="${id}"]`);
/** From page `from` to page `to`, by « Suivant » / « Continuer ». */
async function forward(from: number, to: number): Promise<void> {
  for (let p = from; p < to; p++) {
    await shown(`welcome-${p}`);
    await press("welcome-next");
  }
  await shown(`welcome-${to}`);
}
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
    await shows("welcome-4", "Brancher un agent");
    // « Retour » goes back a page.
    await press("welcome-back");
    await shown("welcome-3");
  });

  it("no docker, no ollama, still through", async () => {
    await launch({ env: { FAKE_DOCKER_ABSENT: "1" } });
    await forward(1, 4);
    await shows("welcome-docker", "OrbStack n'est pas lancé ou pas installé.");
    // An install link opens its page and the welcome steps aside; the pill brings it back on the same step.
    await press("welcome-install-docker");
    await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready).state)();`, (s) =>
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
    await shown("welcome-4");

    await press("welcome-later");
    await shows("welcome-ollama", "Ollama n'est pas installé ou pas lancé.");
    await shown("welcome-install-ollama");
    await press("welcome-later");
    await shown("welcome-6");
    await press("welcome-finish");
    await layerGone();
    expect(await inUi(m, `return !!doc.querySelector('[data-testid="sidebar"]').closest('[inert]')`)).toBe(false);
    await saved((s) => s.settings?.onboarded === true);
    // Finished: the shortcuts work again.
    await pressKeys(m, "Meta+t");
    await shown("command-bar");
  });

  it("ollama without its models: « Télécharger en arrière-plan » pulls both, the welcome goes on, a notification says the end", async () => {
    const pulled: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const ollama = await startServer({
      routes: {
        "/api/tags": (_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ models: pulled.map((name) => ({ name })) })),
        "/api/pull": (req, res) => {
          let body = "";
          req.on("data", (d) => (body += d)).on("end", () => {
            const name = JSON.parse(body).model as string;
            res.writeHead(200, { "Content-Type": "application/x-ndjson" });
            res.write('{"status":"downloading","total":100,"completed":40}\n');
            void gate.then(() => {
              pulled.push(name);
              res.end('{"status":"success"}\n');
            });
          });
        },
      },
    });
    try {
      await launch({ env: { WEBAIOS_OLLAMA_URL: ollama.url } });
      await forward(1, 5);
      await shows("welcome-ollama", "Ollama est prêt.");
      await shows("welcome-models", "Il manque les modèles d'IA locale (plusieurs Go).");
      await press("welcome-pull");
      await shows("welcome-models", "Téléchargement lancé");
      // The welcome goes on while the host pulls.
      await press("welcome-next");
      await shown("welcome-6");
      release();
      const file = join(w!.dataDir, "notifications.jsonl");
      await waitFor(m, "return true", () => existsSync(file) && readFileSync(file, "utf8").includes("L'IA locale est prête"), 15_000);
      expect(pulled).toEqual(["gemma4:e4b-mlx", "pplx-decider-flash"]);
    } finally {
      release();
      await ollama.close();
    }
  });

  it("a silent host: neither state can be checked", async () => {
    await launch({ welcome: false });
    await m.execute(`return (async () => { await window.webaiosWindow.store.agent.stop(); return true; })();`);
    await waitFor<number | null>(m, `return window.webaiosWindow.store.agent.pid;`, (pid) => pid === null);
    await click(m, '[data-testid="settings-button"]');
    await click(m, '[data-testid="settings-nav-about"]');
    await click(m, '[data-testid="settings-replay-welcome"]');
    await forward(1, 4);
    await shows("welcome-docker", "Impossible de vérifier pour l'instant.");
    await shown("welcome-recheck");
    await press("welcome-next");
    await shows("welcome-ollama", "Ollama n'est pas installé ou pas lancé.");
  });

  it("agent choice", async () => {
    await launch();
    await forward(1, 4);
    expect(await inUi(m, `return doc.querySelector('[data-testid="welcome-agent-claude"]').checked`)).toBe(true);
    await press("welcome-agent-codex");
    await saved((s) => s.settings?.agentProfile === "codex");
  });

  it("first space", async () => {
    await launch();
    await forward(1, 6);
    expect(await inUi(m, `return doc.querySelector('[data-testid="welcome-space-name"]').value`)).toBe("Perso");
    await fill("welcome-space-name", "Travail");
    await press("welcome-aura-lagon");
    await press("welcome-finish");
    await layerGone();
    const s = await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready).state)();`, (s) => s.settings.onboarded);
    expect(s.spaces).toHaveLength(1);
    expect(activeSpace(s)).toMatchObject({ name: "Travail", aura: "lagon", icon: "🏠", private: false });
    await w!.close();

    // An emptied name keeps the space's own.
    await launch();
    await forward(1, 6);
    await fill("welcome-space-name", "  ");
    await press("welcome-finish");
    await layerGone();
    const t = await state(m);
    expect(t.spaces).toHaveLength(1);
    expect(activeSpace(t)).toMatchObject({ name: "Perso", aura: "aube" });
  });

  it("the last page opens macOS's notification settings and stays", async () => {
    const dir = await mkdtemp(join(os.tmpdir(), "webaios-welcome-"));
    dirs.push(dir);
    const opened = join(dir, "opened.txt");
    await launch({ env: { WEBAIOS_TEST_REVEAL: opened } });
    await forward(1, 6);
    await press("welcome-notifications");
    const read = () => (existsSync(opened) ? readFileSync(opened, "utf8") : "");
    await waitFor(m, "return true", () => read().length > 0);
    expect(read()).toBe("x-apple.systempreferences:com.apple.Notifications-Settings.extension\n");
    await shown("welcome-6");
  });

  it("relaunch after finishing", async () => {
    const dataDir = await mkdtemp(join(os.tmpdir(), "webaios-welcome-"));
    dirs.push(dataDir);
    await launch({ dataDir });
    await forward(1, 6);
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
    await forward(1, 6);
    await fill("welcome-space-name", "Maison");
    await press("welcome-finish");
    await layerGone();
    const s = await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("chrome://browser/content/webaios/store.sys.mjs").ready).state)();`, (s) => s.settings.onboarded);
    expect(s.spaces).toHaveLength(1);
    expect(activeSpace(s).name).toBe("Maison");
    // Finished on the last page: a second replay starts at the beginning again.
    await click(m, '[data-testid="settings-replay-welcome"]');
    await shown("welcome-1");
  });

  it("first launch, whole journey", async () => {
    await launch({ firstTimeNotes: true });
    await forward(1, 6);
    await press("welcome-finish");
    await layerGone();
    // The home page opens the agent panel: its note takes the keyboard.
    await waitUi(m, "return !!doc.querySelector(arguments[0])", ['[data-testid="first-time-agent"]'], 10_000, "agent");
    expect(await m.execute<string>("return document.activeElement?.id;")).toBe("webaios-agent");
    expect(await inUi(m, "return doc.activeElement?.dataset.testid;", [], "agent")).toBe("first-time-ok");
    expect(await inUi(m, `return !!doc.querySelector('[data-testid="tip-card"]')`)).toBe(false);
    await click(m, '[data-testid="first-time-ok"]', { frame: "agent" });
    await waitUi(m, "return !doc.querySelector(arguments[0])", ['[data-testid="first-time-agent"]'], 10_000, "agent");
    // The tip takes its turn, and the keyboard is back where it was: the empty page's field.
    await shown("tip-card");
    await waitUi(m, "return document.activeElement?.id === 'webaios-sidebar' && doc.activeElement?.dataset.testid === 'empty-page-input'");
  });

  it("default launch skips it", async () => {
    await launch({ welcome: false });
    await shown("empty-page");
    await sleep(500);
    expect(await inUi(m, "return !!doc.querySelector(arguments[0])", [LAYER])).toBe(false);
  });
});
