import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * The approval log: one line when a card goes up (why it was asked), one when it comes down (how it was answered), keyed
 * by the same id. Kinds, rules and places only: never a page's text, a query string, a typed text or a value.
 */

/** Who asks: set per MCP request (window, engine, chat, mode) and per tool call (tool). */
export type AskScope = { window?: string | null; agent?: string; chat?: string | null; mode?: string; tool?: string };
export const askScope = new AsyncLocalStorage<AskScope>();

export type AskAnswer = "allow-once" | "allow-conversation" | "refuse" | "dismissed" | "timeout";
export type AskOpened = {
  id: string;
  ts: string;
  kind: string;
  rule: string;
  tool: string | null;
  agent: string | null;
  mode: string | null;
  window: string | null;
  chat: string | null;
  site: string | null;
  path: string | null;
};
export type AskClosed = { id: string; ts: string; answer: AskAnswer; ms: number };
export type AskLine = AskOpened | AskClosed;
export type AskSink = (line: AskLine) => void;

/** Chrome's card delay (core/agent/bridge QUESTION_DELAY_MS): a no that took this long is the card lapsing. */
export const ASK_TIMEOUT_MS = 120_000;
/** The cards whose one « yes » holds for the conversation (their button says so). */
const CONVERSATION_KINDS = new Set(["widget-data", "action-data", "site-app", "history", "mask-devtools"]);
const PATH_MAX = 120;

/**
 * A path segment that may carry an id, a token, an address or a masked label is replaced by `:x` (route-style): the path
 * says where the card was asked, never what was in it.
 */
const SECRETISH = /\d{4,}|@|%40|⟨|[A-Za-z0-9_-]{24,}/;

/** The site and path of `url` (no query, no fragment, id-like segments blanked); nulls for no web address. */
export function placeOf(url: string | undefined): { site: string | null; path: string | null } {
  if (!url || !URL.canParse(url)) return { site: null, path: null };
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") return { site: u.protocol + "//" + u.host, path: null };
  let raw: string;
  try {
    raw = decodeURIComponent(u.pathname);
  } catch {
    raw = u.pathname;
  }
  const path = raw.split("/").map((s) => (SECRETISH.test(s) ? ":x" : s)).join("/").slice(0, PATH_MAX);
  return { site: u.host, path };
}

/**
 * Runs `card` (the bridge call that puts it up) with its two log lines when `sink` is set. `yes`: the answer was an allow;
 * `signal`: aborted, a no is the card taken down (new conversation, call dropped). A failing sink never touches the card.
 * `url` is given only when its path may be logged (an address with a red line is not: its path may carry the value).
 */
export async function noted<T>(
  sink: AskSink | undefined,
  note: { kind: string; rule: string; url?: string },
  card: () => Promise<T>,
  yes: (v: T) => boolean,
  signal?: AbortSignal,
): Promise<T> {
  if (!sink) return card();
  const s = askScope.getStore() ?? {};
  const id = randomUUID();
  const start = Date.now();
  const write = (l: AskLine) => {
    try {
      sink(l);
    } catch (e) {
      console.error("[ressac] approval log:", e);
    }
  };
  write({ id, ts: new Date(start).toISOString(), kind: note.kind, rule: note.rule, tool: s.tool ?? null, agent: s.agent ?? null, mode: s.mode ?? null, window: s.window ?? null, chat: s.chat ?? null, ...placeOf(note.url) });
  let answer: AskAnswer = "dismissed";
  try {
    const v = await card();
    const ms = Date.now() - start;
    answer = yes(v) ? (CONVERSATION_KINDS.has(note.kind) ? "allow-conversation" : "allow-once") : signal?.aborted ? "dismissed" : ms >= ASK_TIMEOUT_MS ? "timeout" : "refuse";
    return v;
  } finally {
    write({ id, ts: new Date().toISOString(), answer, ms: Date.now() - start });
  }
}
