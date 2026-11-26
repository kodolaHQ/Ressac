import { beforeEach, describe, expect, it } from "vitest";
import { isOnMac, onLan, remoteHost } from "../shared/settings";
import { checkOwnModel, listOwnModels, ollamaBase, ollamaClient, openAiClient, resetOwnModelCache } from "../host/own-model";
import { DEFAULT_OWN_ENGINE, type OwnEngine } from "../shared/settings";

const REFUSED = "Adresse refusée : pour une adresse hors de votre Mac, choisissez « API compatible OpenAI ».";
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const engine = (o: Partial<OwnEngine> = {}): OwnEngine => ({ ...DEFAULT_OWN_ENGINE, ollamaModel: "qwen3:8b", ...o });
const capture = (r: () => Promise<Response>) => {
  const calls: { url: string; init: RequestInit }[] = [];
  return { calls, fetch: ((url: string, init: RequestInit) => (calls.push({ url, init }), r())) as unknown as typeof fetch };
};
const SCHEMA = { type: "object", properties: { action: { type: "string" } }, required: ["action"] };
const MESSAGES = [{ role: "user" as const, content: "Bonjour" }];
const ORIGIN = "https://api.example.com";
const own = (secret: string, origin = ORIGIN) => ({ secret, origin });
const ELSEWHERE = "La clé d'API enregistrée est liée à api.example.com : elle n'est pas envoyée à other.example.com. Enregistrez votre clé de nouveau pour cette adresse.";

describe("ollamaBase", () => {
  it("accepts only loopback", () => {
    expect(ollamaBase("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(ollamaBase("http://localhost:11434")).toBe("http://127.0.0.1:11434");
    expect(ollamaBase("http://[::1]:11434")).toBe("http://[::1]:11434");
    expect(ollamaBase("http://host.docker.internal:11434")).toBe("http://127.0.0.1:11434");
    for (const url of ["http://192.168.1.4:11434", "http://example.com", "http://127.0.0.1.example.com", "http://127.0.0.1@example.com", "http://user:pw@127.0.0.1:11434", "http://[::ffff:8.8.8.8]", "ftp://127.0.0.1", "not a url"])
      expect(() => ollamaBase(url), url).toThrow(REFUSED);
  });
  it("drops a trailing /v1, keeps a path prefix", () => {
    expect(ollamaBase("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(ollamaBase("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434");
    expect(ollamaBase("http://localhost:1/ollama/")).toBe("http://127.0.0.1:1/ollama");
  });
});

describe("isOnMac", () => {
  it("is true for loopback forms only", () => {
    for (const url of ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434", "http://host.docker.internal:11434", "http://localhost:8080/v1"]) expect(isOnMac(url), url).toBe(true);
    for (const url of ["https://api.deepseek.com/v1", "http://127.0.0.1.example.com", "not a url"]) expect(isOnMac(url), url).toBe(false);
  });
});

describe("remoteHost", () => {
  it("names the host off this Mac only", () => {
    expect(remoteHost("https://api.deepseek.com/v1")).toBe("api.deepseek.com");
    for (const url of ["http://localhost:8080/v1", "http://host.docker.internal:11434", "", "not a url"]) expect(remoteHost(url), url).toBeNull();
  });
});

describe("onLan", () => {
  it("a host on this Mac or the local network: its model is a local one (no fill)", () => {
    for (const h of ["192.168.1.20", "192.168.1.20:8443", "10.0.0.5", "172.16.0.1", "172.31.255.255", "169.254.3.4", "127.0.0.1:11434", "localhost", "[::1]", "[fd12::1]:443", "[fc00::2]", "nas.local", "NAS.LOCAL:8080", "[fe80::1]"]) expect(onLan(h), h).toBe(true);
    for (const h of ["ollama.com", "ollama.com:443", "api.deepseek.com", "172.32.0.1", "11.0.0.1", "192.169.0.1", "[2001:db8::1]", "local.example.com", "not a host/"]) expect(onLan(h), h).toBe(false);
  });
});

describe("ollamaClient", () => {
  it("ollama step sends the pinned request", async () => {
    const f = capture(async () => json({ message: { role: "assistant", content: '{"action":"answer"}' }, prompt_eval_count: 321 }));
    const r = await ollamaClient(engine({ ollamaUrl: "http://localhost:11434/v1" }), { fetch: f.fetch }).step(MESSAGES, SCHEMA, new AbortController().signal);
    expect(r).toEqual({ content: '{"action":"answer"}', promptTokens: 321 });
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({
      model: "qwen3:8b",
      stream: false,
      think: false,
      keep_alive: "1m",
      format: SCHEMA,
      options: { temperature: 0, num_ctx: 16384, num_predict: 2048 },
      messages: MESSAGES,
    });
  });
  it("promptTokens is null when Ollama gives no count", async () => {
    const f = capture(async () => json({ message: { content: "{}" } }));
    expect((await ollamaClient(engine(), { fetch: f.fetch }).step(MESSAGES, SCHEMA, new AbortController().signal)).promptTokens).toBeNull();
  });
  it("ollama step maps errors to their texts", async () => {
    const step = (r: () => Promise<Response>) => ollamaClient(engine(), { fetch: capture(r).fetch }).step(MESSAGES, SCHEMA, new AbortController().signal);
    await expect(step(() => Promise.reject(new TypeError("fetch failed")))).rejects.toThrow("127.0.0.1:11434 ne répond pas. Vérifiez l'adresse et que le serveur est lancé.");
    await expect(step(async () => json({ error: "model not found" }, 404))).rejects.toThrow("Le modèle « qwen3:8b » est introuvable sur 127.0.0.1:11434.");
    await expect(step(async () => new Response("<html>"))).rejects.toThrow("Le modèle n'a pas répondu dans le format attendu.");
    await expect(step(async () => json({ message: {} }))).rejects.toThrow("Le modèle n'a pas répondu dans le format attendu.");
    await expect(step(async () => json({ error: "model requires more system memory\n(9.1 GiB)" }, 500))).rejects.toThrow("127.0.0.1:11434 a répondu par une erreur : model requires more system memory (9.1 GiB)");
    await expect(step(async () => json({ error: "x".repeat(500) }, 500))).rejects.toThrow(/erreur : x{200}$/);
    await expect(step(async () => new Response("oops", { status: 500 }))).rejects.toThrow("127.0.0.1:11434 ne répond pas.");
  });
  it("an aborted step is an abort, whatever failed", async () => {
    const c = new AbortController();
    const f = (() => (c.abort(), Promise.reject(new TypeError("fetch failed")))) as unknown as typeof fetch;
    await expect(ollamaClient(engine(), { fetch: f }).step(MESSAGES, SCHEMA, c.signal)).rejects.toMatchObject({ name: "AbortError" });
    const g = (() => (c.abort(), Promise.resolve(new Response("<html>")))) as unknown as typeof fetch;
    await expect(ollamaClient(engine(), { fetch: g }).step(MESSAGES, SCHEMA, c.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("ollama step passes the abort signal", async () => {
    const hang = ((_u: string, i: RequestInit) => new Promise((_, rej) => i.signal!.addEventListener("abort", () => rej(i.signal!.reason)))) as unknown as typeof fetch;
    const c = new AbortController();
    const p = ollamaClient(engine(), { fetch: hang }).step(MESSAGES, SCHEMA, c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("checkOwnModel (Ollama)", () => {
  it("ollama check: missing, down", async () => {
    const check = (r: () => Promise<Response>) => checkOwnModel(engine(), { key: null, fetch: capture(r).fetch });
    await expect(check(async () => json({ error: "not found" }, 404))).rejects.toThrow("Le modèle « qwen3:8b » est introuvable sur 127.0.0.1:11434.");
    await expect(check(() => Promise.reject(new TypeError("fetch failed")))).rejects.toThrow("127.0.0.1:11434 ne répond pas.");
  });
  it("a cloud model passes, off this Mac: its remote host, ollama.com when only remote_model marks it", async () => {
    const check = (body: object) => checkOwnModel(engine(), { key: null, fetch: capture(async () => json(body)).fetch });
    expect(await check({ remote_model: "gpt-oss:120b", remote_host: "https://ollama.com:443" })).toBe("ollama.com");
    expect(await check({ remote_model: "m", remote_host: "https://eu.example.com:8443" })).toBe("eu.example.com:8443");
    expect(await check({ remote_model: "gpt-oss:120b", remote_host: "" })).toBe("ollama.com");
  });
  it("a cloud model as real Ollama shows it: no remote_host in /api/show, its /api/tags entry has it", async () => {
    const tags = (models: object[]) => (async (url: string) => (url.endsWith("/api/tags") ? json({ models }) : json({ details: {}, capabilities: ["completion"] }))) as unknown as typeof fetch;
    const cloud = engine({ ollamaModel: "deepseek-v4.1-flash:1017-cloud" });
    const entry = { name: "deepseek-v4.1-flash:1017-cloud", remote_model: "deepseek-v4.1-flash:1017", remote_host: "https://eu.example.com:8443" };
    expect(await checkOwnModel(cloud, { key: null, fetch: tags([{ name: "qwen3:8b" }, entry]) })).toBe("eu.example.com:8443");
    // A name without its tag is Ollama's « :latest ».
    expect(await checkOwnModel(engine({ ollamaModel: "gros" }), { key: null, fetch: tags([{ ...entry, name: "gros:latest" }]) })).toBe("eu.example.com:8443");
    // No host known (tags down, or the entry gone) on a cloud name: off the Mac, at ollama.com.
    expect(await checkOwnModel(cloud, { key: null, fetch: tags([]) })).toBe("ollama.com");
    // A local copy named like a cloud model (`ollama cp qwen3 qwen3-cloud`): its entry says nothing remote, so it is local.
    expect(await checkOwnModel(engine({ ollamaModel: "qwen3-cloud" }), { key: null, fetch: tags([{ name: "qwen3-cloud:latest" }]) })).toBeNull();
    expect(await checkOwnModel(engine({ ollamaModel: "gpt-oss:cloud" }), { key: null, fetch: (async (url: string) => (url.endsWith("/api/tags") ? json({}, 500) : json({}))) as unknown as typeof fetch })).toBe("ollama.com");
    // A local model stays on the Mac, even when another entry is a cloud one.
    expect(await checkOwnModel(engine(), { key: null, fetch: tags([{ name: "qwen3:8b" }, entry]) })).toBeNull();
  });
  it("asks /api/show for the model, without redirects, and passes a local model", async () => {
    const f = capture(async () => json({ details: { family: "qwen3" } }));
    expect(await checkOwnModel(engine({ ollamaUrl: "http://localhost:11434" }), { key: null, fetch: f.fetch })).toBeNull();
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:11434/api/show");
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ model: "qwen3:8b" });
    expect(f.calls[1]!.url).toBe("http://127.0.0.1:11434/api/tags");
    expect(f.calls[1]!.init.redirect).toBe("error");
  });
  it("refuses a non-loopback address without fetching", async () => {
    const f = capture(async () => json({}));
    await expect(checkOwnModel(engine({ ollamaUrl: "http://192.168.1.4:11434" }), { key: null, fetch: f.fetch })).rejects.toThrow(REFUSED);
    expect(f.calls).toEqual([]);
  });
});

describe("openAiClient", () => {
  beforeEach(() => resetOwnModelCache());
  const api = (o: Partial<OwnEngine> = {}) => engine({ kind: "api", apiUrl: "https://api.example.com/v1/", apiModel: "deepseek-chat", ...o });
  const reply = (content: string, usage: object | null = { prompt_tokens: 42 }) => json({ choices: [{ message: { role: "assistant", content } }], usage });
  const SYS = [{ role: "system" as const, content: "Rôle" }, ...MESSAGES];
  const run = (f: ReturnType<typeof capture>, key: string | null = "k", e = api()) => openAiClient(e, { key: async () => (key === null ? null : own(key)), fetch: f.fetch }).step(SYS, SCHEMA, new AbortController().signal);
  const body = (f: ReturnType<typeof capture>, i: number) => JSON.parse(f.calls[i]!.init.body as string);
  const refused = () => json({ error: { message: "response_format json_schema is not supported" } }, 400);

  it("api step tries json_schema first", async () => {
    const f = capture(async () => reply('{"action":"answer"}'));
    expect(await run(f)).toEqual({ content: '{"action":"answer"}', promptTokens: 42 });
    expect(f.calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(body(f, 0)).toEqual({ model: "deepseek-chat", messages: SYS, temperature: 0, max_tokens: 2048, response_format: { type: "json_schema", json_schema: { name: "action", schema: SCHEMA, strict: false } } });
    const g = capture(async () => reply("{}", null));
    expect((await run(g, null)).promptTokens).toBeNull();
    expect(Object.keys(g.calls[0]!.init.headers as object).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("api step falls back on a refused format", async () => {
    let n = 0;
    const f = capture(async () => (++n <= 2 ? refused() : reply("{}")));
    await run(f);
    expect(f.calls.length).toBe(3);
    expect(body(f, 1).response_format).toEqual({ type: "json_object" });
    expect(body(f, 1).messages[0].role).toBe("system");
    expect(body(f, 1).messages[0].content).toContain("Rôle");
    expect(body(f, 1).messages[0].content).toContain(JSON.stringify(SCHEMA));
    expect(body(f, 1).messages.slice(1)).toEqual(MESSAGES);
    expect(body(f, 2).response_format).toBeUndefined();
    expect(body(f, 2).messages[0].content).toContain(JSON.stringify(SCHEMA));
    await run(f);
    expect(f.calls.length).toBe(4);
    expect(body(f, 3).response_format).toBeUndefined();
    // Another model on the same base starts over.
    await run(f, "k", api({ apiModel: "other" }));
    expect(body(f, 4).response_format.type).toBe("json_schema");
  });

  it("an unrelated 400 is an error, not a downgrade", async () => {
    for (const message of ["context length exceeded", "Unsupported value: 'top_p' is not supported with this model."]) {
      const f = capture(async () => json({ error: { message } }, 400));
      await expect(run(f)).rejects.toThrow(`api.example.com a répondu par une erreur : ${message}`);
      expect(f.calls.length).toBe(1);
    }
  });

  it("a refused max_tokens moves to max_completion_tokens, once for the run", async () => {
    let n = 0;
    const f = capture(async () => (++n === 1 ? json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, 400) : reply("{}")));
    await run(f);
    await run(f);
    expect(f.calls.length).toBe(3);
    expect(body(f, 1)).toMatchObject({ max_completion_tokens: 2048, response_format: { type: "json_schema" } });
    expect(body(f, 1).max_tokens).toBeUndefined();
    expect(body(f, 2).max_completion_tokens).toBe(2048);
  });

  it("a reasoning model: max_tokens then temperature refused, both remembered for the run", async () => {
    const said = ["Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported."];
    let n = 0;
    const f = capture(async () => (n < 2 ? json({ error: { message: said[n++] } }, 400) : reply("{}")));
    await run(f);
    await run(f);
    expect(f.calls.length).toBe(4);
    for (const i of [2, 3]) {
      expect(body(f, i)).toMatchObject({ max_completion_tokens: 2048, response_format: { type: "json_schema" } });
      expect(Object.keys(body(f, i))).not.toContain("temperature");
    }
    // A refusal it cannot step around ends the loop as an error.
    resetOwnModelCache();
    const g = capture(async () => json({ error: { message: said[1] } }, 400));
    await expect(run(g)).rejects.toThrow("a répondu par une erreur");
    expect(g.calls.length).toBe(2);
  });

  it("the key goes to its own origin only", async () => {
    const f = capture(async () => reply("{}"));
    await expect(run(f, "k", api({ apiUrl: "https://other.example.com/v1" }))).rejects.toThrow(ELSEWHERE);
    await expect(run(f, "k", api({ apiUrl: "https://api.example.com:8443/v1" }))).rejects.toThrow("n'est pas envoyée à api.example.com:8443");
    expect(f.calls).toEqual([]);
  });

  it("a reply ignoring the format is not trusted", async () => {
    const f = capture(async () => reply("Bonjour, voici la réponse."));
    expect((await run(f)).content).toBe("Bonjour, voici la réponse.");
    await run(f);
    expect(body(f, 1).response_format.type).toBe("json_schema");
  });

  it("errors map to their texts", async () => {
    const KEY = "sk-secret-123";
    const step = (r: () => Promise<Response>) => run(capture(r), KEY);
    const cases: [() => Promise<Response>, string][] = [
      [() => Promise.reject(new TypeError("fetch failed")), "api.example.com ne répond pas. Vérifiez l'adresse et que le serveur est lancé."],
      [async () => json({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401), "api.example.com refuse la clé d'API (erreur 401)."],
      [async () => json({}, 403), "api.example.com refuse la clé d'API (erreur 403)."],
      [async () => json({ error: { message: "nope" } }, 404), "Le modèle « deepseek-chat » est introuvable sur api.example.com."],
      [async () => json({ error: { code: "model_not_found", message: "The model does not exist" } }, 400), "Le modèle « deepseek-chat » est introuvable sur api.example.com."],
      [async () => json({ error: { message: `bad key ${KEY} here` } }, 500), "api.example.com a répondu par une erreur : bad key … here"],
      [async () => json({ choices: [] }), "Le modèle n'a pas répondu dans le format attendu."],
    ];
    for (const [r, text] of cases) {
      const err = await step(r).catch((e: Error) => e);
      expect((err as Error).message, text).toBe(text);
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it("refuses a bad address without fetching; an aborted step is an abort", async () => {
    const f = capture(async () => reply("{}"));
    await expect(run(f, "k", api({ apiUrl: "http://192.168.1.4:8080/v1" }))).rejects.toThrow("Adresse invalide");
    expect(f.calls).toEqual([]);
    const c = new AbortController();
    const g = (() => (c.abort(), Promise.reject(new TypeError("fetch failed")))) as unknown as typeof fetch;
    await expect(openAiClient(api(), { key: async () => null, fetch: g }).step(SYS, SCHEMA, c.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("listOwnModels", () => {
  const api = engine({ kind: "api", apiUrl: "https://api.example.com/v1" });
  it("listOwnModels reads /models", async () => {
    const f = capture(async () => json({ data: [{ id: "b" }, { id: "a" }, { nope: 1 }] }));
    expect(await listOwnModels(api, { key: own("k"), fetch: f.fetch })).toEqual({ ok: true, models: ["a", "b"] });
    expect(f.calls[0]!.url).toBe("https://api.example.com/v1/models");
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    const failed = { ok: false, error: "La liste des modèles n'a pas pu être lue : saisissez le nom du modèle." };
    expect(await listOwnModels(api, { key: null, fetch: capture(async () => json({}, 401)).fetch })).toEqual(failed);
    expect(await listOwnModels(api, { key: null, fetch: capture(() => Promise.reject(new TypeError("x"))).fetch })).toEqual(failed);
    expect(await listOwnModels(api, { key: null, fetch: capture(async () => json({ data: "x" })).fetch })).toEqual(failed);
  });
  it("lists another address without the key, and says so", async () => {
    const f = capture(async () => json({ data: [{ id: "a" }] }));
    expect(await listOwnModels(engine({ kind: "api", apiUrl: "https://other.example.com/v1" }), { key: own("k"), fetch: f.fetch })).toEqual({ ok: true, models: ["a"], keyNotSent: ELSEWHERE });
    expect(f.calls[0]!.init.headers).toEqual({});
  });
});

describe("checkOwnModel (API)", () => {
  beforeEach(() => resetOwnModelCache());
  const api = engine({ kind: "api", apiUrl: "https://api.example.com/v1", apiModel: "deepseek-chat" });
  const check = (r: () => Promise<Response>) => checkOwnModel(api, { key: own("sk-check-key"), fetch: capture(r).fetch });
  it("api check: key refused, missing, down, ok", async () => {
    await expect(check(async () => json({}, 401))).rejects.toThrow("api.example.com refuse la clé d'API (erreur 401).");
    await expect(check(async () => json({}, 403))).rejects.toThrow("api.example.com refuse la clé d'API (erreur 403).");
    await expect(check(async () => json({}, 404))).rejects.toThrow("Le modèle « deepseek-chat » est introuvable sur api.example.com.");
    await expect(check(() => Promise.reject(new TypeError("fetch failed")))).rejects.toThrow("api.example.com ne répond pas.");
    const f = capture(async () => json({ choices: [{ message: { content: "o" } }] }));
    expect(await checkOwnModel(api, { key: null, fetch: f.fetch })).toBe("api.example.com");
    expect(f.calls[0]!.url).toBe("https://api.example.com/v1/chat/completions");
    const sent = JSON.parse(f.calls[0]!.init.body as string);
    expect(sent.model).toBe("deepseek-chat");
    expect(Object.keys(sent).filter((k) => k.startsWith("max_"))).toEqual([]);
  });
  it("api check: any refusing 400 is an error, never a pass", async () => {
    for (const message of ["Unsupported parameter: 'max_tokens' is not supported with this model.", "response_format is not supported"])
      await expect(check(async () => json({ error: { message } }, 400))).rejects.toThrow(`api.example.com a répondu par une erreur : ${message}`);
  });
  it("api check: a key saved for another address is not sent", async () => {
    const f = capture(async () => json({ choices: [{ message: { content: "o" } }] }));
    await expect(checkOwnModel(engine({ ...api, apiUrl: "https://other.example.com/v1" }), { key: own("k"), fetch: f.fetch })).rejects.toThrow(ELSEWHERE);
    expect(f.calls).toEqual([]);
    await checkOwnModel(api, { key: own("k"), fetch: f.fetch });
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });
});
