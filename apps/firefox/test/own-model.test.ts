import { describe, expect, it } from "vitest";
import { checkOwnModel, isOnMac, ollamaBase, ollamaClient } from "../host/own-model";
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
  it("ollama check: missing, cloud, down", async () => {
    const check = (r: () => Promise<Response>) => checkOwnModel(engine(), { key: null, fetch: capture(r).fetch });
    await expect(check(async () => json({ error: "not found" }, 404))).rejects.toThrow("Le modèle « qwen3:8b » est introuvable sur 127.0.0.1:11434.");
    await expect(check(async () => json({ remote_model: "gpt-oss:120b", remote_host: "https://ollama.com:443" }))).rejects.toThrow("Modèle en ligne d'Ollama : refusé ici. Pour un modèle hébergé, connectez son API.");
    await expect(check(() => Promise.reject(new TypeError("fetch failed")))).rejects.toThrow("127.0.0.1:11434 ne répond pas.");
  });
  it("asks /api/show for the model, without redirects, and passes a local model", async () => {
    const f = capture(async () => json({ details: { family: "qwen3" } }));
    await checkOwnModel(engine({ ollamaUrl: "http://localhost:11434" }), { key: null, fetch: f.fetch });
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:11434/api/show");
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ model: "qwen3:8b" });
  });
  it("refuses a non-loopback address without fetching", async () => {
    const f = capture(async () => json({}));
    await expect(checkOwnModel(engine({ ollamaUrl: "http://192.168.1.4:11434" }), { key: null, fetch: f.fetch })).rejects.toThrow(REFUSED);
    expect(f.calls).toEqual([]);
  });
});
