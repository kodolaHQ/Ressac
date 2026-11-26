// The chat's send pipeline (spec §5), engine-neutral: what the user wrote goes to the engine masked with the discussion's own
// table (R1), and to the outflow as typed or pasted, never before the discussion's kernel session exists.
import type { Masker } from "../../../packages/kernel/src/index.ts";
import type { Outflow } from "../../../packages/kernel/src/outflow/outflow.ts";
import { LABEL_SOURCE } from "../../../packages/kernel/src/mask/table.ts";
import type { Chats } from "../core/agent/chats.ts";
import type { ChatDraft, ChatView } from "../shared/chat.ts";

const LABEL = new RegExp(`^${LABEL_SOURCE}$`);
const LABELS = new RegExp(LABEL_SOURCE, "g");
/** A message longer than this is refused: a paste of a whole book is not a chat turn. */
export const DRAFT_MAX = 100_000;

type SendMasker = Pick<Masker, "maskTypedFor" | "lookupForSession">;

/** The UI's draft, checked at the trust boundary: null when unusable. Ranges are clamped to the text, labels must be labels. */
export function cleanDraft(v: unknown): ChatDraft | null {
  const d = (v ?? {}) as Record<string, unknown>;
  if (typeof d.text !== "string" || !d.text.trim() || d.text.length > DRAFT_MAX) return null;
  const n = d.text.length;
  const int = (x: unknown) => (typeof x === "number" && Number.isInteger(x) ? Math.min(Math.max(x, 0), n) : null);
  const pasted: [number, number][] = [];
  for (const r of Array.isArray(d.pasted) ? d.pasted : []) {
    const [a, b] = Array.isArray(r) ? [int(r[0]), int(r[1])] : [null, null];
    if (a !== null && b !== null && a < b) pasted.push([a, b]);
  }
  const clear = (Array.isArray(d.clear) ? d.clear : []).filter((l): l is string => typeof l === "string" && LABEL.test(l));
  return { text: d.text, pasted, clear };
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
}) {
  const waiting = new Map<string, Waiting[]>();
  /** The panel's context for the window's next first message. */
  const contexts = new Map<string, string>();

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
      o.interacted(w.win);
      o.chats.prompt(chatId, r.sent, r.shown);
    }
  }

  async function send(win: string, chatId: string, draft: ChatDraft, extra: { after?: string } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
    const view = o.chats.active(win);
    const first = view?.summary.id === chatId && !view.items.some((i) => i.kind === "user");
    const before = first ? contexts.get(win) : undefined;
    contexts.delete(win);
    const queue = waiting.get(chatId) ?? [];
    queue.push({ win, draft, ...(before ? { before } : {}), ...(extra.after ? { after: extra.after } : {}) });
    waiting.set(chatId, queue);
    if (!o.chats.sessionIdOf(chatId) && !(await o.chats.select(win, chatId))) {
      waiting.delete(chatId);
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
      contexts.set(win, prefix);
    },
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
