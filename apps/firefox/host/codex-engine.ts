import { apiUrlProblem, CodexEngineSchema, type CodexEngine } from "../shared/settings";

export const ENGINE_TOKEN_VARIABLE = "RESSAC_ENGINE_TOKEN";
export const NO_KEY = "Aucune clé enregistrée pour l'API compatible (Réglages › Agents).";
export const incomplete = (who: string) => new Error(`Réglez l'adresse et le modèle ${/^[AEIOUH]/.test(who) ? "d'" : "de "}${who} dans Réglages › Agents.`);

const provider = (id: string, name: string, baseUrl: string) => [
  "-c", `model_provider=${JSON.stringify(id)}`,
  "-c", `model_providers.${id}={name=${JSON.stringify(name)},base_url=${JSON.stringify(baseUrl)},env_key=${JSON.stringify(ENGINE_TOKEN_VARIABLE)}}`,
];

export function href(url: string, who: string): string {
  try {
    return new URL(url).href;
  } catch {
    throw incomplete(who);
  }
}

/** The `codex` arguments and environment for the chosen engine. The API key never appears here: `api` goes through the relay. */
export function codexEngineArgs(e: CodexEngine, relay: { url: string; token: string } | null): { args: string[]; env: Record<string, string> } {
  if (!CodexEngineSchema.safeParse(e).success) throw incomplete(e.kind === "api" ? "l'API compatible" : "Ollama");
  if (e.kind === "chatgpt") return { args: [], env: {} };
  if (e.kind === "ollama") {
    if (!e.ollamaUrl || !e.ollamaModel) throw incomplete("Ollama");
    const base = href(e.ollamaUrl, "Ollama").replace(/\/$/, "") + "/v1";
    return { args: [...provider("ressac-ollama", "Ollama", base), "-m", e.ollamaModel], env: { [ENGINE_TOKEN_VARIABLE]: "ollama" } };
  }
  if (!e.apiUrl || !e.apiModel) throw incomplete("l'API compatible");
  href(e.apiUrl, "l'API compatible");
  const bad = apiUrlProblem(e.apiUrl);
  if (bad) throw new Error(`${bad} (Réglages › Agents)`);
  if (!relay) throw new Error(NO_KEY);
  return { args: [...provider("ressac-api", "API compatible", new URL(relay.url).href.replace(/\/$/, "")), "-m", e.apiModel], env: { [ENGINE_TOKEN_VARIABLE]: relay.token } };
}
