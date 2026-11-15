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

/** The `codex` arguments and environment for the chosen engine. The API key never appears here: `api` and `ollama` go through the relay. */
export function codexEngineArgs(e: CodexEngine, relay: { url: string; token: string } | null): { args: string[]; env: Record<string, string> } {
  if (!CodexEngineSchema.safeParse(e).success) throw incomplete(e.kind === "api" ? "api" : "ollama");
  if (e.kind === "chatgpt") return { args: [], env: {} };
  if (e.kind === "ollama") {
    if (!e.ollamaUrl || !e.ollamaModel) throw incomplete("ollama");
    href(e.ollamaUrl, "ollama");
    if (!relay) throw incomplete("ollama");
    return { args: [...provider("ressac-ollama", "Ollama", new URL(relay.url).href.replace(/\/$/, "")), "-m", e.ollamaModel], env: { [ENGINE_TOKEN_VARIABLE]: relay.token } };
  }
  if (!e.apiUrl || !e.apiModel) throw incomplete("api");
  href(e.apiUrl, "api");
  if (apiUrlProblem(e.apiUrl)) throw new Error(hostSay("host-engine-in-settings", { problem: hostSay("host-engine-url-invalid") }));
  if (!relay) throw new Error(NO_KEY());
  return { args: [...provider("ressac-api", "API compatible", new URL(relay.url).href.replace(/\/$/, "")), "-m", e.apiModel], env: { [ENGINE_TOKEN_VARIABLE]: relay.token } };
}
