import { describe, expect, it, vi } from "vitest";
import { claudeWriterArgv, codexWriterArgv, createAgentWriter, type WriterAgent } from "../../src/ai/agent-writer.js";
import { WRITER_JSON_INVALID } from "../../src/ai/dispatcher.js";

const NONE = "Connectez Claude Code ou Codex dans Réglages › Agents pour les résumés";
const ok = (stdout: string, code = 0, stderr = "") => ({ code, stdout, stderr });
const claudeOut = (result: string, is_error = false) =>
  JSON.stringify({ type: "result", is_error, result, usage: { input_tokens: 3, cache_read_input_tokens: 18000, output_tokens: 40 } });

function make(res: ReturnType<typeof ok>, agent: WriterAgent | null = "claude") {
  const exec = vi.fn(async () => res);
  const signedOut = vi.fn();
  const log = vi.fn();
  const w = createAgentWriter({ exec, agent: async () => agent, signedOut, log, locale: () => "fr" });
  return { exec, signedOut, log, w };
}

describe("argv", () => {
  it("claude: exact list, no --bare, empty tools", () => {
    const a = claudeWriterArgv(false);
    expect(a.slice(0, 6)).toEqual(["claude", "-p", "--model", "haiku", "--output-format", "json"]);
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--setting-sources") + 1]).toBe("");
    expect(a).toContain("--strict-mcp-config");
    expect(a).toContain("--no-session-persistence");
    expect(a).toContain("--disable-slash-commands");
    expect(a).not.toContain("--bare");
    expect(a).not.toContain("--mcp-config");
    expect(claudeWriterArgv(true)[a.indexOf("--system-prompt") + 1]).toMatch(/JSON only/);
  });
  it("codex: read-only, ephemeral, reads stdin", () => {
    const a = codexWriterArgv(false);
    expect(a[a.indexOf("-s") + 1]).toBe("read-only");
    expect(a).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--skip-git-repo-check"]));
    expect(a.at(-1)).toBe("-");
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
});
