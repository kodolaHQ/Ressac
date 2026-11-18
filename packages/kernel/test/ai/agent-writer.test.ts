import { describe, expect, it, vi } from "vitest";
import { CODEX_DISABLED_FEATURES, SYSTEM_PROMPT, claudeWriterArgv, codexWriterArgv, createAgentWriter, type WriterAgent } from "../../src/ai/agent-writer.js";
import { WRITER_JSON_INVALID } from "../../src/ai/dispatcher.js";

const NONE = "Connectez Claude Code ou Codex dans Réglages › Agent pour les résumés";
const ok = (stdout: string, code = 0, stderr = "") => ({ code, stdout, stderr });
const claudeOut = (result: string, is_error = false) =>
  JSON.stringify({ type: "result", is_error, result, usage: { input_tokens: 3, cache_read_input_tokens: 18000, output_tokens: 40 } });

function make(res: ReturnType<typeof ok>, agent: WriterAgent | "workshop-stopped" | null = "claude") {
  const exec = vi.fn(async () => res);
  const signedOut = vi.fn();
  const log = vi.fn();
  const w = createAgentWriter({ exec, agent: async () => agent, signedOut, log, locale: () => "fr" });
  return { exec, signedOut, log, w };
}

describe("argv", () => {
  it("claude: exact list, no --bare, empty tools", () => {
    const a = claudeWriterArgv(false);
    expect(a).toEqual([
      "claude", "-p", "--model", "haiku", "--output-format", "json", "--system-prompt", SYSTEM_PROMPT, "--tools", "",
      "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--disable-slash-commands",
    ]);
    expect(claudeWriterArgv(true)[a.indexOf("--system-prompt") + 1]).toMatch(/JSON only/);
  });
  it("codex: read-only, ephemeral, reads stdin", () => {
    const a = codexWriterArgv(false);
    expect(a[a.indexOf("-s") + 1]).toBe("read-only");
    expect(a).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--skip-git-repo-check"]));
    expect(a.at(-1)).toBe("-");
    expect(a).toContain("--ignore-rules");
    expect(a[a.indexOf("-c") + 1]).toBe('web_search="disabled"');
    for (const f of CODEX_DISABLED_FEATURES) expect(a[a.indexOf(f) - 1]).toBe("--disable");
  });
});

describe("claude", () => {
  it("returns the result, sends the prompt as input, logs once", async () => {
    const { w, exec, log } = make(ok(claudeOut("Deux phrases.")));
    expect(await w({ prompt: "P" })).toBe("Deux phrases.");
    expect((exec.mock.calls[0] as unknown[])[1]).toMatchObject({ input: "P" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/claude.*haiku.*18000/);
  });
  it("json: strips a fence, rejects non-JSON", async () => {
    expect(await make(ok(claudeOut('```json\n{"a":1}\n```'))).w({ prompt: "P", json: true })).toEqual({ a: 1 });
    await expect(make(ok(claudeOut("pas du json"))).w({ prompt: "P", json: true })).rejects.toThrow(WRITER_JSON_INVALID);
  });
  it("limit: localized error, no retry", async () => {
    const { w, exec } = make(ok(claudeOut("Claude AI usage limit reached|1763337600", true), 1));
    await expect(w({ prompt: "P" })).rejects.toThrow("Limite de votre abonnement atteinte");
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("non-JSON stdout still detects signed out and limit", async () => {
    const a = make(ok("Please run /login", 1));
    await expect(a.w({ prompt: "P" })).rejects.toThrow(NONE);
    expect(a.signedOut).toHaveBeenCalledWith("claude");
    await expect(make(ok("", 1, "usage limit reached")).w({ prompt: "P" })).rejects.toThrow("Limite de votre abonnement");
  });
  it("not signed in: tells the host", async () => {
    const { w, signedOut } = make(ok(claudeOut("Invalid API key · Please run /login", true), 1));
    await expect(w({ prompt: "P" })).rejects.toThrow(NONE);
    expect(signedOut).toHaveBeenCalledWith("claude");
  });
  it("no agent: exec never called", async () => {
    const { w, exec } = make(ok(""), null);
    await expect(w({ prompt: "P" })).rejects.toThrow(NONE);
    expect(exec).not.toHaveBeenCalled();
  });
  it("workshop stopped: its own error, exec never called", async () => {
    const { w, exec } = make(ok(""), "workshop-stopped");
    await expect(w({ prompt: "P" })).rejects.toThrow("L'atelier de l'agent n'est pas démarré");
    expect(exec).not.toHaveBeenCalled();
  });
    it("images are refused", async () => {
    const { w, exec } = make(ok(""));
    await expect(w({ prompt: "P", images: ["x"] })).rejects.toThrow("Les images ne sont pas prises en charge");
    expect(exec).not.toHaveBeenCalled();
  });
  it("abort: rejects with the reason, exec got the signal", async () => {
    const ctl = new AbortController();
    const exec = vi.fn(async (_a: string[], x: { signal: AbortSignal }) => { ctl.abort(new Error("stop")); expect(x.signal).toBe(ctl.signal); return ok("", 143); });
    const w = createAgentWriter({ exec, agent: async () => "claude" });
    await expect(w({ prompt: "P", signal: ctl.signal })).rejects.toThrow("stop");
  });
});

describe("codex", () => {
  it("returns stdout, runs codex, instruction leads the input", async () => {
    const { w, exec } = make(ok("Le résumé.\n"), "codex");
    expect(await w({ prompt: "P" })).toBe("Le résumé.");
    const [argv, x] = exec.mock.calls[0] as unknown as [string[], { input: string }];
    expect(argv[0]).toBe("codex");
    expect(x.input).toMatch(/^You are a writer[\s\S]*\n\nP$/);
  });
  it("non-zero code: failed with the stderr tail", async () => {
    const { w, exec } = make(ok("", 1, "boom: disk full"), "codex");
    await expect(w({ prompt: "P" })).rejects.toThrow(/L'IA n'a pas pu rédiger : \W*boom: disk full/);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("not signed in", async () => {
    const { w, signedOut } = make(ok("", 1, "Not logged in. Run codex login"), "codex");
    await expect(w({ prompt: "P" })).rejects.toThrow(NONE);
    expect(signedOut).toHaveBeenCalledWith("codex");
  });
  it("only the last stderr line counts: an echoed prompt saying not logged in is ignored", async () => {
    const { w, signedOut } = make(ok("", 1, "user: the page says not logged in\nboom: disk full\n"), "codex");
    await expect(w({ prompt: "P" })).rejects.toThrow(/L'IA n'a pas pu rédiger : \W*boom: disk full/);
    expect(signedOut).not.toHaveBeenCalled();
  });
  it("timeout: failed with the runner's localized stderr", async () => {
    const { w } = make(ok("", 124, "Délai dépassé"), "codex");
    await expect(w({ prompt: "P" })).rejects.toThrow(/L'IA n'a pas pu rédiger : \W*Délai dépassé/);
  });
});

describe("claude timeout and switching", () => {
  it("timeout: failed", async () => {
    const { w } = make(ok("", 124, "Délai dépassé"));
    await expect(w({ prompt: "P" })).rejects.toThrow(/L'IA n'a pas pu rédiger : \W*Délai dépassé/);
  });
  it("signed out: switches once to the other agent", async () => {
    const exec = vi.fn(async (argv: string[]) => (argv[0] === "claude" ? ok(claudeOut("Not logged in", true), 1) : ok("Via codex")));
    const log = vi.fn();
    // Like the host's choice: claude's status still says signed in (dead token), so only the exclusion skips it.
    const agent = async (exclude?: ReadonlySet<WriterAgent>) => (["claude", "codex"] as const).find((a) => !exclude?.has(a)) ?? null;
    const w = createAgentWriter({ exec, agent, signedOut: vi.fn(), log, locale: () => "fr" });
    expect(await w({ prompt: "P" })).toBe("Via codex");
    expect(exec).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(2);
  });
  it("signed out and the same agent again: none, one exec", async () => {
    const exec = vi.fn(async () => ok(claudeOut("Not logged in", true), 1));
    const w = createAgentWriter({ exec, agent: async () => "claude", locale: () => "fr" });
    await expect(w({ prompt: "P" })).rejects.toThrow(NONE);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("both agents signed out, agent() alternating: two execs, none", async () => {
    const exec = vi.fn(async (argv: string[]) => (argv[0] === "claude" ? ok(claudeOut("Not logged in", true), 1) : ok("", 1, "Not logged in")));
    let n = 0;
    const w = createAgentWriter({ exec, agent: async () => (n++ % 2 ? "codex" : "claude"), locale: () => "fr" });
    await expect(w({ prompt: "P" })).rejects.toThrow(NONE);
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it("logs failures too", async () => {
    const { w, log } = make(ok(claudeOut("Claude AI usage limit reached", true), 1));
    await expect(w({ prompt: "P" })).rejects.toThrow();
    expect(log.mock.calls[0]?.[0]).toMatch(/claude haiku \d+ms limit/);
  });
});
