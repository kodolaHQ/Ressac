// The « Votre modèle » engine: a loop in the host. The model picks one action per step under a JSON schema; the loop calls
// that tool on the kernel's MCP server with the session's own token (the server checks it again against HOST_AGENT_TOOLS).
// Model text is never executed: it is parsed as JSON, its action must be in the enum, its fields picked from a table.
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HOST_AGENT_TOOLS, type HostLaunch } from "@ressac/kernel";
import type { ChatItem } from "../../../shared/chat";
import type { ModelClient, ModelMessage } from "../../../host/own-model";
import { engineEvents, openedTab, toolTitle, type ChatEngine, type EngineConversation } from "./engine";
import { OWN_PROMPTS } from "./own-prompts";

export const STEP_MAX = 10;
export const TURN_MS = 300_000;
export const RESULT_MAX = 6000;
export const CONTEXT_TOKENS = 16384;
const PRUNE_AT = 0.75 * CONTEXT_TOKENS;
const CHARS_PER_TOKEN = 3.5;
// Control characters except \t and \n.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// No square bracket (nor look-alike: fullwidth, vertical, white) survives in a result: page text can never form a delimiter.
// No NFKC: it would turn « 1½ » into « 11⁄2 » and « m² » into « m2 ».
const OPEN = /[\[⟦〚［﹇]/g;
const CLOSE = /[\]⟧〛］﹈]/g;
/** Page-made text the model gets: no control character, no square bracket. */
const sanitize = (s: string) => s.replace(CONTROL, "").replace(OPEN, "(").replace(CLOSE, ")");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const prompts = Object.values(OWN_PROMPTS);
const opens = prompts.map((p) => p.resultOf("\0").split("\n"));
const HEAD = opens.map(([h]) => escape(h!).replace("\0", "\\S+")).join("|");
const START = opens.map(([, o]) => escape(o!)).join("|");
const END = prompts.map((p) => escape(p.end)).join("|");
const RESULT_BLOCK = new RegExp(`(?:(?:${HEAD})\\s*)?(?:${START})[\\s\\S]*?(?:${END}|$)`, "g");
const RESULT_MARK = new RegExp(`${HEAD}|${START}|${END}`, "g");

/** The answer without the tool-result frames a model may echo; a frame-only answer keeps its text. */
export function stripResults(text: string): string {
  return text.replace(RESULT_BLOCK, "").trim() || text.replace(RESULT_MARK, "").trim();
}

/** Flat, as the 13 Nov spike measured it: one action from the enum, every argument optional. */
export const ACTION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...HOST_AGENT_TOOLS, "answer"] },
    text: { type: "string" },
    id: { type: "string" },
    url: { type: "string" },
    link: { type: "integer", minimum: 0 },
    query: { type: "string" },
    goal: { type: "string" },
    urls: { type: "array", items: { type: "string" } },
    links: { type: "boolean" },
    full: { type: "boolean" },
    reason: { type: "string" },
    kind: { type: "string", enum: ["verification", "lost"] },
    limit: { type: "integer" },
  },
  required: ["action"],
} as const;

/** The fields each action passes on; anything else the model writes is dropped. */
const FIELDS: Record<string, string[]> = {
  current_page: [],
  list_tabs: [],
  read_tab: ["id", "links", "full"],
  navigate: ["id", "url", "link", "reason"],
  open_tab: ["url", "reason"],
  search_web: ["query", "goal"],
  read_pages: ["urls", "reason"],
  hand_over: ["id", "reason", "kind"],
  search_history: ["query", "limit"],
  read_history: ["url"],
  search_bookmarks: ["query", "limit"],
  answer: ["text"],
};

const fieldOk = (name: string, v: unknown): boolean => {
  const p = ACTION_SCHEMA.properties[name as keyof typeof ACTION_SCHEMA.properties] as { type: string; enum?: readonly string[]; minimum?: number };
  if (p.type === "integer") return Number.isInteger(v) && (p.minimum === undefined || (v as number) >= p.minimum);
  if (p.type === "array") return Array.isArray(v) && v.every((x) => typeof x === "string");
  return typeof v === p.type && (!p.enum || p.enum.includes(v as string));
};

/** The action and its arguments, or null when the reply is not exactly one valid JSON action (fences and prose fail). */
export function parseAction(content: string): { action: string; args: Record<string, unknown> } | null {
  let o: unknown;
  try {
    o = JSON.parse(content.trim());
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const fields = typeof r.action === "string" && Object.hasOwn(FIELDS, r.action) ? FIELDS[r.action]! : null;
  if (!fields) return null;
  const args: Record<string, unknown> = {};
  for (const f of fields) {
    if (r[f] === undefined || r[f] === null) continue;
    if (!fieldOk(f, r[f])) return null;
    args[f] = r[f];
  }
  if (r.action === "answer" && typeof args.text !== "string") return null;
  // A small model puts the search words in another field: query takes the model's own text (search_web: or its goal).
  // Ids, urls, hand_over's reason and kind are never guessed: the kernel refuses them and the model sees why.
  if (fields.includes("query") && !(typeof args.query === "string" && args.query.trim())) {
    const q = [r.text, r.action === "search_web" ? args.goal : undefined].find((v) => typeof v === "string" && v.trim());
    if (q !== undefined) args.query = q;
  }
  if (r.action === "read_pages" && args.urls === undefined && typeof r.url === "string") args.urls = [r.url];
  return { action: r.action as string, args };
}

export interface McpLike {
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** An MCP client on the host session's own token. Tools that wait for the user send heartbeats: they keep the call alive. */
export async function connectMcp(launch: HostLaunch): Promise<McpLike> {
  const client = new Client({ name: "ressac-own", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(launch.url), {
      requestInit: { headers: { Authorization: `Bearer ${launch.token}` }, redirect: "error" },
    }),
  );
  return {
    async call(name, args, signal) {
      const r = await client.callTool({ name, arguments: args }, undefined, { signal, onprogress: () => {}, resetTimeoutOnProgress: true, maxTotalTimeout: TURN_MS });
      const content = Array.isArray(r.content) ? (r.content as { type: string; text?: string }[]) : [];
      return { text: content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n"), isError: r.isError === true };
    },
    close: () => client.close(),
  };
}

export interface OwnOpen {
  model: ModelClient;
  locale: "fr" | "en";
  /** The paused discussion's items: its user and agent turns become the history. */
  transcript?: ChatItem[];
  /** Host texts (own-bad-format, own-steps, own-timeout). */
  texts: { badFormat: string; steps: string; timeout: string };
  mcp?: (l: HostLaunch) => Promise<McpLike>;
}

export const ownEngine: ChatEngine<HostLaunch, OwnOpen> = {
  id: "own",

  async open({ launch, signal, tabTitle, model, locale, transcript, texts, mcp: connect }): Promise<EngineConversation> {
    const events = engineEvents(launch);
    const { emit } = events;
    const t = OWN_PROMPTS[locale];
    let mcp: McpLike;
    try {
      mcp = await (connect ?? connectMcp)(launch);
      if (signal.aborted) {
        await mcp.close().catch(() => {});
        throw new Error("aborted");
      }
    } catch (e) {
      await launch.stop().catch(() => {}); // the connect error is the one to show
      throw e;
    }

    const messages: ModelMessage[] = [{ role: "system", content: t.system }];
    /** The user's turns (not the results, also sent as user messages): where an exchange starts, for pruning. */
    const turns = new WeakSet<ModelMessage>();
    /** The running turn's question: pruning never goes past it. */
    let current: ModelMessage | null = null;
    for (const i of transcript ?? []) {
      if (i.kind === "user") turns.add(messages[messages.push({ role: "user", content: i.text }) - 1]!);
      // As the live loop stores its answers: a prose turn would teach the model to leave the format.
      else if (i.kind === "agent") messages.push({ role: "assistant", content: JSON.stringify({ action: "answer", text: i.text }) });
    }
    /** Tool results still in `messages`, oldest first, for pruning. */
    const results: { msg: ModelMessage; tool: string }[] = [];
    let promptTokens: number | null = null;

    let turn: AbortController | null = null;
    let closed = false;
    let stopping: Promise<void> | null = null;
    let ended = false;
    const end = (error: string) => {
      if (ended) return;
      ended = true;
      launch.ended();
      events.end({ code: null, error });
    };

    // The last reply's count leaves out the newest result: the 25 % above the threshold holds one (6000 characters).
    // Old results go first, never the newest (the model must see what it just read); then the oldest whole exchanges,
    // never the running turn, so a long discussion never overflows num_ctx or a small-context API.
    const prune = () => {
      let used = promptTokens ?? messages.reduce((n, m) => n + m.content.length, 0) / CHARS_PER_TOKEN;
      while (used > PRUNE_AT && results.length > 1) {
        const { msg, tool } = results.shift()!;
        const removed = t.removed(tool);
        used -= (msg.content.length - removed.length) / CHARS_PER_TOKEN;
        msg.content = removed;
      }
      while (used > PRUNE_AT && messages[1] && messages[1] !== current) {
        do {
          const m = messages.splice(1, 1)[0]!;
          used -= m.content.length / CHARS_PER_TOKEN;
          const r = results.findIndex((x) => x.msg === m);
          if (r >= 0) results.splice(r, 1);
        } while (messages[1] && messages[1] !== current && !turns.has(messages[1]));
      }
    };

    /** One model call, with one correction retry when the reply is not a valid action. */
    const ask = async (s: AbortSignal, last: boolean) => {
      prune();
      const asked = last ? [...messages.slice(0, -1), { ...messages.at(-1)!, content: `${messages.at(-1)!.content}\n\n${t.lastStep}` }] : messages;
      const first = await model.step(asked, ACTION_SCHEMA, s);
      s.throwIfAborted(); // a client that answered after cancel
      promptTokens = first.promptTokens;
      const a = parseAction(first.content);
      if (a) return { ...a, content: first.content };
      const again = await model.step([...asked, { role: "assistant", content: first.content }, { role: "user", content: t.correction }], ACTION_SCHEMA, s);
      s.throwIfAborted();
      promptTokens = again.promptTokens;
      const b = parseAction(again.content);
      return b && { ...b, content: again.content };
    };

    /** The kernel's line on the user's tab (its read rules, its masking), quoted as page data; none when it is not shared. */
    const tabLine = async (s: AbortSignal) => {
      const r = await mcp.call("active_tab", {}, s).catch(() => null);
      const [id, title, address] = r && !r.isError ? r.text.split("\n") : [];
      return id && title !== undefined && address ? `${t.activeTab(sanitize(id), sanitize(title).replace(/[«»"]/g, "'"), sanitize(address))}\n\n` : "";
    };

    const run = async (text: string, ac: AbortController) => {
      current = { role: "user", content: (await tabLine(ac.signal)) + text };
      turns.add(current);
      messages.push(current);
      for (let step = 0; step < STEP_MAX; step++) {
        const a = await ask(ac.signal, step === STEP_MAX - 1);
        if (!a) return emit({ type: "turn_end", stopReason: "error", error: texts.badFormat });
        if (a.action === "answer") {
          messages.push({ role: "assistant", content: a.content });
          emit({ type: "agent_message", messageId: randomUUID(), text: stripResults(a.args.text as string) });
          return emit({ type: "turn_end", stopReason: "end_turn" });
        }
        if (step === STEP_MAX - 1) break;
        if (a.action === "search_web" && typeof a.args.goal !== "string") a.args.goal = text;
        messages.push({ role: "assistant", content: a.content });
        const toolCallId = randomUUID();
        emit({ type: "tool_call", toolCallId, ...toolTitle(a.action, a.args, { tabTitle }), status: "in_progress" });
        let r: { text: string; isError: boolean };
        try {
          r = await mcp.call(a.action, a.args, ac.signal);
        } catch (e) {
          emit({ type: "tool_call_update", toolCallId, status: "failed" });
          throw e;
        }
        emit({ type: "tool_call_update", toolCallId, status: r.isError ? "failed" : "completed", ...(r.isError ? {} : openedTab(a.action, r.text)) });
        const clean = sanitize(r.text);
        const body = clean.length > RESULT_MAX ? `${clean.slice(0, RESULT_MAX)}\n${t.cut}` : clean;
        const msg: ModelMessage = { role: "user", content: `${t.resultOf(a.action)}\n${body}\n${t.end}` };
        messages.push(msg);
        results.push({ msg, tool: a.action });
      }
      emit({ type: "turn_end", stopReason: "max_turns", error: texts.steps });
    };

    return {
      engineSessionId: "",
      prompt(text) {
        if (closed || ended) return;
        const ac = (turn = new AbortController());
        let late = false;
        const timer = setTimeout(() => {
          late = true;
          ac.abort();
        }, TURN_MS);
        run(text, ac)
          .catch((e: unknown) => {
            if (late) return emit({ type: "turn_end", stopReason: "max_turns", error: texts.timeout });
            if (ac.signal.aborted) return emit({ type: "turn_end", stopReason: "cancelled" });
            const error = e instanceof Error ? e.message : String(e);
            emit({ type: "turn_end", stopReason: "error", error });
            // The kernel closed the session: its token no longer works, the conversation is over.
            if ((e as { code?: unknown })?.code === 401) end(error);
          })
          .finally(() => {
            clearTimeout(timer);
            if (turn === ac) turn = null;
          });
      },
      cancel() {
        turn?.abort();
      },
      answer() {},
      close() {
        closed = true;
        turn?.abort();
        return (stopping ??= (async () => {
          await mcp.close().catch(() => {});
          await launch.stop();
        })());
      },
      onUpdate: events.onUpdate,
      onEnd: events.onEnd,
    };
  },
};
