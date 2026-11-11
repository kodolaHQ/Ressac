import { apiUrlProblem, ClaudeEngineSchema, type ClaudeEngine } from "../shared/settings";
import { href, incomplete, NO_KEY } from "./codex-engine";

// Seen with the real CLI (plan 48 task 2): without the per-tier variables, the tier aliases and subagents ask for Anthropic model ids.
const MODEL_VARIABLES = ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"];

/** Claude Code appends `/v1/messages` itself: a trailing `/v1` on the address would double it. */
export const withoutV1 = (url: string) => url.replace(/\/v1\/?$/, "");

/** The container cannot reach the Mac's loopback: its alias is `host.docker.internal`. */
const forContainer = (url: string) => {
  const u = new URL(url);
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") u.hostname = "host.docker.internal";
  return u.href;
};

const env = (baseUrl: string, token: string, model: string) => ({
  ANTHROPIC_BASE_URL: baseUrl.replace(/\/$/, ""),
  ANTHROPIC_AUTH_TOKEN: token,
  ...Object.fromEntries(MODEL_VARIABLES.map((v) => [v, model])),
});

/** The `claude` environment for the chosen engine. The API key never appears here: `api` goes through the relay. */
export function claudeEngineEnv(e: ClaudeEngine, relay: { url: string; token: string } | null): { args: string[]; env: Record<string, string> } {
  if (!ClaudeEngineSchema.safeParse(e).success) throw incomplete(e.kind === "api" ? "l'API compatible" : "Ollama");
  if (e.kind === "subscription") return { args: [], env: {} };
  if (e.kind === "ollama") {
    if (!e.ollamaUrl || !e.ollamaModel) throw incomplete("Ollama");
    return { args: [], env: env(withoutV1(forContainer(href(e.ollamaUrl, "Ollama"))), "ollama", e.ollamaModel) };
  }
  if (!e.apiUrl || !e.apiModel) throw incomplete("l'API compatible");
  href(e.apiUrl, "l'API compatible");
  const bad = apiUrlProblem(e.apiUrl);
  if (bad) throw new Error(`${bad} (Réglages › Agents)`);
  if (!relay) throw new Error(NO_KEY);
  return { args: [], env: env(new URL(relay.url).href, relay.token, e.apiModel) };
}
