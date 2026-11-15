import { describe, expect, it } from "vitest";
import { listOllamaModels, ollamaRelayTarget } from "../host/ollama-models";

const DOWN = { ok: false, error: "Ollama ne répond pas à cette adresse." };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const fake = (r: () => Promise<Response>) => {
  const urls: string[] = [];
  return { urls, fetch: ((u: string) => (urls.push(u), r())) as unknown as typeof fetch };
};

describe("listOllamaModels", () => {
  it("reads the container-side address through the host loopback, sorted, with sizes", async () => {
    const f = fake(async () => json({ models: [{ name: "b:7b", details: { parameter_size: "7B" } }, { name: "a:latest" }, { name: "bad name!" }] }));
    expect(await listOllamaModels("http://host.docker.internal:11434", { fetch: f.fetch })).toEqual({ ok: true, models: [{ name: "a:latest" }, { name: "b:7b", size: "7B" }] });
    expect(f.urls).toEqual(["http://127.0.0.1:11434/api/tags"]);
  });
  it("keeps a path prefix, drops /v1, refuses redirects", async () => {
    const urls: string[] = [];
    const seen: RequestInit[] = [];
    const f = ((u: string, i: RequestInit) => (urls.push(u), seen.push(i), Promise.resolve(json({ models: [] })))) as unknown as typeof fetch;
    await listOllamaModels("http://h:1/ollama/v1/", { fetch: f });
    expect(urls).toEqual(["http://h:1/ollama/api/tags"]);
    expect(seen[0]!.redirect).toBe("error");
  });
  it("an empty list is ok", async () => {
    expect(await listOllamaModels("http://localhost:11434", { fetch: fake(async () => json({ models: [] })).fetch })).toEqual({ ok: true, models: [] });
  });
  it("a non-JSON body, a 500 or a timeout is an unreachable Ollama", async () => {
    expect(await listOllamaModels("http://h:1", { fetch: fake(async () => new Response("<html>")).fetch })).toEqual(DOWN);
    expect(await listOllamaModels("http://h:1", { fetch: fake(async () => json({}, 500)).fetch })).toEqual(DOWN);
    const hang = ((_u: string, i: RequestInit) => new Promise((_, rej) => i.signal!.addEventListener("abort", () => rej(new Error("t"))))) as unknown as typeof fetch;
    expect(await listOllamaModels("http://h:1", { fetch: hang, timeoutMs: 20 })).toEqual(DOWN);
  });
  it("refuses a non-http address without fetching", async () => {
    const f = fake(async () => json({ models: [] }));
    expect(await listOllamaModels("file:///etc", { fetch: f.fetch })).toEqual({ ok: false, error: "Adresse invalide" });
    expect(await listOllamaModels("nope", { fetch: f.fetch })).toEqual({ ok: false, error: "Adresse invalide" });
    expect(f.urls).toEqual([]);
  });
});

describe("ollamaRelayTarget", () => {
  it("maps the container alias to loopback, keeps a LAN address, fits each agent's wire path", () => {
    expect(ollamaRelayTarget("http://host.docker.internal:11434", "claude")).toBe("http://127.0.0.1:11434");
    expect(ollamaRelayTarget("http://host.docker.internal:11434/v1/", "claude")).toBe("http://127.0.0.1:11434");
    expect(ollamaRelayTarget("http://host.docker.internal:11434", "codex")).toBe("http://127.0.0.1:11434/v1");
    expect(ollamaRelayTarget("http://192.168.1.5:11434/v1", "codex")).toBe("http://192.168.1.5:11434/v1");
    expect(ollamaRelayTarget("http://192.168.1.5:11434/", "claude")).toBe("http://192.168.1.5:11434");
  });
});
