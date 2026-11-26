import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import type { OwnEngine } from "../shared/settings";
import { dispatch, state, waitFor, waitReady } from "./firefox";
import { launchRessac, type LaunchedRessac } from "./launch";
import type { Marionette } from "./marionette";
import { writePassport } from "./passport-file";
import { startServer } from "./server";
import { click, inUi, pressKeys, typeText, waitUi } from "./ui";

// « Votre modèle »: the chat on the user's own model, a loop in the host. One fake model server speaks Ollama (/api/tags,
// /api/show, /api/chat) and the OpenAI API (/v1/models, /v1/chat/completions); each loop step answers the test's next
// scripted action, and every request (path, headers, body) is logged to `model.jsonl`.
const KEY = "sk-test-camille";
const EMAIL = "camille.aubrac@example.org";
const MODEL = "qwen-test:4b";
const OWN = '[data-testid="own-engine"]';
const CARD = '[data-testid="permission-request"]';

type Step = (last: string) => object;
const fake = { script: [] as Step[], refuseJsonSchema: false, hold: false, heldClosed: false };
const temp = mkdtempSync(join(tmpdir(), "ressac-own-"));
const logFile = join(temp, "model.jsonl");
const goFile = join(temp, "fake-own-go");
type Logged = { path: string; headers: IncomingMessage["headers"]; body: any };
const logged = (): Logged[] => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The loop's step: the next scripted action, given the last message (a tool result names the tab it opened). */
function step(body: any): string {
  const messages = body.messages as { role: string; content: string }[];
  const next = fake.script.shift();
  return JSON.stringify(next ? next(messages.at(-1)?.content ?? "") : { action: "answer", text: "Fin du script." });
}
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = s ? JSON.parse(s) : null;
      } catch {
        body = s;
      }
      writeFileSync(logFile, JSON.stringify({ path: req.url, headers: req.headers, body }) + "\n", { flag: "a" });
      resolve(body);
    });
  });
}
const json = (res: ServerResponse, status: number, o: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(o));
/** Held by the test (« Arrêter »): answers once `fake-own-go` exists, notes whether the loop closed the request first. */
async function maybeHold(res: ServerResponse): Promise<boolean> {
  if (!fake.hold) return true;
  res.on("close", () => !res.writableEnded && (fake.heldClosed = true));
  while (!existsSync(goFile)) {
    if (res.destroyed) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !res.destroyed;
}

const routes: NonNullable<Parameters<typeof startServer>[0]>["routes"] = {
  "/api/tags": (req, res) => void readBody(req).then(() => json(res, 200, { models: [{ name: MODEL, details: { parameter_size: "4B" } }, { name: "gros:cloud", remote_model: "gros", remote_host: "https://ollama.com:443" }] })),
  // As real Ollama: /api/show never names a cloud model's remote host, only its /api/tags entry does.
  "/api/show": (req, res) => void readBody(req).then(() => json(res, 200, { details: {} })),
  "/api/chat": (req, res) =>
    void readBody(req).then(async (body) => {
      if (await maybeHold(res)) json(res, 200, { message: { content: step(body) }, prompt_eval_count: 200 });
    }),
  "/v1/models": (req, res) => void readBody(req).then(() => json(res, 200, { data: [{ id: "gpt-test" }, { id: "autre-modele" }] })),
  "/v1/chat/completions": (req, res) =>
    void readBody(req).then((body) => {
      if (fake.refuseJsonSchema && body.response_format?.type === "json_schema") return json(res, 400, { error: { message: "response_format json_schema is not supported" } });
      // Réglages' check (« Reply OK. ») or a loop step.
      if (body.messages?.[0]?.content === "Reply OK.") return json(res, 200, { choices: [{ message: { content: "OK" } }] });
      json(res, 200, { choices: [{ message: { content: step(body) } }], usage: { prompt_tokens: 200 } });
    }),
};
let model: Awaited<ReturnType<typeof startServer>>;
let other: Awaited<ReturnType<typeof startServer>>;
let site: Awaited<ReturnType<typeof startServer>>;
/** What the form page posted on each input: the value the browser wrote in its field. */
const got: string[] = [];
const FORM = `<title>Inscription</title><form action="/recu"><label>E-mail <input type="email" name="email"></label></form>
<script>document.querySelector("input").addEventListener("input", (e) => fetch("/recu?v=" + encodeURIComponent(e.target.value)));</script>`;
beforeAll(async () => {
  model = await startServer({ routes });
  // A second provider (another origin) for the key's binding.
  other = await startServer({ routes });
  site = await startServer({
    routes: {
      "/ville": (_req, res) => void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<title>Ville</title><p>La ville est Lyon.</p>"),
      "/formulaire": (_req, res) => void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(FORM),
      ...Object.fromEntries(
        [["/lue", "Page citee"], ["/autre", "Page voisine"], ["/ici", "Page ici"]].map(([path, title]) => [path, (_req: IncomingMessage, res: ServerResponse) => void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<title>${title}</title><p>Contenu de ${title}</p>`)]),
      ),
      "/recu": (req, res) => (got.push(new URL(req.url!, "http://x").searchParams.get("v") ?? ""), void res.writeHead(204).end()),
    },
  });
});
afterAll(async () => {
  await Promise.all([model?.close(), other?.close(), site?.close()]);
  rmSync(temp, { recursive: true, force: true });
});

let w: LaunchedRessac | undefined;
let m: Marionette;
let ownProfile: string | undefined;
beforeEach(() => {
  got.length = 0;
  Object.assign(fake, { script: [], refuseJsonSchema: false, hold: false, heldClosed: false });
  rmSync(logFile, { force: true });
  rmSync(goFile, { force: true });
  // Each test starts without a saved key (the keychain stand-in files: keychain.own and its origin).
  for (const f of readdirSync(temp)) if (f.startsWith("keychain")) rmSync(join(temp, f), { force: true });
});
afterEach(async () => {
  await w?.close();
  w = undefined;
  if (ownProfile) await rm(ownProfile, { recursive: true, force: true });
  ownProfile = undefined;
});

async function launch(o: { profile?: string; env?: Record<string, string>; output?: string } = {}): Promise<void> {
  w = await launchRessac({ agentView: "chat", writer: "claude", profile: o.profile, output: o.output, env: { RESSAC_TEST_KEYCHAIN: join(temp, "keychain"), ...o.env } });
  m = w.marionette;
  await m.setContext("chrome");
  await waitReady(m);
}
const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const savedOwn = (): OwnEngine | undefined => {
  try {
    return JSON.parse(read(join(w!.dataDir, "session.json"))).settings?.ownEngine;
  } catch {
    return undefined;
  }
};
const ownSaved = (ok: (e: OwnEngine) => boolean) => waitFor(m, "return true", () => !!savedOwn() && ok(savedOwn()!), 15_000);
const shows = (wanted: string, ms = 10_000) => waitUi(m, "return doc.querySelector(arguments[0])?.textContent.replace(/\\s+/g, ' ').includes(arguments[1])", [OWN, wanted], ms);
/** Types into a field of « Votre modèle » and leaves it (the `change` the page validates on). */
const fill = (id: string, value: string) =>
  inUi(m, "const f = doc.querySelector(arguments[0]); f.value = arguments[1]; f.dispatchEvent(new ui.Event('input', { bubbles: true })); f.dispatchEvent(new ui.Event('change', { bubbles: true }));", [`${OWN} [data-testid="${id}"]`, value]);

async function openSettings(): Promise<void> {
  await click(m, '[data-testid="settings-button"]');
  await waitUi(m, "return !!doc.querySelector('[data-testid=\"settings-page\"]')");
  await click(m, '[data-testid="settings-nav-agent"]');
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [OWN]);
}
/** Réglages › Agent › Votre modèle on the fake Ollama, its model picked from the list. */
async function ollamaOnFake(): Promise<void> {
  await openSettings();
  await fill("ollama-url", model.url);
  await ownSaved((e) => e.ollamaUrl === model.url);
  await waitUi(m, "const s = doc.querySelector(arguments[0]); return s?.tagName === 'SELECT' && [...s.options].some((o) => o.value === arguments[1])", [`${OWN} [data-testid="ollama-model"]`, MODEL]);
  // An Ollama cloud model is offered, marked « en ligne ».
  expect(await inUi(m, "const o = [...doc.querySelector(arguments[0]).options].find((o) => o.value === 'gros:cloud'); return [o?.disabled, o?.textContent]", [`${OWN} [data-testid="ollama-model"]`])).toEqual([false, "gros:cloud · en ligne"]);
  await fill("ollama-model", MODEL);
  await ownSaved((e) => e.kind === "ollama" && e.ollamaModel === MODEL);
  await shows("Ce que le modèle lit et écrit reste sur votre Mac");
}

const waitAgent = <T>(body: string, args: unknown[] = [], ms = 20_000) => waitUi<T>(m, body, args, ms, "agent");
const textOf = (testid: string) => waitAgent<string>(`return [...doc.querySelectorAll('[data-testid="${testid}"]')].map((e) => e.textContent).join("\\n")`);
/** The agent panel on a new discussion on « Votre modèle », from the chip's menu. */
async function ownDiscussion(): Promise<void> {
  await click(m, '[data-testid="agent-button"]');
  // The window's first discussion (Claude's) has started: its session start takes back the window's accesses, so it
  // must not land during the own discussion's turn and drop its card.
  await expect.poll(() => read(join(w!.dataDir, "workspace", "fake-chat-claude.jsonl")).includes('"argv"'), { timeout: 30_000 }).toBe(true);
  await waitAgent("return !!doc.querySelector('[data-testid=\"chat-mode-chip\"]')");
  await click(m, '[data-testid="chat-mode-chip"]', { frame: "agent" });
  await click(m, '[data-testid="chat-profile-own"]', { frame: "agent" });
  await waitAgent("return doc.querySelector('[data-testid=\"chat-mode-chip\"]')?.textContent.includes('Votre modèle') && !!doc.querySelector('[data-testid=\"chat-input\"]')");
}
async function type(text: string): Promise<void> {
  await click(m, '[data-testid="chat-input"]', { frame: "agent" });
  await waitAgent("return doc.activeElement?.dataset.testid === 'chat-input'");
  await typeText(m, text);
}
async function send(text: string): Promise<void> {
  await type(text);
  await pressKeys(m, "Enter");
  await waitAgent("return doc.querySelector('[data-testid=\"chat-input\"]')?.value === ''");
}
const agentSays = (text: string) => waitAgent("return [...doc.querySelectorAll('[data-testid=\"chat-agent\"]')].some((e) => e.textContent.includes(arguments[0]))", [text], 60_000);
/** open_tab on the local page, read_tab on the tab it named, then the answer. */
const cityScript = (): Step[] => [
  () => ({ action: "open_tab", url: `${site.url}/ville` }),
  (last) => ({ action: "read_tab", id: last.split("\n")[2]?.trim() }),
  () => ({ action: "answer", text: "Lyon" }),
];
/** read_tab on the local page asks its card in the window (the agent opened the tab, it does not serve it). */
async function approveRead(): Promise<void> {
  await waitUi(m, "return doc.querySelector(arguments[0])?.textContent.includes('L\\'agent veut lire')", [CARD], 30_000);
  await click(m, `${CARD} button`, { text: "Autoriser une fois" });
}
const loopSteps = () => logged().filter((l) => (l.path === "/api/chat" || l.path === "/v1/chat/completions") && l.body?.messages?.[0]?.role === "system");
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
const dockerLog = () => read(join(w!.dataDir, "workspace", "fake-docker-all.log")).split("\n").filter(Boolean);

it("Ollama : lit une page et répond", { timeout: 90_000 }, async () => {
  await launch();
  await ollamaOnFake();
  fake.script = cityScript();
  await ownDiscussion();
  const docker = dockerLog().length;
  await send("Quelle ville ?");
  await approveRead();
  await agentSays("Lyon");
  expect(await textOf("chat-own-warning")).toBe("Votre modèle peut se tromper");
  expect(await waitAgent<number>("return doc.querySelectorAll('[data-testid=\"chat-tool\"]').length >= 2 && doc.querySelectorAll('[data-testid=\"chat-tool\"]').length")).toBeGreaterThanOrEqual(2);
  // The read result reached the model as data.
  expect(loopSteps().at(-1)!.body.messages.at(-1).content).toContain("La ville est Lyon.");
  // The loop runs in the host: no container command for this discussion.
  expect(dockerLog().slice(docker).filter((l) => l.startsWith("exec") && !l.includes("claude"))).toEqual([]);
});

it("API avec une clé : la clé va au serveur, jamais ailleurs", { timeout: 90_000 }, async () => {
  const output = join(temp, "output.log");
  await launch({ output });
  await openSettings();
  await click(m, `${OWN} [data-testid="own-kind-api"]`);
  await fill("api-url", `${model.url}/v1`);
  await ownSaved((e) => e.kind === "api" && e.apiUrl === `${model.url}/v1`);
  await fill("api-key", KEY);
  await click(m, `${OWN} [data-testid="api-key-save"]`);
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [`${OWN} [data-testid="api-key-saved"]`]);
  // Picked from the API's list (asked with the key).
  await waitUi(m, "const s = doc.querySelector(arguments[0]); return s?.tagName === 'SELECT' && [...s.options].some((o) => o.value === 'gpt-test')", [`${OWN} [data-testid="own-api-model"]`]);
  await fill("own-api-model", "gpt-test");
  await ownSaved((e) => e.apiModel === "gpt-test");
  await click(m, `${OWN} [data-testid="own-check"]`);
  await waitUi(m, "return doc.querySelector(arguments[0])?.textContent.includes('Connexion réussie avec gpt-test.')", [`${OWN} [data-testid="own-check-result"]`]);
  fake.script = cityScript();
  await ownDiscussion();
  await send("Quelle ville ?");
  await approveRead();
  await agentSays("Lyon");
  const steps = loopSteps();
  expect(steps.length).toBeGreaterThan(0);
  expect(steps.every((l) => l.headers.authorization === `Bearer ${KEY}`)).toBe(true);
  expect(logged().filter((l) => l.path === "/v1/models").at(-1)?.headers.authorization).toBe(`Bearer ${KEY}`);
  // Nowhere else: the chat, the data folder (the discussion's file), the browser's output.
  expect(await waitAgent<string>("return doc.documentElement.outerHTML")).not.toContain(KEY);
  expect(filesWith(w!.dataDir, KEY)).toEqual([]);
  expect(read(output)).not.toContain(KEY);
});

it("un json_schema refusé passe en json_object", async () => {
  await launch();
  await openSettings();
  await click(m, `${OWN} [data-testid="own-kind-api"]`);
  await fill("api-url", `${model.url}/v1`);
  await ownSaved((e) => e.kind === "api" && e.apiUrl === `${model.url}/v1`);
  await fill("own-api-model-typed", "gpt-test");
  await ownSaved((e) => e.apiModel === "gpt-test");
  fake.refuseJsonSchema = true;
  fake.script = [() => ({ action: "answer", text: "Lyon" })];
  await ownDiscussion();
  await send("Quelle ville ?");
  await agentSays("Lyon");
  const kinds = logged().filter((l) => l.path === "/v1/chat/completions" && l.body?.messages?.[0]?.role === "system").map((l) => l.body.response_format?.type);
  expect(kinds).toEqual(["json_schema", "json_object"]);
});

it("Arrêter coupe le tour", async () => {
  await launch();
  await ollamaOnFake();
  fake.hold = true;
  await ownDiscussion();
  await send("Quelle ville ?");
  await waitAgent("return !!doc.querySelector('[data-testid=\"chat-stop\"]')");
  await expect.poll(() => loopSteps().length, { timeout: 20_000 }).toBe(1);
  await click(m, '[data-testid="chat-stop"]', { frame: "agent" });
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-stop\"]')");
  // The held request's connection was closed by the loop, before any answer.
  await expect.poll(() => fake.heldClosed, { timeout: 10_000 }).toBe(true);
  // Ready again: the next message gets its answer.
  fake.hold = false;
  fake.script = [() => ({ action: "answer", text: "Lyon" })];
  await send("encore");
  await agentSays("Lyon");
});

it("une adresse du passeport tapée arrive masquée au modèle", async () => {
  const profile = (ownProfile = mkdtempSync(join(tmpdir(), "ressac-firefox-")));
  await writePassport(profile, [{ id: "e", field: "email", value: { text: EMAIL }, origins: [] }]);
  await launch({ profile, env: { RESSAC_TEST_PASSPORT_CIPHER: "memory" } });
  await ollamaOnFake();
  fake.script = [() => ({ action: "answer", text: "C'est noté." })];
  await ownDiscussion();
  await type(`écris à ${EMAIL}`);
  expect(await textOf("chat-chip")).toContain("e-mail masqué");
  await pressKeys(m, "Enter");
  await agentSays("C'est noté.");
  const sent = JSON.stringify(loopSteps().map((l) => l.body.messages));
  expect(sent).toContain("⟨email-");
  expect(sent).not.toContain(EMAIL.split("@")[0]);
});

const MASK_CARD = '[data-testid="mask-request"]';
const actionsOf = (l: Logged) => l.body.format.properties.action.enum as string[];

it("un modèle cloud d'Ollama remplit un champ avec le passeport, après la carte, sans voir la valeur", { timeout: 120_000 }, async () => {
  const profile = (ownProfile = mkdtempSync(join(tmpdir(), "ressac-firefox-")));
  await writePassport(profile, [{ id: "e", field: "email", value: { text: EMAIL }, origins: [] }]);
  await launch({ profile, env: { RESSAC_TEST_PASSPORT_CIPHER: "memory", RESSAC_TEST_REAUTH: "pass" } });
  await ollamaOnFake();
  await fill("ollama-model", "gros:cloud");
  await ownSaved((e) => e.ollamaModel === "gros:cloud");
  let tab = "";
  fake.script = [
    () => ({ action: "open_tab", url: `${site.url}/formulaire` }),
    (last) => ({ action: "read_tab", id: (tab = last.split("\n")[2]!.trim()) }),
    (last) => ({ action: "fill_field", id: tab, field: Number(/(\d+)\. email — /.exec(last)![1]), passport: "email" }),
    () => ({ action: "answer", text: "Rempli." }),
  ];
  await ownDiscussion();
  await send("Remplis mon e-mail");
  await approveRead();
  await waitUi(m, "const c = doc.querySelector(arguments[0]); return c?.dataset.kind === 'mask-fill'", [MASK_CARD], 30_000);
  await click(m, `${MASK_CARD} button`, { text: "Remplir" });
  await agentSays("Rempli.");
  await expect.poll(() => got.at(-1), { timeout: 15_000 }).toBe(EMAIL);
  // The model chose among fill_field's, and never saw the value.
  expect(loopSteps().every((l) => actionsOf(l).includes("fill_field"))).toBe(true);
  expect(JSON.stringify(loopSteps().map((l) => l.body.messages))).not.toContain(EMAIL.split("@")[0]);
  expect(await textOf("chat-tool")).toContain("Remplit le formulaire");
});

it("un modèle sur le Mac ne remplit pas : fill_field n'est pas proposé, et refusé s'il l'écrit", async () => {
  await launch();
  await ollamaOnFake();
  fake.script = [() => ({ action: "fill_field", id: "t1", field: 0, value: "x" }), () => ({ action: "fill_field", id: "t1", field: 0, value: "x" })];
  await ownDiscussion();
  await send("Remplis le champ");
  // The reply and its one retry, then the turn ends on the error, shown, with no tool called.
  await waitAgent("return doc.querySelector('[data-testid=\"chat-turn-error\"]')?.textContent === arguments[0]", ["Le modèle n'a pas répondu dans le format attendu."], 30_000);
  expect(await waitAgent<number>("return doc.querySelectorAll('[data-testid=\"chat-tool\"]').length + 1")).toBe(1);
  expect(loopSteps().length).toBe(2);
  expect(loopSteps().some((l) => actionsOf(l).includes("fill_field") || l.body.messages[0].content.includes("fill_field"))).toBe(false);
  expect(await inUi<boolean>(m, "return !!doc.querySelector(arguments[0])", [MASK_CARD])).toBe(false);
});

it("une adresse d'Ollama hors du Mac est refusée", async () => {
  await launch();
  await openSettings();
  await fill("ollama-url", "http://192.168.1.4:11434");
  await shows("Adresse refusée : pour une adresse hors de votre Mac, choisissez « API compatible OpenAI ».");
  // Must not happen: the refused address saved. The refusal came from the host, after which nothing saves.
  expect(savedOwn()?.ollamaUrl).toBe("http://127.0.0.1:11434");
  await click(m, '[data-testid="agent-button"]');
  await click(m, '[data-testid="chat-mode-chip"]', { frame: "agent" });
  await waitAgent("return !!doc.querySelector('[data-testid=\"chat-profile-codex\"]')");
  expect(await waitAgent<boolean>("return !doc.querySelector('[data-testid=\"chat-profile-own\"]')")).toBe(true);
});

it("pas de Mode avancé ni d'Atelier pour une discussion sur votre modèle", async () => {
  await launch();
  await ollamaOnFake();
  await ownDiscussion();
  await waitAgent("return !doc.querySelector('[data-testid=\"chat-advanced\"]')");
  await click(m, '[data-testid="chat-mode-chip"]', { frame: "agent" });
  expect(await waitAgent<boolean>("return doc.querySelector('[data-testid=\"chat-mode-workshop\"]')?.disabled")).toBe(true);
});

it("une API hors du Mac est signalée dans Réglages, sur la puce et sous la saisie", async () => {
  await launch();
  await openSettings();
  await click(m, `${OWN} [data-testid="own-kind-api"]`);
  // Off the Mac for Ressac (not 127.0.0.1): nothing listens there, the marks come from the setting alone.
  await fill("api-url", "https://127.0.0.2/v1");
  await ownSaved((e) => e.kind === "api" && e.apiUrl === "https://127.0.0.2/v1");
  await fill("own-api-model-typed", "gpt-test");
  await ownSaved((e) => e.apiModel === "gpt-test");
  await shows("Ce modèle n'est pas sur votre Mac : ce que l'agent lit et ce que vous lui écrivez sont envoyés à 127.0.0.2.");
  await ownDiscussion();
  expect(await textOf("chat-engine-remote")).toBe("en ligne");
  expect(await waitAgent<string>("return doc.querySelector('[data-testid=\"chat-engine-remote\"]')?.title")).toContain("vont à 127.0.0.2");
  expect(await textOf("chat-sent-to")).toBe("Envoyé à 127.0.0.2");
});

it("un modèle cloud d'Ollama se choisit, marqué en ligne ; la discussion dit où vont les messages", async () => {
  await launch();
  await ollamaOnFake();
  await fill("ollama-model", "gros:cloud");
  await ownSaved((e) => e.ollamaModel === "gros:cloud");
  await shows("Ce modèle n'est pas sur votre Mac : ce que l'agent lit et ce que vous lui écrivez sont envoyés à ollama.com.");
  await ownDiscussion();
  // Known once the host checked the model at open (its /api/tags entry names its remote host).
  await waitAgent("return doc.querySelector('[data-testid=\"chat-sent-to\"]')?.textContent === 'Envoyé à ollama.com'");
  expect(await textOf("chat-engine-remote")).toBe("en ligne");
  expect(await textOf("chat-own-warning")).toBe("Votre modèle peut se tromper");
});

it("le modèle se change dans le chat : la discussion continue sur le nouveau, marqué en ligne, et Réglages le garde", { timeout: 90_000 }, async () => {
  await launch();
  await ollamaOnFake();
  fake.script = [() => ({ action: "answer", text: "Premier." }), () => ({ action: "answer", text: "Second." })];
  await ownDiscussion();
  await send("un");
  await agentSays("Premier.");
  await click(m, '[data-testid="chat-model-chip"]', { frame: "agent" });
  // Ollama's own list, its cloud model marked.
  await waitAgent("return !!doc.querySelector('[data-testid=\"chat-model-gros:cloud\"]')");
  expect(await waitAgent<string>("return doc.querySelector('[data-testid=\"chat-model-gros:cloud\"]').textContent.replace(/\\s+/g, ' ').trim()")).toBe("gros:cloud · en ligne");
  await click(m, '[data-testid="chat-model-gros:cloud"]', { frame: "agent" });
  await waitAgent("return doc.querySelector('[data-testid=\"chat-model-chip\"]')?.textContent.trim() === 'gros:cloud' && !doc.querySelector('[data-testid=\"chat-model-menu\"]')");
  await waitAgent("return doc.querySelector('[data-testid=\"chat-sent-to\"]')?.textContent === 'Envoyé à ollama.com'");
  await ownSaved((e) => e.ollamaModel === "gros:cloud");
  await send("deux");
  await agentSays("Second.");
  // The same discussion went on (no pause), its next step on the new model.
  expect(loopSteps().map((l) => l.body.model)).toEqual([MODEL, "gros:cloud"]);
  expect(await textOf("chat-agent")).toContain("Premier.");
});

it("une clé saisie juste après une nouvelle adresse va à cette adresse", async () => {
  await launch();
  await openSettings();
  await click(m, `${OWN} [data-testid="own-kind-api"]`);
  await fill("api-url", `${model.url}/v1`);
  await ownSaved((e) => e.kind === "api" && e.apiUrl === `${model.url}/v1`);
  // Provider B's address then its key, saved at once in one script (a Marionette round trip would let the host answer
  // first): the address's change is still with the host when « Enregistrer la clé » is pressed.
  await inUi(
    m,
    `const q = (id) => doc.querySelector(arguments[0] + ' [data-testid="' + id + '"]');
     const url = q("api-url");
     url.value = arguments[1];
     url.dispatchEvent(new ui.Event("change", { bubbles: true }));
     const key = q("api-key");
     key.value = arguments[2];
     key.dispatchEvent(new ui.Event("input", { bubbles: true }));
     await Promise.resolve(); // the button arms on Svelte's microtask flush
     if (q("api-key-save").disabled) throw new Error("save not armed");
     q("api-key-save").click();`,
    [OWN, `${other.url}/v1`, KEY],
  );
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [`${OWN} [data-testid="api-key-saved"]`]);
  const to = (s: { url: string }) => logged().filter((l) => l.path === "/v1/models" && `http://${l.headers.host}` === s.url);
  // The list read again with the key: it went to B.
  await expect.poll(() => to(other).some((l) => l.headers.authorization === `Bearer ${KEY}`), { timeout: 15_000 }).toBe(true);
  // Back on A: the list is asked without the key, and Réglages says why.
  await fill("api-url", `${model.url}/v1`);
  await ownSaved((e) => e.apiUrl === `${model.url}/v1`);
  await waitUi(m, "return !!doc.querySelector(arguments[0])", [`${OWN} [data-testid="own-key-not-sent"]`]);
  expect(to(model).length).toBeGreaterThan(0);
  expect(to(model).every((l) => !l.headers.authorization)).toBe(true);
});

const menuKeys = () => waitAgent<string[]>("return [...doc.querySelectorAll('[data-testid=\"chat-menu-item\"]')].map((e) => e.dataset.key)");
const offKeys = () => waitAgent<string[]>("return [...doc.querySelectorAll('[data-testid=\"chat-menu-item\"][aria-disabled]')].map((e) => e.dataset.key)");
const inputIs = (v: string) => waitAgent("return doc.querySelector('[data-testid=\"chat-input\"]')?.value === arguments[0]", [v]);
/** Picks `key` in the open menu (↓ until it is the active row), then Entrée. */
async function pick(key: string): Promise<void> {
  await expect.poll(menuKeys, { timeout: 10_000 }).toContain(key);
  while ((await waitAgent<string>("return doc.querySelector('[data-testid=\"chat-menu-item\"].active')?.dataset.key ?? 'none'")) !== key) await pressKeys(m, "ArrowDown");
  await pressKeys(m, "Enter");
}

it("/agent passe à Votre modèle (sans /terminal) ; @onglet et @page : l'onglet cité se lit sans carte, un autre demande toujours", { timeout: 120_000 }, async () => {
  await launch();
  await ollamaOnFake();
  // Opened and shown before the panel (a tab shown with the panel open is given to the agent); the user stays on « Page ici ».
  const win = (await state(m)).windows[0]!.id;
  const tabOf = async (title: string) => {
    await expect.poll(async () => Object.values((await state(m)).tabs).some((t) => t.title === title), { timeout: 20_000 }).toBe(true);
    return Object.values((await state(m)).tabs).find((t) => t.title === title)!.id;
  };
  const ids: string[] = [];
  for (const [path, title] of [["/lue", "Page citee"], ["/autre", "Page voisine"], ["/ici", "Page ici"]] as const) {
    await dispatch(m, { type: "openTab", windowId: win, url: `${site.url}${path}`, agentReached: false });
    ids.push(await tabOf(title));
  }
  const [cited, other, here] = ids as [string, string, string];
  await click(m, '[data-testid="agent-button"]');
  await expect.poll(() => read(join(w!.dataDir, "workspace", "fake-chat-claude.jsonl")).includes('"argv"'), { timeout: 30_000 }).toBe(true);
  // /agent: « Votre modèle » in a new discussion; it has no terminal, so /terminal is offered but unavailable.
  await type("/agent ");
  await pick("own");
  await waitAgent("return doc.querySelector('[data-testid=\"chat-mode-chip\"]')?.textContent.includes('Votre modèle') && !!doc.querySelector('[data-testid=\"chat-input\"]')");
  await inputIs("");
  await typeText(m, "/term");
  await expect.poll(offKeys, { timeout: 10_000 }).toEqual(["terminal"]);
  for (let i = 0; i < 5; i++) await pressKeys(m, "Backspace");
  await inputIs("");

  const seen: string[] = [];
  fake.script = [
    () => ({ action: "read_tab", id: cited }),
    (last) => (seen.push(last), { action: "read_tab", id: other }),
    (last) => (seen.push(last), { action: "answer", text: "Fin des lectures." }),
  ];
  await typeText(m, "@ong");
  await pick("tab");
  await inputIs("@onglet ");
  await typeText(m, "citee");
  await pick(cited);
  await typeText(m, "@pa");
  await pick("page");
  await inputIs("");
  expect(await textOf("chat-ref")).toMatch(/Page citee[\s\S]*Page ici/);
  await typeText(m, "lis");
  await pressKeys(m, "Enter");
  await inputIs("");
  // The pointed tab read with no card: the loop went on to its next step on its own.
  await expect.poll(() => seen.length, { timeout: 30_000 }).toBe(1);
  expect(seen[0]).toContain("Contenu de Page citee");
  // The user's message named both, with their ids.
  const user = JSON.stringify(loopSteps()[0]!.body.messages.filter((x: { role: string }) => x.role === "user"));
  expect(user).toContain(`\\"tab\\":\\"${cited}\\"`);
  expect(user).toContain(`\\"tab\\":\\"${here}\\"`);
  // The other tab still asks (its card shows on that tab): refused, the model reads the refusal.
  await dispatch(m, { type: "activateTab", id: other });
  await waitUi(m, "return doc.querySelector(arguments[0])?.textContent.includes('L\\'agent veut lire')", [CARD], 30_000);
  await click(m, `${CARD} button`, { text: "Refuser" });
  await agentSays("Fin des lectures.");
  expect(seen[1]).toContain("Accès refusé");
});
