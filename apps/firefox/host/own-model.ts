import { withoutV1 } from "./claude-engine.ts";
import { hostSay } from "./locale.ts";
import { macSideUrl } from "./ollama-models.ts";
import type { OwnEngine } from "../shared/settings.ts";

export type ModelMessage = { role: "system" | "user" | "assistant"; content: string };
/** One model reply for the loop (core/agent/chat/own.ts). `promptTokens`: the reply's own prompt count, null when absent. */
export interface ModelClient {
  step(messages: ModelMessage[], schema: object, signal: AbortSignal): Promise<{ content: string; promptTokens: number | null }>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The address parsed, with the container alias mapped to loopback, when it is on this Mac (exact hostname, no DNS); else null. */
function onMac(url: string): URL | null {
  try {
    const u = new URL(macSideUrl(url));
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password && LOOPBACK.has(u.hostname) ? u : null;
  } catch {
    return null;
  }
}

/** True when `url` points at this Mac (loopback): its model's traffic stays local. */
export const isOnMac = (url: string): boolean => onMac(url) !== null;

/** The Ollama base for the host's requests: loopback only (`localhost` → 127.0.0.1), no trailing /v1 or slash. */
export function ollamaBase(url: string): string {
  const u = onMac(url);
  if (!u) throw new Error(hostSay("own-url-refused"));
  if (u.hostname === "localhost") u.hostname = "127.0.0.1";
  return u.origin + withoutV1(u.pathname).replace(/\/$/, "");
}

/** POSTs JSON to Ollama; a network failure is « unreachable », a 404 « model missing » (both texts name the host). */
async function ollamaPost(e: OwnEngine, path: string, body: object, signal: AbortSignal, f: typeof fetch): Promise<Response> {
  const base = ollamaBase(e.ollamaUrl);
  const host = new URL(base).host;
  let res: Response;
  try {
    res = await f(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal });
  } catch (err) {
    if (signal.aborted && signal.reason?.name === "AbortError") throw err;
    throw new Error(hostSay("own-unreachable", { host }));
  }
  if (res.status === 404) throw new Error(hostSay("own-model-missing", { model: e.ollamaModel, host }));
  if (!res.ok) {
    // Ollama answers e.g. 500 « model requires more system memory »: it runs, so say what it said (cleaned, capped).
    const said = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
    const error = typeof said === "string" ? said.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 200) : "";
    throw new Error(error ? hostSay("own-server-error", { host, error }) : hostSay("own-unreachable", { host }));
  }
  return res;
}

/** The user's Ollama on this Mac. Nothing of the content is logged. */
export function ollamaClient(e: OwnEngine, o: { fetch?: typeof fetch } = {}): ModelClient {
  return {
    async step(messages, schema, signal) {
      try {
        const body = { model: e.ollamaModel, stream: false, think: false, keep_alive: "1m", format: schema, options: { temperature: 0, num_ctx: 16384, num_predict: 2048 }, messages };
        const res = await ollamaPost(e, "/api/chat", body, signal, o.fetch ?? fetch);
        const reply = (await res.json().catch(() => null)) as { message?: { content?: unknown }; prompt_eval_count?: unknown } | null;
        if (typeof reply?.message?.content !== "string") throw new Error(hostSay("own-bad-format"));
        return { content: reply.message.content, promptTokens: typeof reply.prompt_eval_count === "number" ? reply.prompt_eval_count : null };
      } catch (err) {
        // A cancelled turn is an abort, never a connection or format error.
        if (signal.aborted) throw signal.reason;
        throw err;
      }
    },
  };
}

/** Throws the French line when the chosen model cannot be used (checked at save and at every open). */
export async function checkOwnModel(e: OwnEngine, o: { key: string | null; fetch?: typeof fetch }): Promise<void> {
  if (e.kind !== "ollama") throw new Error("checkOwnModel: API kind not implemented"); // Task 4
  const res = await ollamaPost(e, "/api/show", { model: e.ollamaModel }, AbortSignal.timeout(5000), o.fetch ?? fetch);
  const shown = (await res.json().catch(() => null)) as { remote_host?: unknown; remote_model?: unknown } | null;
  // A cloud model (pulled as `…-cloud`) answers from ollama.com behind the loopback address.
  if (shown?.remote_host || shown?.remote_model) throw new Error(hostSay("own-ollama-cloud"));
}
