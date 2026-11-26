import { describe, expect, it, vi } from "vitest";
import { createHostWriter, createWriterChoice, type CliState } from "../host/writer";
import { CODEX_WRITER_MODEL, SYSTEM_PROMPT, say } from "../../../packages/kernel/src/index.ts";
import { DEFAULT_CLAUDE_ENGINE, DEFAULT_CODEX_ENGINE, type ClaudeEngine, type CodexEngine } from "../shared/settings";

const setup = (state: string, loggedIn: Record<string, boolean>, preferred: "claude" | "codex" = "claude", harvestReady = true, installed = ["claude", "codex"]) => {
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
    installed: async (a) => installed.includes(a),
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
  it("a CLI not downloaded is never exec'd: sign-in unknown, after a signed-in one", async () => {
    const s = setup("started", { claude: true, codex: true }, "claude", true, ["codex"]);
    expect(await s.choice.agent()).toBe("codex");
    expect(await s.choice.usable("claude")).toBe("wakeable");
    expect(s.calls).toEqual(["codex"]);
    const none = setup("started", {}, "claude", true, []);
    expect(await none.choice.agent()).toBe("claude");
    expect(await none.choice.agent(new Set(["claude"]))).toBeNull(); // the other agent's CLI is never downloaded
    expect(none.calls).toEqual([]);
  });
  it("only the preferred agent's CLI counts when not downloaded", async () => {
    const s = setup("started", { claude: false }, "claude", true, ["claude"]);
    expect(await s.choice.usable("codex")).toBe("signed-out");
    expect(await s.choice.agent()).toBeNull();
    expect(await setup("machine-stopped", {}, "claude", true, []).choice.usable("codex")).toBe("signed-out");
  });
  it("a CLI not downloaded: wakeable when the machine can wake, else stopped", async () => {
    const m = setup("machine-stopped", {}, "claude", true, []);
    expect(await m.choice.usable("claude")).toBe("wakeable");
    expect(await m.choice.wakeAgent()).toBe("claude");
    expect(m.calls).toEqual(["ensureStarted"]);
    expect(await setup("machine-stopped", {}, "claude", false, []).choice.usable("claude")).toBe("stopped");
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
        installed: async () => true,
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
      installed: async () => true,
    });
    expect(await choice.agent()).toBeNull();
    const two = await Promise.all([choice.agent(), choice.agent()]);
    expect(two).toEqual(["claude", "claude"]);
    expect(n).toBe(2);
  });
  it("usable: signed in or out when started, wakeable only when a write may start the machine, else stopped", async () => {
    expect(await setup("started", { claude: true }).choice.usable("claude")).toBe("signed-in");
    expect(await setup("started", { claude: false }).choice.usable("claude")).toBe("signed-out");
    const m = setup("machine-stopped", { claude: true });
    expect(await m.choice.usable("claude")).toBe("wakeable");
    expect(m.calls).toEqual([]);
    expect(await setup("machine-stopped", {}, "claude", false).choice.usable("claude")).toBe("stopped");
    expect(await setup("stopped", {}).choice.usable("claude")).toBe("stopped");
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
  clis?: Partial<Record<"claude" | "codex", CliState>>;
  preferred?: "claude" | "codex";
  answer?: (url: string, init: RequestInit) => Response | Promise<Response>;
  fetchFails?: Error;
}) => {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const cli = vi.fn((a: "claude" | "codex") => async () => `from the ${a} cli`);
  const w = createHostWriter({
    preferred: () => o.preferred ?? "claude",
    engine: (a) => (a === "claude" ? { ...DEFAULT_CLAUDE_ENGINE, ...o.claude } : { ...DEFAULT_CODEX_ENGINE, ...o.codex }),
    readKey: async (a) => o.keys?.[a] ?? null,
    cli,
    cliUsable: async (a) => o.clis?.[a] ?? "signed-out",
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      if (o.fetchFails) throw o.fetchFails;
      return (await o.answer?.(url, init)) ?? Response.json({});
    }) as typeof fetch,
    locale: () => "fr",
  });
  return { w, requests, cli };
};

describe("host writer", () => {
  it("a subscription CLI not downloaded yet: written via the subscription when the machine can wake, else the workshop text", async () => {
    for (const [harvestReady, expected] of [[true, "subscription"], [false, null]] as const) {
      const { choice, calls } = setup("machine-stopped", {}, "claude", harvestReady, []);
      const cli = vi.fn(() => async () => "ok");
      const w = createHostWriter({ preferred: () => "claude", engine: (a) => (a === "claude" ? DEFAULT_CLAUDE_ENGINE : DEFAULT_CODEX_ENGINE), readKey: async () => null, cli, cliUsable: choice.usable, locale: () => "fr" });
      if (expected) {
        expect(await w.via()).toEqual({ agent: "claude", via: "subscription" });
        expect(await w({ prompt: "P" })).toBe("ok");
      } else {
        expect(await w.via()).toBe("workshop-stopped");
        await expect(w({ prompt: "P" })).rejects.toThrow(say("fr", "kernel-writer-workshop-stopped"));
      }
      expect(calls.filter((c) => c !== "ensureStarted")).toEqual([]); // no status exec of a missing binary
    }
  });
  it("never downloads the other agent's CLI: preferred signed out, other not downloaded", async () => {
    const { choice } = setup("started", { claude: false }, "claude", true, ["claude"]);
    const cli = vi.fn(() => async () => "ok");
    const w = createHostWriter({ preferred: () => "claude", engine: (a) => (a === "claude" ? DEFAULT_CLAUDE_ENGINE : DEFAULT_CODEX_ENGINE), readKey: async () => null, cli, cliUsable: choice.usable, locale: () => "fr" });
    expect(await w.via()).toBeNull();
    await expect(w({ prompt: "P" })).rejects.toThrow(say("fr", "kernel-writer-none"));
    expect(cli).not.toHaveBeenCalled();
  });
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
    const s = hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, clis: { codex: "signed-in" } });
    expect(await s.w({ prompt: "P" })).toBe("from the codex cli");
    expect(s.requests).toEqual([]);
    expect(await s.w.via()).toEqual({ agent: "codex", via: "subscription" });
    await expect(hostWriter({}).w({ prompt: "P" })).rejects.toThrow("Connectez Claude Code ou Codex");
  });
  it("429 reads as the limit", async () => {
    const s = hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, keys: { claude: KEY }, answer: () => new Response("", { status: 429 }) });
    await expect(s.w({ prompt: "P" })).rejects.toThrow("Limite d'usage de votre clé d'API");
    const r = hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, keys: { claude: KEY }, answer: () => new Response("", { status: 401 }) });
    await expect(r.w({ prompt: "P" })).rejects.toThrow("clé refusée");
    const f = hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, keys: { claude: KEY }, answer: () => new Response("", { status: 403 }) });
    await expect(f.w({ prompt: "P" })).rejects.toThrow("clé refusée");
  });
  it("429 on a key or Ollama names the API limit, not the subscription", async () => {
    const s = hostWriter({ claude: { kind: "ollama", ollamaModel: "gemma" }, answer: () => new Response("", { status: 429 }) });
    await expect(s.w({ prompt: "P" })).rejects.toThrow("clé d'API ou de votre Ollama");
  });
  it("the key is in no error text", async () => {
    const s = hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, keys: { claude: KEY }, answer: () => new Response(`bad key ${KEY}`, { status: 500 }) });
    const e = (await s.w({ prompt: "P" }).catch((x: unknown) => x)) as Error;
    expect(e.message).toContain("500");
    expect(e.message).not.toContain(KEY);
    expect(String(e.stack)).not.toContain(KEY);
    const f = hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, keys: { claude: KEY }, fetchFails: new Error(`connect refused, header ${KEY}`) });
    const g = (await f.w({ prompt: "P" }).catch((x: unknown) => x)) as Error;
    expect(g.message).toContain("connect refused");
    expect(g.message).not.toContain(KEY);
  });
  it("a CLI of unknown sign-in yields to the other agent's key, and is taken when nothing else works", async () => {
    const s = hostWriter({ clis: { claude: "wakeable" }, codex: { kind: "api", apiUrl: "https://api.openai.com/v1" }, keys: { codex: KEY } });
    expect(await s.w.via()).toEqual({ agent: "codex", via: "api" });
    const t = hostWriter({ clis: { claude: "stopped", codex: "wakeable" } });
    expect(await t.w.via()).toEqual({ agent: "codex", via: "subscription" });
    expect(await t.w({ prompt: "P" })).toBe("from the codex cli");
  });
  it("a workshop that cannot start, with no key, says so", async () => {
    const s = hostWriter({ clis: { claude: "stopped", codex: "stopped" } });
    expect(await s.w.via()).toBe("workshop-stopped");
    await expect(s.w({ prompt: "P" })).rejects.toThrow("L'atelier de l'agent n'est pas démarré");
  });
  it("an unparsable Ollama address is not configured", async () => {
    const s = hostWriter({ claude: { kind: "ollama", ollamaUrl: "pas une adresse", ollamaModel: "gemma" } });
    expect(await s.w.via()).toBeNull();
    await expect(s.w({ prompt: "P" })).rejects.toThrow("Connectez Claude Code ou Codex");
  });
  it("a timeout or a stop during the body read is not swallowed; a non-JSON body is a failure", async () => {
    const slowBody = (_u: string, init: RequestInit) =>
      ({ ok: true, status: 200, json: () => new Promise((_, no) => init.signal!.addEventListener("abort", () => no(init.signal!.reason))) }) as unknown as Response;
    const timeout = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      const s = hostWriter({ claude: { kind: "ollama", ollamaModel: "gemma" }, answer: slowBody });
      const p = s.w({ prompt: "P" });
      await vi.waitFor(() => expect(s.requests).toHaveLength(1));
      timeout.abort(new DOMException("timed out", "TimeoutError"));
      await expect(p).rejects.toThrow("L'IA n'a pas pu rédiger : timed out");
    } finally {
      spy.mockRestore();
    }
    const ctl = new AbortController();
    const c = hostWriter({ claude: { kind: "ollama", ollamaModel: "gemma" }, answer: slowBody });
    const q = c.w({ prompt: "P", signal: ctl.signal });
    await vi.waitFor(() => expect(c.requests).toHaveLength(1));
    ctl.abort(new Error("stopped by the caller"));
    await expect(q).rejects.toThrow("stopped by the caller");
    const n = hostWriter({ claude: { kind: "ollama", ollamaModel: "gemma" }, answer: () => new Response("pas du json") });
    await expect(n.w({ prompt: "P" })).rejects.toThrow("L'IA n'a pas pu rédiger");
  });
  it("via() names the path", async () => {
    expect(await hostWriter({ claude: { kind: "api", apiUrl: "https://api.anthropic.com" }, keys: { claude: KEY } }).w.via()).toEqual({ agent: "claude", via: "api" });
    expect(await hostWriter({ preferred: "codex", codex: { kind: "ollama", ollamaModel: "gemma" } }).w.via()).toEqual({ agent: "codex", via: "ollama" });
    expect(await hostWriter({ clis: { claude: "signed-in" } }).w.via()).toEqual({ agent: "claude", via: "subscription" });
    expect(await hostWriter({}).w.via()).toBeNull();
  });
  it("honours the caller's signal", async () => {
    const ctl = new AbortController();
    const w = createHostWriter({
      preferred: () => "claude",
      engine: () => ({ ...DEFAULT_CLAUDE_ENGINE, kind: "api", apiUrl: "https://api.anthropic.com" }),
      readKey: async () => KEY,
      cli: () => async () => "",
      cliUsable: async () => "signed-out",
      fetch: ((_u: string, init: RequestInit) => new Promise((_, no) => (init.signal!.aborted ? no(init.signal!.reason) : init.signal!.addEventListener("abort", () => no(init.signal!.reason))))) as typeof fetch,
      locale: () => "fr",
    });
    const p = w({ prompt: "P", signal: ctl.signal });
    ctl.abort(new Error("stopped by the caller"));
    await expect(p).rejects.toThrow("stopped by the caller");
  });
});
