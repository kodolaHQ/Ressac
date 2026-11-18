import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import type { BrowserState } from "../shared/model";
import type { CodexEngine } from "../shared/settings";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { startServer } from "./server";
import { click, inUi, missingApi, startAgentSession, waitUi } from "./ui";

// Plan 45 Task 7: Codex in Settings › Agent (sign-in by code, its engine, the compatible API key).

const PAGE = '[data-testid="settings-page"]';
const CARD = '[data-testid="codex-engine"]';
const STORE = "chrome://browser/content/ressac/store.sys.mjs";
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
      // A fake Ollama: two installed models.
      "/api/tags": (_req, res) =>
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ models: [{ name: "ornith:35b", details: { parameter_size: "35B" } }, { name: "qwen3.5:4b", details: { parameter_size: "4B" } }] })),
    },
  });
});
afterAll(() => server?.close());

let w: LaunchedRessac | undefined;
let m: Marionette;
const temp = mkdtempSync(join(os.tmpdir(), "ressac-codex-"));
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
  w = await launchRessac({ env: { RESSAC_OLLAMA_URL: "http://127.0.0.1:9", ...o.env }, prefs: { ...NO_WEB, ...o.prefs }, output: o.output });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
  await click(m, '[data-testid="settings-button"]');
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [PAGE]);
  await click(m, '[data-testid="settings-nav-agent"]');
}
const shows = (id: string, wanted: string, ms = 10_000) =>
  waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [`[data-testid="${id}"]`, wanted], ms);
/** Types into a field and leaves it (the `change` the page validates on). */
const fill = (id: string, value: string) =>
  inUi(m, "const f = doc.querySelector(arguments[0]); f.value = arguments[1]; f.dispatchEvent(new ui.Event('input', { bubbles: true })); f.dispatchEvent(new ui.Event('change', { bubbles: true }));", [
    `${CARD} [data-testid="${id}"]`,
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
    // Again, this time opening the sign-in page (its address only: the proxy is dead); the code stays unentered so no re-read removes the button.
    writeFileSync(join(w!.dataDir, "workspace", "fake-codex-device-delay-ms"), "60000");
    await click(m, '[data-testid="agent-codex"] [data-testid="agent-login"]');
    await click(m, '[data-testid="device-open"]');
    await waitFor<BrowserState>(m, `return (async () => (await ChromeUtils.importESModule("${STORE}").ready).state)();`, (st) => Object.values(st.tabs).some((t) => t.url === "https://auth.openai.com/codex/device"));
  });

  it("a sign-in by code that ends unsigned says it was interrupted and offers Se connecter again", { timeout: 60_000 }, async () => {
    await launch();
    writeFileSync(join(w!.dataDir, "workspace", "fake-codex-device-expires"), "");
    await click(m, '[data-testid="agent-codex"] [data-testid="agent-login"]');
    await shows("device-code", "ABCD-12345");
    await shows("agent-codex", "la connexion par code s'est interrompue, recommencez", 10_000);
    await waitUi(m, `return !!doc.querySelector('[data-testid="agent-codex"] [data-testid="agent-login"]') && !doc.querySelector('[data-testid="device-code"]')`);
  });

  it("engine persists; an invalid field says so and changes nothing", async () => {
    await launch();
    await shows("codex-engine", "Moteur");
    await shows("codex-engine", "Un changement s'applique à la prochaine session ; l'agent ouvert propose de se relancer.");
    await click(m, `${CARD} [data-testid="engine-ollama"]`);
    await fill("ollama-url", server.url);
    // The model is picked from the installed ones; the default gpt-oss:20b is not among them.
    // The default address may first list this Mac's real Ollama: wait for the fake's list.
    await waitUi(
      m,
      "const s = doc.querySelector(arguments[0]); return s?.tagName === 'SELECT' && [...s.options].map((o) => o.textContent.trim()).join('|') === arguments[1]",
      [`${CARD} [data-testid="ollama-model"]`, "gpt-oss:20b (non installé)|ornith:35b · 35B|qwen3.5:4b · 4B"],
    );
    await fill("ollama-model", "qwen3.5:4b");
    await engineSaved((e) => e.kind === "ollama" && e.ollamaModel === "qwen3.5:4b");
    await click(m, `${CARD} [data-testid="engine-api"]`);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).placeholder", [`${CARD} [data-testid="api-url"]`])).toBe("https://openrouter.ai/api/v1");
    await fill("api-url", "http://example.com");
    await shows("codex-engine", "Adresse invalide (https://…)");
    await fill("api-model", "bad model");
    await shows("codex-engine", "Modèle invalide");
    await fill("api-model", "m");
    await engineSaved((e) => e.kind === "api" && e.apiModel === "m");
    expect(savedEngine()).toMatchObject({ apiUrl: "", ollamaModel: "qwen3.5:4b" });
  });

  it("key never leaves the keychain", { timeout: 90_000 }, async () => {
    const keyFile = join(temp, "keychain");
    const output = join(temp, "output.log");
    await launch({ env: { RESSAC_TEST_KEYCHAIN: keyFile }, output, prefs: { "devtools.console.stdout.chrome": true } });
    await click(m, `${CARD} [data-testid="engine-api"]`);
    await fill("api-url", `${server.url}/v1`);
    await fill("api-model", "m");
    await engineSaved((e) => e.kind === "api" && e.apiUrl === `${server.url}/v1` && e.apiModel === "m");
    expect(await inUi(m, "const k = doc.querySelector(arguments[0]); return [k.type, k.autocomplete, k.value]", [`${CARD} [data-testid="api-key"]`])).toEqual(["password", "off", ""]);
    await fill("api-key", SECRET);
    await click(m, `${CARD} [data-testid="api-key-save"]`);
    await waitUi(m, "return !!doc.querySelector(arguments[0])", [`${CARD} [data-testid="api-key-saved"]`]);
    expect(await inUi(m, "return doc.querySelector(arguments[0]).value", [`${CARD} [data-testid="api-key"]`])).toBe("");
    expect(read(keyFile)).toBe(SECRET);

    const args = join(w!.dataDir, "workspace", "fake-agent-args.json");
    // A session runs first: switching agent with none open only picks the next one's profile.
    await startAgentSession(m);
    await inUi(m, "ui.ressac.agent.switch('codex')");
    await waitFor(m, "return true", () => read(args).includes("ressac-api"), 30_000);
    const argv = JSON.parse(read(args)) as string[];
    expect(argv).toContain('model_provider="ressac-api"');
    const relayUrl = /base_url="([^"]+)"/.exec(argv.join(" "))?.[1];
    expect(relayUrl).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    const env = JSON.parse(read(join(w!.dataDir, "workspace", "fake-agent-env.json"))) as Record<string, string>;
    expect(env.RESSAC_ENGINE_TOKEN).toMatch(/.{16,}/);

    const r = await fetch(relayUrl!.replace("host.docker.internal", "127.0.0.1") + "/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESSAC_ENGINE_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(200);
    expect(upstream.at(-1)?.authorization).toBe(`Bearer ${SECRET}`);

    expect(filesWith(w!.dataDir, SECRET)).toEqual([]);
    expect(read(args)).not.toContain(SECRET);
    expect(JSON.stringify(env)).not.toContain(SECRET);
    expect(read(output)).not.toBe("");
    expect(read(output)).not.toContain(SECRET);

    await click(m, `${CARD} [data-testid="api-key-delete"]`);
    await waitUi(m, "return !doc.querySelector(arguments[0])", [`${CARD} [data-testid="api-key-saved"]`]);
    expect(read(keyFile)).not.toContain(SECRET);
  });
});
