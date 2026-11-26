import { withoutV1 } from "./claude-engine.ts";
import type { Keychain } from "./keychain.ts";
import { hostSay } from "./locale.ts";
import { apiUrlProblem, ollamaCloudHost, onMacUrl as onMac, remoteHost, type OwnEngine } from "../shared/settings.ts";

export type ModelMessage = { role: "system" | "user" | "assistant"; content: string };
/** One model reply for the loop (core/agent/chat/own.ts). `promptTokens`: the reply's own prompt count, null when absent. */
export interface ModelClient {
  step(messages: ModelMessage[], schema: object, signal: AbortSignal): Promise<{ content: string; promptTokens: number | null }>;
}

/** The Ollama base for the host's requests: loopback only (`localhost` → 127.0.0.1), no trailing /v1 or slash. */
export function ollamaBase(url: string): string {
  const u = onMac(url);
  if (!u) throw new Error(hostSay("own-url-refused"));
  if (u.hostname === "localhost") u.hostname = "127.0.0.1";
  return u.origin + withoutV1(u.pathname).replace(/\/$/, "");
}

/** A server's own error line, without control characters, capped (and without the key, which some servers echo). */
const cleaned = (said: unknown, key?: string | null): string =>
  typeof said === "string" ? (key ? said.split(key).join("…") : said).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 200) : "";

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
    const error = cleaned(((await res.json().catch(() => null)) as { error?: unknown } | null)?.error);
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

/** The API base as typed (https, or http on this Mac), without a trailing slash. */
function apiBase(url: string): string {
  if (apiUrlProblem(url)) throw new Error(hostSay("host-engine-url-invalid"));
  return url.replace(/\/+$/, "");
}

/** The saved API key and the origin (scheme, host, port) it was saved for: it is sent to that origin only. */
export type OwnKey = { secret: string; origin: string };
/** The saved key with its origin; a key without one is never sent (null). */
export async function readOwnKey(kc: Pick<Keychain, "read" | "origin">): Promise<OwnKey | null> {
  const [secret, origin] = await Promise.all([kc.read(), kc.origin()]);
  return secret && origin ? { secret, origin } : null;
}

/** The key's secret when it belongs to `base`'s origin; `elsewhere`: the line saying it was not sent (a key saved for another address). */
function keyFor(base: string, k: OwnKey | null): { secret: string | null; elsewhere: string | null } {
  const u = new URL(base);
  if (!k) return { secret: null, elsewhere: null };
  if (k.origin === u.origin) return { secret: k.secret, elsewhere: null };
  let saved = k.origin;
  try {
    saved = new URL(k.origin).host;
  } catch {
    // shown as stored
  }
  return { secret: null, elsewhere: hostSay("own-key-elsewhere", { saved, host: u.host }) };
}
/** Throws when a key is saved for another address: the key is not sent, and asking without it would only fail later. */
function keyOrThrow(base: string, k: OwnKey | null): string | null {
  const { secret, elsewhere } = keyFor(base, k);
  if (elsewhere) throw new Error(elsewhere);
  return secret;
}

const authorization = (key: string | null): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

/** A 400/422 that refuses the structured-output mode (the ladder steps down), not any other 400. */
const FORMAT_REFUSED = /response_format|json_schema|json_object/i;
/** A 400/422 that keeps its body for the caller to read, with the error to throw if it does not step around it. */
type ApiReply = { ok: true; body: unknown } | { ok: false; text: string; error: Error };

/**
 * POSTs to `<base>/chat/completions` with the key only toward that base (no redirect). A network failure is « unreachable »,
 * 401/403 « key refused », 404 or `model_not_found` « model missing »; no error text holds the key.
 */
async function apiPost(e: OwnEngine, key: string | null, body: object, signal: AbortSignal, f: typeof fetch): Promise<ApiReply> {
  const base = apiBase(e.apiUrl);
  const host = new URL(base).host;
  let res: Response;
  try {
    res = await f(base + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...authorization(key) }, body: JSON.stringify(body), redirect: "error", signal });
  } catch (err) {
    if (signal.aborted && signal.reason?.name === "AbortError") throw err;
    throw new Error(hostSay("own-unreachable", { host }));
  }
  if (res.ok) return { ok: true, body: await res.json().catch(() => null) };
  const text = await res.text().catch(() => "");
  if (res.status === 401 || res.status === 403) throw new Error(hostSay("own-key-refused", { host, status: res.status }));
  if (res.status === 404 || text.includes("model_not_found")) throw new Error(hostSay("own-model-missing", { model: e.apiModel, host }));
  let said: unknown;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    said = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message);
  } catch {
    said = undefined;
  }
  const line = cleaned(said, key);
  const error = new Error(line ? hostSay("own-server-error", { host, error: line }) : hostSay("own-unreachable", { host }));
  if (res.status === 400 || res.status === 422) return { ok: false, text, error };
  throw error;
}

/**
 * What works for each `${base} ${model}`, found by trying, for the app run. `mode`: 0 json_schema, 1 json_object, 2 none.
 * `limit`: newer OpenAI models refuse `max_tokens` and name `max_completion_tokens` instead; `temperature`: reasoning ones refuse it.
 * Each refusal moves one field one way, so the loop ends.
 */
const found = new Map<string, { mode: number; limit: "max_tokens" | "max_completion_tokens"; temperature: boolean }>();
/** For tests: forgets what was found. */
export const resetOwnModelCache = () => found.clear();

/** Modes 1 and 2 carry the schema in the system message (prepended when there is none). */
function withSchema(messages: ModelMessage[], schema: object): ModelMessage[] {
  const line = `Answer with one JSON object only, matching this JSON schema: ${JSON.stringify(schema)}`;
  return messages[0]?.role === "system" ? [{ role: "system", content: `${messages[0].content}\n\n${line}` }, ...messages.slice(1)] : [{ role: "system", content: line }, ...messages];
}

/** An OpenAI-compatible API (`/chat/completions`), local or remote. `key` is read at each step (the host caches it). Nothing of the content is logged. */
export function openAiClient(e: OwnEngine, o: { key: () => Promise<OwnKey | null>; fetch?: typeof fetch }): ModelClient {
  return {
    async step(messages, schema, signal) {
      try {
        const base = apiBase(e.apiUrl);
        const id = `${base} ${e.apiModel}`;
        const key = keyOrThrow(base, await o.key());
        const now = { ...(found.get(id) ?? { mode: 0, limit: "max_tokens" as const, temperature: true }) };
        for (;;) {
          const response_format = [{ type: "json_schema", json_schema: { name: "action", schema, strict: false } }, { type: "json_object" }, undefined][now.mode];
          const body = { model: e.apiModel, messages: now.mode ? withSchema(messages, schema) : messages, ...(now.temperature ? { temperature: 0 } : {}), [now.limit]: 2048, response_format };
          const r = await apiPost(e, key, body, signal, o.fetch ?? fetch);
          if (!r.ok) {
            if (now.mode < 2 && FORMAT_REFUSED.test(r.text)) now.mode++;
            else if (now.limit === "max_tokens" && r.text.includes("max_completion_tokens")) now.limit = "max_completion_tokens";
            else if (now.temperature && r.text.includes("temperature")) now.temperature = false;
            else throw r.error;
            continue;
          }
          found.set(id, now);
          const reply = r.body as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown } } | null;
          const content = reply?.choices?.[0]?.message?.content;
          if (typeof content !== "string") throw new Error(hostSay("own-bad-format"));
          return { content, promptTokens: typeof reply?.usage?.prompt_tokens === "number" ? reply.usage.prompt_tokens : null };
        }
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        throw err;
      }
    },
  };
}

/**
 * The API's model list (`GET <base>/models`, no redirect), sorted; any failure → the « type it » line. The key goes only to
 * its own origin: for another address the list is asked without it, and `keyNotSent` says so.
 */
export async function listOwnModels(
  e: OwnEngine,
  o: { key: OwnKey | null; fetch?: typeof fetch },
): Promise<({ ok: true; models: string[] } | { ok: false; error: string }) & { keyNotSent?: string }> {
  let notice: { keyNotSent?: string } = {};
  try {
    const base = apiBase(e.apiUrl);
    const { secret, elsewhere } = keyFor(base, o.key);
    if (elsewhere) notice = { keyNotSent: elsewhere };
    const res = await (o.fetch ?? fetch)(base + "/models", { headers: authorization(secret), redirect: "error", signal: AbortSignal.timeout(5000) });
    const data = res.ok ? ((await res.json()) as { data?: unknown }).data : null;
    if (!Array.isArray(data)) throw new Error("no list");
    return { ok: true, models: data.map((m: { id?: unknown }) => m?.id).filter((id): id is string => typeof id === "string").sort(), ...notice };
  } catch {
    return { ok: false, error: hostSay("own-models-failed"), ...notice };
  }
}

/**
 * Throws the French line when the chosen model cannot be used (checked at save and at every open). Resolves to the host the
 * messages go to when the model is off this Mac (a remote API, an Ollama cloud model), else null.
 */
export async function checkOwnModel(e: OwnEngine, o: { key: OwnKey | null; fetch?: typeof fetch }): Promise<string | null> {
  if (e.kind === "api") {
    // A tiny completion, the only check every compatible server answers the same way (some have no /models/<id>).
    // No output limit: newer models refuse `max_tokens`, older servers `max_completion_tokens`.
    const key = keyOrThrow(apiBase(e.apiUrl), o.key);
    const r = await apiPost(e, key, { model: e.apiModel, messages: [{ role: "user", content: "Reply OK." }] }, AbortSignal.timeout(15_000), o.fetch ?? fetch);
    if (!r.ok) throw r.error;
    return remoteHost(e.apiUrl);
  }
  const res = await ollamaPost(e, "/api/show", { model: e.ollamaModel }, AbortSignal.timeout(5000), o.fetch ?? fetch);
  const shown = (await res.json().catch(() => null)) as { remote_host?: unknown; remote_model?: unknown } | null;
  // A cloud model (pulled as `…-cloud`) answers from its remote host behind the loopback address.
  return ollamaCloudHost(shown);
}
