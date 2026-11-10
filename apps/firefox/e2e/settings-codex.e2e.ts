import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import type { BrowserState } from "../shared/model";
import type { CodexEngine } from "../shared/settings";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { waitFor, waitReady } from "./firefox";
import { launchWebAiOs, type LaunchedWebAiOs } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, waitUi } from "./ui";

// Plan 45 Task 7: Codex in Settings › Agents (sign-in by code, its engine, the compatible API key).

const PAGE = '[data-testid="settings-page"]';
const STORE = "chrome://browser/content/webaios/store.sys.mjs";
const SECRET = "sk-e2e-secret";
// Any https page the test opens fails on a dead proxy: no real web.
const NO_WEB = { "network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": 1, "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": 1 };

/** The compatible API stand-in: notes the headers of each POST /v1/responses. */
const upstream: IncomingHttpHeaders[] = [];
let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer({
    routes: {
      "/v1/responses": (req, res) => {
        upstream.push(req.headers);
        req.resume();
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      },
    },
  });
});
afterAll(() => server?.close());

let w: LaunchedWebAiOs | undefined;
let m: Marionette;
const temp = mkdtempSync(join(os.tmpdir(), "webaios-codex-"));
afterEach(async () => {
  try {
    if (w) expect(await missingApi(m)).toEqual([]);
  } finally {
    await w?.close();
    w = undefined;
  }
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

async function launch(o: { env?: Record<string, string>; output?: string; prefs?: Record<string, string | number | boolean> } = {}): Promise<void> {
  w = await launchWebAiOs({ env: { WEBAIOS_OLLAMA_URL: "http://127.0.0.1:9", ...o.env }, prefs: { ...NO_WEB, ...o.prefs }, output: o.output });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await click(m, '[data-testid="settings-button"]');
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [PAGE]);
}
const shows = (id: string, wanted: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [`[data-testid="${id}"]`, wanted], ms);
/** Types into a field and leaves it (the `change` the page validates on). */
const fill = (id: string, value: string) =>
  inUi(m, "const f = doc.querySelector(arguments[0]); f.value = arguments[1]; f.dispatchEvent(new ui.Event('input', { bubbles: true })); f.dispatchEvent(new ui.Event('change', { bubbles: true }));", [
    `[data-testid="${id}"]`,
    value,
  ]);
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const savedEngine = (): CodexEngine | undefined => {
  try {
    return JSON.parse(read(join(w!.dataDir, "session.json"))).settings?.codexEngine;
  } catch {
    return undefined;
  }
};
const engineSaved = (ok: (e: CodexEngine) => boolean) => waitFor(m, "return true", () => !!savedEngine() && ok(savedEngine()!), 15_000);
/** Every file under `dir` whose content holds `text`. */
function filesWith(dir: string, text: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    const s = statSync(f, { throwIfNoEntry: false });
    if (s?.isDirectory()) found.push(...filesWith(f, text));
    else if (s?.isFile() && readFileSync(f).includes(text)) found.push(f);
  }
  return found;
}

describe("Codex in Settings", () => {
  it("codex account: sign in by code, the page opens, signed in, sign out", { timeout: 60_000 }, async () => {
    await launch();
    await shows("agent-codex", "Non connecté");
    await shows("agent-codex", "Connexion avec votre abonnement ChatGPT : un code à saisir sur le site d'OpenAI.");
    await shows("agent-claude", "Claude Code vous demande de vous connecter dans le panneau de l'agent ; sinon, tapez /login.");
    await click(m, '[data-testid="agent-codex"] [data-testid="agent-login"]');
    await shows("device-code", "ABCD-12345");
    await shows("agent-codex", "Ouvrez la page de connexion et saisissez le code");
    await shows("agent-codex", "En attente de la connexion…");
    // The code is entered (the fake creates the account 1 s later): the page's 5 s re-read sees it.
    await shows("agent-codex", "Connecté (ChatGPT)", 7_000);
    await click(m, '[data-testid="agent-codex"] [data-testid="agent-logout"]');
    await shows("agent-codex", "Non connecté");
    expect(existsSync(join(w!.dataDir, "workspace", "fake-codex-auth"))).toBe(false);
    // Again, this time opening the sign-in page (its address only: the proxy is dead).
    await click(m, '[data-testid="agent-codex"] [data-testid="agent-login"]');
    await click(m, '[data-testid="device-open"]');
    await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state)();`, (st) => Object.values(st.tabs).some((t) => t.url === "https://auth.openai.com/codex/device"));
  });

  it("engine persists; an invalid field says so and changes nothing", async () => {
    await launch();
    await shows("codex-engine", "Moteur de Codex");
    await shows("codex-engine", "S'applique à la prochaine conversation avec Codex.");
    await click(m, '[data-testid="engine-ollama"]');
    await fill("ollama-model", "qwen3:8b");
    await engineSaved((e) => e.kind === "ollama" && e.ollamaModel === "qwen3:8b");
    await click(m, '[data-testid="engine-api"]');
    expect(await inUi(m, "return doc.querySelector('[data-testid=\"api-url\"]').placeholder")).toBe("https://openrouter.ai/api/v1");
    await fill("api-url", "http://example.com");
    await shows("codex-engine", "Adresse invalide (https://…)");
    await fill("api-model", "bad model");
    await shows("codex-engine", "Modèle invalide");
    await fill("api-model", "m");
    await engineSaved((e) => e.kind === "api" && e.apiModel === "m");
    expect(savedEngine()).toMatchObject({ apiUrl: "", ollamaModel: "qwen3:8b" });
  });

  it("key never leaves the keychain", { timeout: 90_000 }, async () => {
    const keyFile = join(temp, "keychain");
    const output = join(temp, "output.log");
    await launch({ env: { WEBAIOS_TEST_KEYCHAIN: keyFile }, output, prefs: { "devtools.console.stdout.chrome": true } });
    await click(m, '[data-testid="engine-api"]');
    await fill("api-url", `${server.url}/v1`);
    await fill("api-model", "m");
    await engineSaved((e) => e.kind === "api" && e.apiUrl === `${server.url}/v1` && e.apiModel === "m");
    expect(await inUi(m, "const k = doc.querySelector('[data-testid=\"api-key\"]'); return [k.type, k.autocomplete, k.value]")).toEqual(["password", "off", ""]);
    await fill("api-key", SECRET);
    await click(m, '[data-testid="api-key-save"]');
    await waitUi(m, "return !!doc.querySelector('[data-testid=\"api-key-saved\"]')");
    expect(await inUi(m, "return doc.querySelector('[data-testid=\"api-key\"]').value")).toBe("");
    expect(read(keyFile)).toBe(SECRET);

    const args = join(w!.dataDir, "workspace", "fake-agent-args.json");
    await inUi(m, "ui.webaios.agent.switch('codex')");
    await waitFor(m, "return true", () => read(args).includes("webaios-api"), 30_000);
    const argv = JSON.parse(read(args)) as string[];
    expect(argv).toContain('model_provider="webaios-api"');
    const relayUrl = /base_url="([^"]+)"/.exec(argv.join(" "))?.[1];
    expect(relayUrl).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    const env = JSON.parse(read(join(w!.dataDir, "workspace", "fake-agent-env.json"))) as Record<string, string>;
    expect(env.WEBAIOS_ENGINE_TOKEN).toMatch(/.{16,}/);

    const r = await fetch(relayUrl!.replace("host.docker.internal", "127.0.0.1") + "/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${env.WEBAIOS_ENGINE_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    expect(upstream.at(-1)?.authorization).toBe(`Bearer ${SECRET}`);

    expect(filesWith(w!.dataDir, SECRET)).toEqual([]);
    expect(read(args)).not.toContain(SECRET);
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(read(output)).not.toBe("");
    expect(read(output)).not.toContain(SECRET);

    await click(m, '[data-testid="api-key-delete"]');
    await waitUi(m, "return !doc.querySelector('[data-testid=\"api-key-saved\"]')");
    expect(read(keyFile)).not.toContain(SECRET);
  });
});
