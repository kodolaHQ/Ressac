import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { ClaudeEngine } from "../shared/settings";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, waitUi } from "./ui";

// Plan 48 Task 4: Claude's engine in Settings › Agents, its Ollama model picked from the installed ones.

const PAGE = '[data-testid="settings-page"]';
const CARD = '[data-testid="claude-engine"]';
const SECRET = "sk-ant-e2e-secret";
const SHOTS = join(import.meta.dirname, "../../../.superpowers/sdd/2026-11-11-ressac-plan-48-moteurs-claude/shots");
const NO_WEB = { "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": 1, "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": 1 };

/** A fake Ollama: two installed models. */
let ollama: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  ollama = await startServer({
    routes: {
      "/api/tags": (_req, res) =>
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ models: [{ name: "ornith:35b", details: { parameter_size: "35B" } }, { name: "qwen3.5:4b", details: { parameter_size: "4B" } }] })),
    },
  });
});
afterAll(() => ollama?.close());

let w: LaunchedRessac | undefined;
let m: Marionette;
const temp = mkdtempSync(join(os.tmpdir(), "ressac-claude-"));
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
  }
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

async function launch(o: { env?: Record<string, string>; prefs?: Record<string, string | number | boolean> } = {}): Promise<void> {
  w = await launchRessac({ env: { RESSAC_OLLAMA_URL: "http://127.0.0.1:9", ...o.env }, prefs: { ...NO_WEB, ...o.prefs } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await click(m, '[data-testid="settings-button"]');
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [PAGE]);
}
const inCard = (id: string) => `${CARD} [data-testid="${id}"]`;
const shows = (selector: string, wanted: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [selector, wanted], ms);
/** Sets a field or a select and leaves it (the `change` the page validates on). */
const fill = (id: string, value: string) =>
  inUi(m, "const f = doc.querySelector(arguments[0]); f.value = arguments[1]; f.dispatchEvent(new ui.Event('input', { bubbles: true })); f.dispatchEvent(new ui.Event('change', { bubbles: true }));", [inCard(id), value]);
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const savedEngine = (): ClaudeEngine | undefined => {
  try {
    return JSON.parse(read(join(w!.dataDir, "session.json"))).settings?.claudeEngine;
  } catch {
    return undefined;
  }
};
const engineSaved = (ok: (e: ClaudeEngine) => boolean) => waitFor(m, "return true", () => !!savedEngine() && ok(savedEngine()!), 15_000);
/** The picker's list, once read: each option's text. */
const options = () => waitUi<string[]>(m, "const s = doc.querySelector(arguments[0]); return s?.tagName === 'SELECT' && s.options.length > 1 && [...s.options].map((o) => o.textContent.trim())", [inCard("ollama-model")]);
/** Points Claude's Ollama address at `url` before Ollama is chosen: the default one would read this Mac's real Ollama. */
const ollamaAt = (url: string) =>
  inUi(m, "ui.ressac.settings.chooseClaudeEngine(arguments[0])", [{ kind: "subscription", ollamaUrl: url, ollamaModel: "", apiUrl: "", apiModel: "" }]);
const HINT = "Claude Code vous demande de vous connecter dans le panneau de l'agent ; sinon, tapez /login.";

/** The Claude card in light and in dark, for a look by eye (DESIGN.md). */
async function screenshots(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await inUi(m, "doc.querySelector(arguments[0]).scrollIntoView({ block: 'center' })", [CARD]);
  try {
    for (const [theme, dark] of [["light", 0], ["dark", 1]] as const) {
      await m.execute(`Services.prefs.setIntPref('ui.systemUsesDarkTheme', ${dark});`);
      await new Promise((r) => setTimeout(r, 800));
      const png = (await m.command<{ value: string }>("WebDriver:TakeScreenshot", { full: false, hash: false })).value;
      writeFileSync(join(SHOTS, `claude-ollama-${theme}.png`), Buffer.from(png, "base64"));
    }
  } finally {
    await m.execute("Services.prefs.clearUserPref('ui.systemUsesDarkTheme');");
  }
}

describe("Claude in Settings", () => {
  it("Ollama: the warning, the model picked from the list, the sign-in hint gone", { timeout: 60_000 }, async () => {
    await launch();
    await shows('[data-testid="agent-claude"]', HINT);
    await shows(CARD, "Moteur de Claude");
    await shows(CARD, "Abonnement Claude");
    await ollamaAt(ollama.url);
    await click(m, inCard("engine-ollama"));
    await shows(CARD, "réglez la longueur de contexte d'Ollama sur 64k au moins");
    expect(await options()).toEqual(["Choisir un modèle", "ornith:35b · 35B", "qwen3.5:4b · 4B"]);
    await fill("ollama-model", "ornith:35b");
    await engineSaved((e) => e.kind === "ollama" && e.ollamaModel === "ornith:35b" && e.ollamaUrl === ollama.url);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).textContent", ['[data-testid="agent-claude"]'])).not.toContain(HINT);
    expect(await inUi(m, "return doc.querySelector('[data-testid=agent-claude] [data-testid=agent-login]')?.classList.contains('primary')")).toBe(false);
    if (process.env.RESSAC_E2E_SHOTS) await screenshots();
  });

  it("Ollama: Claude's session gets the engine environment", { timeout: 90_000 }, async () => {
    await launch();
    await ollamaAt(ollama.url);
    await click(m, inCard("engine-ollama"));
    await options();
    await fill("ollama-model", "ornith:35b");
    await engineSaved((e) => e.kind === "ollama" && e.ollamaModel === "ornith:35b");
    const envFile = join(w!.dataDir, "workspace", "fake-agent-env.json");
    await inUi(m, "ui.ressac.agent.switch('codex')");
    await waitFor(m, "return true", () => existsSync(envFile), 30_000);
    rmSync(envFile);
    await inUi(m, "ui.ressac.agent.switch('claude')");
    await waitFor(m, "return true", () => read(envFile).includes("ANTHROPIC_BASE_URL"), 30_000);
    // Through the relay (a random host port), never the Ollama address itself.
    const sent = JSON.parse(read(envFile));
    expect(sent.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    expect(new URL(sent.ANTHROPIC_BASE_URL).port).not.toBe(new URL(ollama.url).port);
    expect(sent).toMatchObject({ ANTHROPIC_MODEL: "ornith:35b", ANTHROPIC_DEFAULT_SONNET_MODEL: "ornith:35b", CLAUDE_CODE_SUBAGENT_MODEL: "ornith:35b" });
  });

  it("engine changed while Claude runs: the panel offers Relancer, which resumes on the new engine", { timeout: 90_000 }, async () => {
    await launch();
    const envFile = join(w!.dataDir, "workspace", "fake-agent-env.json");
    await inUi(m, "ui.ressac.agent.switch('codex')");
    await waitFor(m, "return true", () => existsSync(envFile), 30_000);
    rmSync(envFile);
    await inUi(m, "ui.ressac.agent.switch('claude')");
    await waitFor(m, "return true", () => existsSync(envFile), 30_000);
    expect(read(envFile)).not.toContain("ANTHROPIC_BASE_URL");
    rmSync(envFile);
    await ollamaAt(ollama.url);
    await inUi(m, "ui.ressac.settings.chooseClaudeEngine(arguments[0])", [{ kind: "ollama", ollamaUrl: ollama.url, ollamaModel: "ornith:35b", apiUrl: "", apiModel: "" }]);
    await engineSaved((e) => e.kind === "ollama" && e.ollamaModel === "ornith:35b");
    // The running session keeps its engine: the panel says so, nothing restarts by itself.
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"agent-engine-changed\"]')", [], 10_000, "agent");
    expect(existsSync(envFile)).toBe(false);
    // The panel is closed in this test: a pointer click has nothing to aim at.
    await inUi(m, "doc.querySelector('[data-testid=\"agent-engine-relaunch\"]').click()", [], "agent");
    await waitFor(m, "return true", () => existsSync(envFile) && read(envFile).includes("ANTHROPIC_BASE_URL"), 30_000);
    expect(JSON.parse(read(envFile))).toMatchObject({ ANTHROPIC_MODEL: "ornith:35b" });
    await waitUi(m, "return !doc.querySelector('[data-testid=\"agent-engine-changed\"]')", [], 10_000, "agent");
  });

  it("a saved model that is gone is marked; Actualiser reads again", async () => {
    await launch();
    await ollamaAt(ollama.url);
    await click(m, inCard("engine-ollama"));
    await options();
    await inUi(m, "ui.ressac.settings.chooseClaudeEngine({ ...arguments[0], ollamaModel: 'gone:1b' })", [{ kind: "ollama", ollamaUrl: ollama.url, ollamaModel: "", apiUrl: "", apiModel: "" }]);
    await waitUi(m, "const s = doc.querySelector(arguments[0]); return s.options[s.selectedIndex]?.textContent.trim() === 'gone:1b (non installé)'", [inCard("ollama-model")]);
    const asked = ollama.paths.filter((p) => p === "/api/tags").length;
    await click(m, inCard("ollama-refresh"));
    await waitFor(m, "return true", () => ollama.paths.filter((p) => p === "/api/tags").length > asked);
  });

  it("Ollama on a dead port: the error, and a name typed by hand", async () => {
    await launch();
    await ollamaAt(ollama.url);
    await click(m, inCard("engine-ollama"));
    await options();
    await fill("ollama-url", "http://127.0.0.1:9");
    await shows(CARD, "Ollama ne répond pas à cette adresse.");
    expect(await inUi(m, "return doc.querySelector(arguments[0]).tagName", [inCard("ollama-model")])).toBe("INPUT");
    await fill("ollama-model", "big:70b");
    await engineSaved((e) => e.kind === "ollama" && e.ollamaModel === "big:70b");
  });

  it("API compatible: the key goes to Claude's keychain entry, never to session.json", { timeout: 60_000 }, async () => {
    const keyFile = join(temp, "keychain");
    await launch({ env: { RESSAC_TEST_KEYCHAIN: keyFile } });
    await click(m, inCard("engine-api"));
    expect(await inUi(m, "return doc.querySelector(arguments[0]).placeholder", [inCard("api-url")])).toBe("https://api.exemple.com (sans /v1)");
    await fill("api-url", "https://api.example.com");
    await fill("api-model", "glm-5");
    await engineSaved((e) => e.kind === "api" && e.apiUrl === "https://api.example.com" && e.apiModel === "glm-5");
    await fill("api-key", SECRET);
    await click(m, inCard("api-key-save"));
    await waitUi(m, "return !!doc.querySelector(arguments[0])", [inCard("api-key-saved")]);
    expect(read(`${keyFile}.claude`)).toBe(SECRET);
    expect(read(keyFile)).not.toContain(SECRET);
    expect(read(join(w!.dataDir, "session.json"))).not.toContain(SECRET);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).textContent", ['[data-testid="agent-claude"]'])).not.toContain(HINT);
    await click(m, inCard("api-key-delete"));
    await waitUi(m, "return !doc.querySelector(arguments[0])", [inCard("api-key-saved")]);
    expect(read(`${keyFile}.claude`)).not.toContain(SECRET);
  });
});
