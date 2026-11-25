import { describe, expect, it, vi } from "vitest";
import { createHostWriter, createWriterChoice } from "../host/writer";
import { CODEX_WRITER_MODEL, SYSTEM_PROMPT } from "../../../packages/kernel/src/index.ts";
import { DEFAULT_CLAUDE_ENGINE, DEFAULT_CODEX_ENGINE, type ClaudeEngine, type CodexEngine } from "../shared/settings";

const setup = (state: string, loggedIn: Record<string, boolean>, preferred: "claude" | "codex" = "claude", harvestReady = true) => {
  const calls: string[] = [];
  let t = 0;
  const choice = createWriterChoice({
    workshop: {
      state: async () => state as never,
      harvestReady: async () => harvestReady,
      ensureStarted: async () => {
        calls.push("ensureStarted");
        state = "started";
        return "started";
      },
      exec: async (argv) => {
        calls.push(argv[0]!);
        const a = argv[0]!;
        return a === "claude"
          ? { code: 0, stdout: JSON.stringify({ loggedIn: loggedIn.claude }), stderr: "" }
          : { code: 0, stdout: loggedIn.codex ? "Logged in using ChatGPT" : "Not logged in", stderr: "" };
      },
    },
    preferred: () => preferred,
    now: () => t,
  });
  return { choice, calls, advance: (ms: number) => (t += ms) };
};

describe("writer choice", () => {
  it("takes the preferred agent when signed in", async () => {
    expect(await setup("started", { claude: true, codex: true }).choice.agent()).toBe("claude");
  });
  it("falls back to the other agent", async () => {
    expect(await setup("started", { claude: false, codex: true }).choice.agent()).toBe("codex");
  });
  it("skips the excluded agents even when their status says signed in (a dead token)", async () => {
    const s = setup("started", { claude: true, codex: true });
    expect(await s.choice.agent(new Set(["claude"]))).toBe("codex");
    expect(await s.choice.agent(new Set(["claude", "codex"]))).toBeNull();
  });
  it("is null when both are signed out", async () => {
    expect(await setup("started", {}).choice.agent()).toBeNull();
  });
  it("says the workshop is stopped, without exec, when it is not running", async () => {
    const s = setup("stopped", { claude: true });
    expect(await s.choice.agent()).toBe("workshop-stopped");
    expect(s.calls).toEqual([]);
  });
  it("a stopped machine: the display never starts it, a write does", async () => {
    const s = setup("machine-stopped", { claude: true });
    expect(await s.choice.agent()).toBe("workshop-stopped");
    expect(s.calls).toEqual([]);
    expect(await s.choice.wakeAgent()).toBe("claude");
    expect(s.calls).toEqual(["ensureStarted", "claude"]);
  });
  it("a background write never reinstalls a removed machine nor boots a failing one: it says the workshop is stopped", async () => {
    const s = setup("machine-stopped", { claude: true }, "claude", false);
    expect(await s.choice.wakeAgent()).toBe("workshop-stopped");
    expect(s.calls).toEqual([]);
  });
  it("a write waits at most a minute for the machine (a first image build takes minutes), then says it is stopped", async () => {
    vi.useFakeTimers();
    try {
      const choice = createWriterChoice({
        workshop: { state: async () => "machine-stopped" as never, harvestReady: async () => true, ensureStarted: () => new Promise(() => {}), exec: async () => ({ code: 1, stdout: "", stderr: "" }) },
        preferred: () => "claude",
      });
      const answer = choice.wakeAgent();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await answer).toBe("workshop-stopped");
    } finally {
      vi.useRealTimers();
    }
  });
  it("a write on a stopped Docker workshop does not start it", async () => {
    const s = setup("stopped", { claude: true });
    expect(await s.choice.wakeAgent()).toBe("workshop-stopped");
    expect(s.calls).toEqual([]);
  });
  it("does not keep a failed check, and shares one exec between parallel calls", async () => {
    let n = 0;
    const choice = createWriterChoice({
      workshop: { state: async () => "started" as never, harvestReady: async () => true, ensureStarted: async () => "started", exec: async (argv) => { if (argv[0] === "codex") return { code: 0, stdout: "Not logged in", stderr: "" }; n++; if (n === 1) throw new Error("boom"); return { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" }; } },
      preferred: () => "claude",
    });
    expect(await choice.agent()).toBeNull();
    const two = await Promise.all([choice.agent(), choice.agent()]);
    expect(two).toEqual(["claude", "claude"]);
    expect(n).toBe(2);
  });
  it("caches 5 minutes, then reset or signedOut check again", async () => {
    const s = setup("started", { claude: true });
    await s.choice.agent();
    await s.choice.agent();
    expect(s.calls).toEqual(["claude"]);
    s.choice.reset();
    await s.choice.agent();
    s.choice.signedOut("claude");
    await s.choice.agent();
    expect(s.calls).toHaveLength(3);
    s.advance(5 * 60_000 + 1);
    await s.choice.agent();
    expect(s.calls).toHaveLength(4);
  });
});

// A test key, not a secret: it must not leak into any error text.
const KEY = "test-key-camille-aubrac";
const hostWriter = (o: {
  claude?: Partial<ClaudeEngine>;
  codex?: Partial<CodexEngine>;
  keys?: Partial<Record<"claude" | "codex", string>>;
  signedIn?: Partial<Record<"claude" | "codex", boolean>>;
  preferred?: "claude" | "codex";
  answer?: (url: string) => Response;
}) => {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const cli = vi.fn(async () => "from the cli");
  const w = createHostWriter({
    preferred: () => o.preferred ?? "claude",
    engine: (a) => (a === "claude" ? { ...DEFAULT_CLAUDE_ENGINE, ...o.claude } : { ...DEFAULT_CODEX_ENGINE, ...o.codex }),
    readKey: async (a) => o.keys?.[a] ?? null,
    cli,
    cliUsable: async (a) => !!o.signedIn?.[a],
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return o.answer?.(url) ?? Response.json({});
    }) as typeof fetch,
    locale: () => "fr",
  });
  return { w, requests, cli };
};

describe("host writer", () => {
  it("Claude API uses Haiku on Anthropic and the user's model elsewhere", async () => {
    const answer = () => Response.json({ content: [{ type: "text", text: "Bon" }, { type: "text", text: "jour" }] });
    const a = hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com/v1", apiModel: "claude-opus" }, keys: { claude: KEY }, answer });
    expect(await a.w({ prompt: "P" })).toBe("Bonjour");
    expect(a.requests[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(a.requests[0]!.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
    expect(a.requests[0]!.body).toEqual({ model: "claude-haiku-4-5", max_tokens: 4096, system: SYSTEM_PROMPT, messages: [{ role: "user", content: "P" }] });
    const b = hostWriter({ claude: { kind: "api", apiUrl: "https://llm.example.com", apiModel: "mon-modele" }, keys: { claude: KEY }, answer });
    await b.w({ prompt: "P" });
    expect(b.requests[0]!.url).toBe("https://llm.example.com/v1/messages");
    expect(b.requests[0]!.body.model).toBe("mon-modele");
  });
  it("Codex API posts to /responses", async () => {
    const s = hostWriter({
      preferred: "codex",
      codex: { kind: "api", apiUrl: "https://api.openai.com/v1", apiModel: "gpt-big" },
      keys: { codex: KEY },
      answer: () => Response.json({ output: [{ content: [{ text: '```json\n{"a":1}\n```' }] }] }),
    });
    expect(await s.w({ prompt: "P", json: true })).toEqual({ a: 1 });
    expect(s.requests[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(s.requests[0]!.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(s.requests[0]!.body.model).toBe(CODEX_WRITER_MODEL);
    expect(s.requests[0]!.body.input).toBe("P");
    expect(s.requests[0]!.body.instructions.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(s.requests[0]!.body.instructions.length).toBeGreaterThan(SYSTEM_PROMPT.length);
  });
  it("Ollama posts format json when asked", async () => {
    const s = hostWriter({ claude: { kind: "ollama", ollamaUrl: "http://host.docker.internal:11434", ollamaModel: "gemma" }, answer: () => Response.json({ message: { content: '{"b":2}' } }) });
    expect(await s.w({ prompt: "P", json: true })).toEqual({ b: 2 });
    expect(s.requests[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(s.requests[0]!.body).toMatchObject({ model: "gemma", stream: false, keep_alive: "1m", format: "json", messages: [{ role: "system" }, { role: "user", content: "P" }] });
    await s.w({ prompt: "Q" });
    expect(s.requests[1]!.body.format).toBeUndefined();
  });
  it("no key falls back to the other agent's subscription", async () => {
    const s = hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, signedIn: { codex: true } });
    expect(await s.w({ prompt: "P" })).toBe("from the cli");
    expect(s.requests).toEqual([]);
    expect(await s.w.via()).toEqual({ agent: "codex", via: "subscription" });
    await expect(hostWriter({}).w({ prompt: "P" })).rejects.toThrow("Connectez Claude Code ou Codex");
  });
  it("429 reads as the limit", async () => {
    const s = hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, keys: { claude: KEY }, answer: () => new Response("", { status: 429 }) });
    await expect(s.w({ prompt: "P" })).rejects.toThrow("Limite de votre abonnement");
    const r = hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, keys: { claude: KEY }, answer: () => new Response("", { status: 401 }) });
    await expect(r.w({ prompt: "P" })).rejects.toThrow("clé refusée");
  });
  it("the key is in no error text", async () => {
    const s = hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, keys: { claude: KEY }, answer: () => new Response(`bad key ${KEY}`, { status: 500 }) });
    const e = (await s.w({ prompt: "P" }).catch((x: unknown) => x)) as Error;
    expect(e.message).toContain("500");
    expect(e.message).not.toContain(KEY);
    expect(String(e.stack)).not.toContain(KEY);
  });
  it("via() names the path", async () => {
    expect(await hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, keys: { claude: KEY } }).w.via()).toEqual({ agent: "claude", via: "api" });
    expect(await hostWriter({ preferred: "codex", codex: { kind: "ollama", ollamaModel: "gemma" } }).w.via()).toEqual({ agent: "codex", via: "ollama" });
    expect(await hostWriter({ signedIn: { claude: true } }).w.via()).toEqual({ agent: "claude", via: "subscription" });
    expect(await hostWriter({}).w.via()).toBeNull();
  });
  it("honours the caller's signal", async () => {
    const ctl = new AbortController();
    const w = createHostWriter({
      preferred: () => "claude",
      engine: () => ({ ...DEFAULT_CLAUDE_ENGINE, kind: "api", apiUrl: "https://api.anthropic.com" }),
      readKey: async () => KEY,
      cli: async () => "",
      cliUsable: async () => false,
      fetch: ((_u: string, init: RequestInit) => new Promise((_, no) => (init.signal!.aborted ? no(init.signal!.reason) : init.signal!.addEventListener("abort", () => no(init.signal!.reason))))) as typeof fetch,
      locale: () => "fr",
    });
    const p = w({ prompt: "P", signal: ctl.signal });
    ctl.abort(new Error("stopped by the caller"));
    await expect(p).rejects.toThrow("stopped by the caller");
  });
});
