import { apiUrlProblem, ClaudeEngineSchema, type ClaudeEngine } from "../shared/settings";
import { href, incomplete, NO_KEY } from "./codex-engine";
import { hostSay } from "./locale.ts";

// Seen with the real CLI (plan 48 task 2): without the per-tier variables, the tier aliases and subagents ask for Anthropic model ids.
const MODEL_VARIABLES = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"];

/** Claude Code appends `/v1/messages` itself: a trailing `/v1` on the address would double it. */
export const withoutV1 = (url: string) => url.replace(/\/v1\/?$/, "");

const env = (baseUrl: string, token: string, model: string) => ({
  ANTHROPIC_BASE_URL: baseUrl.replace(/\/$/, ""),
  ANTHROPIC_AUTH_TOKEN: token,
  ...Object.fromEntries(MODEL_VARIABLES.map((v) => [v, model])),
});

/** Codex appends `/responses` or `/chat/completions` itself: its base address ends in `/v1`. */
export const withV1 = (url: string) => withoutV1(url).replace(/\/$/, "") + "/v1";

/** The `claude` environment for the chosen engine. The API key never appears here: `api` and `ollama` go through the relay. */
export function claudeEngineEnv(e: ClaudeEngine, relay: { url: string; token: string } | null): { args: string[]; env: Record<string, string> } {
  if (!ClaudeEngineSchema.safeParse(e).success) throw incomplete(e.kind === "api" ? "api" : "ollama");
  if (e.kind === "subscription") return { args: [], env: {} };
  if (e.kind === "ollama") {
    if (!e.ollamaUrl || !e.ollamaModel) throw incomplete("ollama");
    href(e.ollamaUrl, "ollama"); // validation only: the container never sees this address
    if (!relay) throw incomplete("ollama");
    // No CLAUDE_CODE_MAX_CONTEXT_TOKENS: at 32k, Claude Code's reserve for its answer and compaction leaves no room for its own
    // prompt (« context limit reached » at once, seen 2026-11-15); it assumes 1M and never compacts for an unknown model.
    return { args: [], env: env(new URL(relay.url).href, relay.token, e.ollamaModel) };
  }
  if (!e.apiUrl || !e.apiModel) throw incomplete("api");
  href(e.apiUrl, "api");
  if (apiUrlProblem(e.apiUrl)) throw new Error(hostSay("host-engine-in-settings", { problem: hostSay("host-engine-url-invalid") }));
  if (!relay) throw new Error(NO_KEY());
  return { args: [], env: env(new URL(relay.url).href, relay.token, e.apiModel) };
}
