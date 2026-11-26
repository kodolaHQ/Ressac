// The chat's send pipeline (spec §5), engine-neutral: what the user wrote goes to the engine masked with the discussion's own
// table (R1), and to the outflow as typed or pasted, never before the discussion's kernel session exists.
import type { Masker } from "../../../packages/kernel/src/index.ts";
import type { Outflow } from "../../../packages/kernel/src/outflow/outflow.ts";
import type { TabInfo } from "../../../packages/kernel/src/mcp/bridge.ts";
import { LABEL_SOURCE } from "../../../packages/kernel/src/mask/table.ts";
import { referencesText } from "../../../packages/kernel/src/pty/context.ts";
import type { Chats } from "../core/agent/chats.ts";
import { CHAT_COMMANDS, COMMAND_WITH_TEXT, type ChatCommand, type ChatDraft, type ChatRef, type ChatView } from "../shared/chat.ts";

const LABEL = new RegExp(`^${LABEL_SOURCE}$`);
const LABELS = new RegExp(LABEL_SOURCE, "g");
/** A message longer than this is refused: a paste of a whole book is not a chat turn. */
export const DRAFT_MAX = 100_000;
/** @ references in one message, and a referenced page's title and address. */
const REFS_MAX = 10;
const REF_TITLE_MAX = 300;
const REF_URL_MAX = 2000;
const TAB_ID = /^[\w:-]{1,100}$/;

type SendMasker = Pick<Masker, "maskTypedFor" | "lookupForSession">;

/** The UI's draft, checked at the trust boundary: null when unusable. Ranges are clamped to the text, labels must be labels. */
export function cleanDraft(v: unknown): ChatDraft | null {
  const d = (v ?? {}) as Record<string, unknown>;
  if (typeof d.text !== "string" || d.text.length > DRAFT_MAX) return null;
  const command = CHAT_COMMANDS.find((c) => c === d.command);
  const refs: ChatRef[] = [];
  for (const r of (Array.isArray(d.refs) ? d.refs : []).slice(0, REFS_MAX) as Record<string, unknown>[]) {
    if (typeof r?.tab === "string" && TAB_ID.test(r.tab)) refs.push({ tab: r.tab });
    else if (typeof r?.url === "string" && typeof r.title === "string" && /^https?:\/\//.test(r.url) && r.url.length <= REF_URL_MAX) refs.push({ title: r.title.slice(0, REF_TITLE_MAX), url: r.url });
  }
  // Empty text goes only with references or a command that needs none.
  if (!d.text.trim() && !refs.length && !(command && !COMMAND_WITH_TEXT.has(command))) return null;
  const n = d.text.length;
  const int = (x: unknown) => (typeof x === "number" && Number.isInteger(x) ? Math.min(Math.max(x, 0), n) : null);
  const pasted: [number, number][] = [];
  for (const r of Array.isArray(d.pasted) ? d.pasted : []) {
    const [a, b] = Array.isArray(r) ? [int(r[0]), int(r[1])] : [null, null];
    if (a !== null && b !== null && a < b) pasted.push([a, b]);
  }
  const clear = (Array.isArray(d.clear) ? d.clear : []).filter((l): l is string => typeof l === "string" && LABEL.test(l));
  return { text: d.text, pasted, clear, ...(command ? { command } : {}), ...(refs.length ? { refs } : {}) };
}

/** The draft cut into its typed and pasted runs, in order. */
function segments(d: ChatDraft): { text: string; pasted: boolean }[] {
  const out: { text: string; pasted: boolean }[] = [];
  let at = 0;
  for (const [a, b] of [...d.pasted].sort((x, y) => x[0] - y[0])) {
    if (b <= at) continue;
    const start = Math.max(a, at);
    if (start > at) out.push({ text: d.text.slice(at, start), pasted: false });
    out.push({ text: d.text.slice(start, b), pasted: true });
    at = b;
  }
  if (at < d.text.length) out.push({ text: d.text.slice(at), pasted: false });
  return out;
}

/**
 * Spec §5 steps 1-3. `shown` (the transcript's text) keeps every label; `sent` (the engine's) has the labels the user
 * chose « en clair » put back, for this send only. `before`/`after` (the panel's context, ⌘T's pages) are masked with the
 * rest but are not the user's own text: never typed. Labels never join the typed exemption.
 */
export function prepareSend(o: { masker: SendMasker; sessionId: string; draft: ChatDraft; outflow: Pick<Outflow, "typed">; win: string; before?: string; after?: string }): { sent: string; shown: string } {
  const clear = new Set(o.draft.clear);
  const restore = (s: string) => s.replace(LABELS, (l) => (clear.has(l) ? (o.masker.lookupForSession(o.sessionId, l)?.value ?? l) : l));
  const shown = o.masker.maskTypedFor(o.sessionId, (o.before ?? "") + o.draft.text + (o.after ?? "")).text;
  // Each run masked on its own (the same table gives the same labels) to know what of it the user typed or pasted.
  // shortcut: a value split across a typed and a pasted run is masked in `sent` but its parts count as typed/pasted.
  for (const s of segments(o.draft)) {
    const piece = restore(o.masker.maskTypedFor(o.sessionId, s.text).text).replace(LABELS, "");
    if (piece) o.outflow.typed(o.win, piece, { pasted: s.pasted });
  }
  o.outflow.typed(o.win, "\r");
  return { sent: restore(shown), shown };
}

interface Waiting {
  win: string;
  draft: ChatDraft;
  before?: string;
  after?: string;
  /** Called as it is sent, after the session's reset (a tab given to the agent). */
  written?: () => void;
  /** The tabs the user pointed with @, as the host found them: readable by this session from its send. */
  points?: TabInfo[];
}

/** Ressac's own text waiting for the window's next message (never typed): the panel's context applies to a first message only. */
interface Prefix {
  text: string;
  firstOnly: boolean;
  written?: () => void;
}

/**
 * The host's send queue: a draft sent before its discussion's kernel session exists waits here (in memory only, never
 * written), and is masked once `flush` finds the session. The host calls `flush` on every view the discussion pushes.
 */
export function createChatSend(o: {
  chats: Pick<Chats, "sessionIdOf" | "prompt" | "select" | "active">;
  masker: () => SendMasker | null;
  outflow: () => Pick<Outflow, "typed"> | null;
  /** The user talked from this window: its active tab is given to the agent. */
  interacted: (win: string) => void;
  /** The window's new discussion, when it has none (⌘T). */
  create: (win: string) => Promise<ChatView>;
  /** The tabs the agent can see (none of a private space nor Ressac's own pages): a @ tab must be one of them. */
  tabs?: () => Promise<TabInfo[]>;
  /** The user pointed `tab` with @ in a message of session `session` (the kernel lets that session read it with no card). */
  point?: (session: string, tab: TabInfo) => void;
  /** The host's texts (the user's language): the command words, the references note, the refusal. */
  say?: (id: string) => string;
}) {
  const say = o.say ?? ((id: string) => id);
  const commandText = (c: ChatCommand) => `${say(`host-chat-command-${c}`)} `;
  const waiting = new Map<string, Waiting[]>();
  /** Ressac's own text for the window's next message (the panel's context, a site app's or an app's prefix): the last wins. */
  const contexts = new Map<string, Prefix>();
  /** The prefix the window's next message to `chatId` would get. */
  const prefixFor = (win: string, chatId: string | undefined): Prefix | undefined => {
    const c = contexts.get(win);
    if (!c?.firstOnly) return c;
    const view = o.chats.active(win);
    return view && view.summary.id === (chatId ?? view.summary.id) && !view.items.some((i) => i.kind === "user") ? c : undefined;
  };

  function flush(chatId: string): void {
    const queue = waiting.get(chatId);
    const session = o.chats.sessionIdOf(chatId);
    const masker = o.masker();
    const outflow = o.outflow();
    if (!queue?.length || !session || !masker || !outflow) return;
    // Taken first: prompt() pushes a view, which flushes again.
    waiting.delete(chatId);
    for (const [i, w] of queue.entries()) {
      let r: { sent: string; shown: string };
      try {
        r = prepareSend({ masker, sessionId: session, draft: w.draft, outflow, win: w.win, ...(w.before ? { before: w.before } : {}), ...(w.after ? { after: w.after } : {}) });
      } catch {
        // The session closed meanwhile: the rest waits for the next one, still unmasked and unsent.
        waiting.set(chatId, [...queue.slice(i), ...(waiting.get(chatId) ?? [])]);
        return;
      }
      w.written?.();
      for (const t of w.points ?? []) o.point?.(session, t);
      o.interacted(w.win);
      o.chats.prompt(chatId, r.sent, r.shown);
    }
  }

  async function send(win: string, chatId: string, draft: ChatDraft, extra: { before?: string; after?: string; written?: () => void } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
    // A @ tab must be a real tab the agent can see now: its title and address are the host's, never the composer's.
    const refs = draft.refs ?? [];
    const listed = refs.some((r) => "tab" in r) ? ((await o.tabs?.()) ?? []) : [];
    const points: TabInfo[] = [];
    const pages: { tab?: string; title: string; url: string }[] = [];
    for (const r of refs) {
      if (!("tab" in r)) {
        pages.push(r);
        continue;
      }
      const t = listed.find((x) => x.id === r.tab);
      if (!t) return { ok: false, error: say("host-chat-reference-gone") };
      points.push(t);
      pages.push({ tab: t.id, title: t.title, url: t.url });
    }
    const prefix = prefixFor(win, chatId);
    contexts.delete(win);
    const before = (prefix?.text ?? "") + (extra.before ?? "") + (draft.command ? commandText(draft.command) : "");
    const after = (extra.after ?? "") + referencesText(pages, say("host-chat-references"));
    const written = prefix?.written || extra.written ? () => (prefix?.written?.(), extra.written?.()) : undefined;
    const queue = waiting.get(chatId) ?? [];
    queue.push({ win, draft, ...(before ? { before } : {}), ...(after ? { after } : {}), ...(written ? { written } : {}), ...(points.length ? { points } : {}) });
    waiting.set(chatId, queue);
    if (!o.chats.sessionIdOf(chatId) && !(await o.chats.select(win, chatId))) {
      waiting.delete(chatId);
      // Nothing went: the prefix waits for the next message, unless a newer one came meanwhile.
      if (prefix && !contexts.has(win)) contexts.set(win, prefix);
      return { ok: false, error: "Cette discussion n'existe plus." };
    }
    flush(chatId);
    return { ok: true };
  }

  return {
    send,
    flush,
    /** ⌘T's question to the window's active discussion (a new one if none); `after`: the pages shown with it. */
    async handOff(win: string, question: string, after: string): Promise<void> {
      const chatId = (o.chats.active(win) ?? (await o.create(win))).summary.id;
      const r = await send(win, chatId, { text: question, pasted: [], clear: [] }, { after });
      if (!r.ok) throw new Error(r.error);
    },
    /** The panel opened on a tab: its context goes before the next first message of the window's discussion. */
    panelOpened(win: string, prefix: string): void {
      // An explicit prefill (an app's, a site app's) opens the panel itself: its text and its `written` stay.
      if (contexts.get(win)?.firstOnly === false) return;
      contexts.set(win, { text: prefix, firstOnly: true });
    },
    /**
     * Ressac's own text for the window's agent (the terminal's prefill), never typed: `submit`, a message to the active
     * discussion (a new one if none); otherwise it waits as the prefix of the window's next message. `written` runs as it is sent.
     */
    async prefill(win: string, text: string, p: { submit?: boolean; written?: () => void } = {}): Promise<void> {
      if (!p.submit) return void contexts.set(win, { text, firstOnly: false, ...(p.written ? { written: p.written } : {}) });
      const chatId = (o.chats.active(win) ?? (await o.create(win))).summary.id;
      const r = await send(win, chatId, { text: "", pasted: [], clear: [] }, { before: text, ...(p.written ? { written: p.written } : {}) });
      if (!r.ok) throw new Error(r.error);
    },
    /** What the window's next message would start with, for the composer to show; null when nothing waits. */
    prefixOf: (win: string): string | null => prefixFor(win, undefined)?.text ?? null,
    /** The composer's « × » on the prefix. */
    dropPrefix: (win: string) => void contexts.delete(win),
    waiting: (chatId: string) => waiting.get(chatId)?.length ?? 0,
    /** « Arrêter »: the drafts waiting for the session go too. */
    drop: (chatId: string) => void waiting.delete(chatId),
    dropWindow(win: string): void {
      contexts.delete(win);
      for (const [id, q] of waiting) {
        const kept = q.filter((w) => w.win !== win);
        if (kept.length) waiting.set(id, kept);
        else waiting.delete(id);
      }
    },
  };
}

export type ChatSend = ReturnType<typeof createChatSend>;
