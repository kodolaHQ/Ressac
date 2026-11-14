import { apiUrlProblem, CodexEngineSchema, type CodexEngine } from "../shared/settings";
import { hostSay } from "./locale.ts";

export const ENGINE_TOKEN_VARIABLE = "RESSAC_ENGINE_TOKEN";
export const NO_KEY = () => hostSay("host-no-key");
export const incomplete = (who: "ollama" | "api") => new Error(hostSay(`host-engine-incomplete-${who}`));

const provider = (id: string, name: string, baseUrl: string) => [
  "-c", `model_provider=${JSON.stringify(id)}`,
  "-c", `model_providers.${id}={name=${JSON.stringify(name)},base_url=${JSON.stringify(baseUrl)},env_key=${JSON.stringify(ENGINE_TOKEN_VARIABLE)}}`,
];

export function href(url: string, who: "ollama" | "api"): string {
  try {
    return new URL(url).href;
  } catch {
    throw incomplete(who);
  }
}

/** The `codex` arguments and environment for the chosen engine. The API key never appears here: `api` goes through the relay. */
export function codexEngineArgs(e: CodexEngine, relay: { url: string; token: string } | null): { args: string[]; env: Record<string, string> } {
  if (!CodexEngineSchema.safeParse(e).success) throw incomplete(e.kind === "api" ? "api" : "ollama");
  if (e.kind === "chatgpt") return { args: [], env: {} };
  if (e.kind === "ollama") {
    if (!e.ollamaUrl || !e.ollamaModel) throw incomplete("ollama");
    const base = href(e.ollamaUrl, "ollama").replace(/\/$/, "") + "/v1";
    return { args: [...provider("ressac-ollama", "Ollama", base), "-m", e.ollamaModel], env: { [ENGINE_TOKEN_VARIABLE]: "ollama" } };
  }
  if (!e.apiUrl || !e.apiModel) throw incomplete("api");
  href(e.apiUrl, "api");
  const bad = apiUrlProblem(e.apiUrl);
  if (bad) throw new Error(hostSay("host-engine-in-settings", { problem: bad }));
  if (!relay) throw new Error(NO_KEY());
  return { args: [...provider("ressac-api", "API compatible", new URL(relay.url).href.replace(/\/$/, "")), "-m", e.apiModel], env: { [ENGINE_TOKEN_VARIABLE]: relay.token } };
}
