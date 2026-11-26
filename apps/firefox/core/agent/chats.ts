import { randomUUID } from "node:crypto";
import type { AskReply, ChatItem, ChatState, ChatSummary, ChatView, SessionUpdate } from "../../shared/chat";
import type { EngineConversation } from "./chat/engine";
import type { ChatRecord, ChatStore } from "./chat-store";

/** Chat engine processes alive at once in the app (R7): terminals count separately. */
export const LIVE_MAX = 3;
const NEW_TITLE = "Nouvelle discussion";
const TITLE_MAX = 40;
const RESUME_FAILED = "La conversation n'a pas pu être reprise : l'agent repart sans le contexte des échanges précédents.";

/** The host's `open` found the engine's account signed out: the discussion waits for a login, then retry(). */
export class SignedOutError extends Error {
  constructor() {
    super("signed-out");
  }
}

/** The engine refused to resume the conversation (the adapter's own resume): the one fresh open may follow. */
export class ResumeError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** What the host's `open` gets: it starts the kernel pipe session and the engine. */
export interface OpenOptions {
  chatId: string;
  windowId: string | null;
  engine: "claude" | "codex" | "own";
  profile: string;
  mode: "browser" | "workshop";
  /** Own model: the discussion so far (it keeps no history of its own), without the messages still to send. */
  transcript?: ChatItem[];
  /** The engine's own id of a conversation that ran a turn. */
  resumeId?: string;
  /** Claude: the uuid of a new conversation. */
  sessionId?: string;
  /** The discussion's model (ChatRecord.model). */
  model?: string;
}

interface Entry {
  rec: ChatRecord;
  state: ChatState;
  streaming?: { messageId: string; text: string };
  error?: string;
  /** Texts for the engine, waiting for the conversation to open or the running turn to end. */
  pending: { text: string; itemId: string }[];
  /** A prompt is in the engine: the adapters track one turn at a time. */
  turn: boolean;
  conv?: EngineConversation;
  launch?: { sessionId: string };
  /** open() runs; `keep: false` closes what it returns. */
  opening?: { keep: boolean };
  /** The running start(), resolved once what its open returned is kept or closed. */
  starting?: Promise<void>;
  /** The running close(): a second close waits for it. */
  closing?: Promise<void>;
  /** Created and not yet started: its first open keeps the mode it was created with. */
  fresh?: boolean;
  unsubs: (() => void)[];
  /** Last use, for the least recently used pause. */
  used: number;
  /** Writes of one record run in order (they share a temporary file). */
  saving: Promise<void>;
}

/** The chat's discussions (spec §4): at most LIVE_MAX open conversations, the others paused and resumed by id. */
export class Chats {
  private entries = new Map<string, Entry>();
  private actives = new Map<string, string>();
  /** Discussions waiting for a free conversation, in order. */
  private queue: Entry[] = [];
  private readonly now: () => number;
  private readonly liveMax: number;

  constructor(
    private readonly o: {
      store: ChatStore;
      open: (o: OpenOptions) => Promise<{ conversation: EngineConversation; launch: { sessionId: string } }>;
      notify: (windowId: string, view: ChatView) => void;
      /** A message already streaming grew: only its text so far, the UI merges it into the view it has. */
      stream: (windowId: string, chatId: string, streaming: { messageId: string; text: string }) => void;
      now?: () => number;
      liveMax?: number;
      /** The app's current mode: a discussion reopens in it (the workshop is shaped for it). */
      mode?: () => "browser" | "workshop";
    },
  ) {
    this.now = o.now ?? Date.now;
    this.liveMax = o.liveMax ?? LIVE_MAX;
  }

  /** The space's discussions, the most recently updated first. */
  async list(spaceId: string): Promise<ChatSummary[]> {
    const out = new Map<string, ChatSummary>();
    for (const r of await this.o.store.list(spaceId)) out.set(r.id, { ...summaryOf(r), state: "paused" });
    for (const e of this.entries.values()) if (e.rec.spaceId === spaceId) out.set(e.rec.id, this.summary(e));
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  active(windowId: string): ChatView | null {
    const e = this.entries.get(this.actives.get(windowId) ?? "");
    return e ? this.view(e) : null;
  }

  async create(windowId: string, c: { profile: string; mode: "browser" | "workshop"; engine: "claude" | "codex" | "own"; spaceId: string; model?: string }): Promise<ChatView> {
    const t = this.now();
    const rec: ChatRecord = { id: randomUUID(), title: NEW_TITLE, ...c, state: "starting", updatedAt: t, messages: 0, windowId, items: [] };
    const e = this.entry(rec, "starting");
    e.fresh = true;
    this.actives.set(windowId, rec.id);
    this.live(e);
    await this.save(e);
    return this.view(e);
  }

  /** Makes the discussion the window's active one; a paused one resumes. */
  async select(windowId: string, chatId: string): Promise<ChatView | null> {
    let e = this.entries.get(chatId);
    if (!e) {
      const rec = await this.o.store.read(chatId);
      if (!rec) return null;
      // A card saved unanswered belongs to a turn that is over: it never takes an answer again.
      endQuestions(rec);
      e = this.entries.get(chatId) ?? this.entry(rec, "paused");
    }
    const was = e.rec.windowId;
    if (was !== windowId) {
      // Live in another window: its engine holds that window's token and tabs, so it reopens bound to this one.
      if (e.conv || e.opening) await this.close(e);
      if (was && this.actives.get(was) === chatId) this.actives.delete(was);
    }
    e.rec.windowId = windowId;
    e.used = this.now();
    this.actives.set(windowId, chatId);
    if (e.state === "paused") this.live(e);
    this.push(e);
    return this.view(e);
  }

  /** `sentText` goes to the engine; `userItemText` (the masked text the user wrote) is what the transcript keeps. */
  prompt(chatId: string, sentText: string, userItemText: string): void {
    const e = this.entries.get(chatId);
    if (!e) return;
    if (!e.rec.items.some((i) => i.kind === "user")) e.rec.title = userItemText.slice(0, TITLE_MAX);
    const itemId = randomUUID();
    e.rec.items.push({ kind: "user", id: itemId, text: userItemText });
    e.pending.push({ text: sentText, itemId });
    e.used = e.rec.updatedAt = this.now();
    // An ended conversation (error) waits for retry: it is never prompted.
    if (e.state === "paused") this.live(e);
    else this.pump(e);
    this.push(e);
  }

  /** Ends the running turn; the messages waiting behind it are dropped too. */
  cancel(chatId: string): void {
    const e = this.entries.get(chatId);
    if (!e) return;
    unsend(e);
    if (e.turn) e.conv?.cancel();
    this.push(e);
  }

  answer(chatId: string, requestId: string, reply: AskReply): void {
    const e = this.entries.get(chatId);
    const q = e?.rec.items.find((i) => i.kind === "question" && i.id === requestId && !i.answer);
    // Only the running turn waits for an answer: the adapter knows no other card.
    if (!e?.conv || !e.turn || q?.kind !== "question") return;
    e.conv.answer(requestId, reply);
    q.answer = "cancelled" in reply ? "cancelled" : reply.answers;
    if (e.turn && !openQuestion(e)) e.state = "running";
    this.push(e);
  }

  async pause(chatId: string): Promise<void> {
    const e = this.entries.get(chatId);
    if (!e) return;
    // Still opening: what the open returns closes before this resolves (« Mode avancé » resumes the same conversation).
    const starting = e.opening ? e.starting : undefined;
    await this.close(e);
    await starting;
    this.wake();
  }

  /** Pauses every idle discussion (memory pressure, before a lock lift); a running turn stays. */
  async pauseIdle(): Promise<void> {
    await Promise.all([...this.entries.values()].filter(idle).map((e) => this.close(e)));
  }

  /** The app's mode changed: idle discussions pause, and every one not live shows the mode it will reopen in. */
  async modeChanged(): Promise<void> {
    await this.pauseIdle();
    for (const e of this.entries.values()) if (!e.conv && !e.opening) this.push(e);
  }

  /** The window's discussions pause and stay in the list. */
  async closeWindow(windowId: string): Promise<void> {
    this.actives.delete(windowId);
    const mine = [...this.entries.values()].filter((e) => e.rec.windowId === windowId);
    await Promise.all(mine.map((e) => this.close(e)));
    for (const e of mine) e.rec.windowId = null;
    this.wake();
  }

  /** Reopens the discussion, by its engine id once it ran a turn; waiting messages go once it is open. */
  async retry(chatId: string): Promise<void> {
    const e = this.entries.get(chatId);
    if (!e) return;
    if (e.conv || e.opening) await this.close(e);
    this.live(e);
  }

  /** The discussion's model from the next message on, the same conversation; "" is the engine's default. */
  async setModel(chatId: string, model: string): Promise<void> {
    const e = this.entries.get(chatId);
    if (!e) return;
    e.rec.model = model || undefined;
    e.conv?.setModel?.(e.rec.model);
    this.push(e);
    await this.save(e);
  }

  modelOf(chatId: string): string | undefined {
    return this.entries.get(chatId)?.rec.model;
  }

  /** The live conversation's model list; null when not live or the engine has none. */
  models(chatId: string) {
    return this.entries.get(chatId)?.conv?.models?.() ?? null;
  }

  /** The kernel session id of the live conversation (the masker's key, R1). */
  sessionIdOf(chatId: string): string | null {
    const e = this.entries.get(chatId);
    return e?.conv && e.launch ? e.launch.sessionId : null;
  }

  /** The discussion whose live conversation runs kernel session `sessionId` (the tabs its agent opens belong to it). */
  chatOfSession(sessionId: string): string | undefined {
    for (const [id, e] of this.entries) if (e.conv && e.launch?.sessionId === sessionId) return id;
    return undefined;
  }

  /** A line of Ressac's in the transcript (« Échanges faits dans le terminal »). */
  async notice(chatId: string, text: string): Promise<void> {
    const e = this.entries.get(chatId);
    if (!e) return;
    e.rec.items.push({ kind: "notice", id: randomUUID(), text });
    e.rec.updatedAt = this.now();
    this.push(e);
    await this.save(e);
  }

  /** The engine's own id once the discussion ran a turn (the terminal resumes it, « Mode avancé »). */
  resumeIdOf(chatId: string): string | undefined {
    return this.entries.get(chatId)?.rec.engineSessionId;
  }

  /**
   * Deletes the discussion: gone from the list and the windows at once, its engine closed (its kernel session stops),
   * then its file. Returns the engine conversation it ran (to erase that history too) and the windows it was active in;
   * null when unknown.
   */
  async remove(chatId: string): Promise<{ engine: "claude" | "codex" | "own"; historyIds: string[]; windows: string[] } | null> {
    const e = this.entries.get(chatId);
    const rec = e?.rec ?? (await this.o.store.read(chatId));
    const historyIds = rec ? [...new Set([rec.engineSessionId, e?.conv?.engineSessionId, ...(rec.historyIds ?? [])])].filter((x): x is string => !!x) : [];
    // Gone first: a select meanwhile finds nothing in memory, and save() writes nothing for it any more.
    this.entries.delete(chatId);
    const windows = [...this.actives].filter(([, id]) => id === chatId).map(([w]) => w);
    for (const w of windows) this.actives.delete(w);
    if (e) {
      e.rec.windowId = null; // pushes nothing to a window
      // The write already running lands before the file goes: it cannot bring it back.
      await e.saving;
      await this.o.store.remove(chatId);
      const starting = e.opening ? e.starting : undefined;
      await this.close(e);
      await starting;
      this.wake();
    } else await this.o.store.remove(chatId);
    return rec ? { engine: rec.engine, historyIds, windows } : null;
  }

  /** App quit: messages still waiting are marked never sent. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => (unsend(e), this.close(e))));
  }

  private entry(rec: ChatRecord, state: ChatState): Entry {
    const e: Entry = { rec, state, pending: [], turn: false, unsubs: [], used: this.now(), saving: Promise.resolve() };
    this.entries.set(rec.id, e);
    return e;
  }

  private liveCount(): number {
    return [...this.entries.values()].filter((e) => e.conv || e.opening).length;
  }

  private leastUsedIdle(): Entry | undefined {
    return [...this.entries.values()].filter(idle).sort((a, b) => a.used - b.used)[0];
  }

  /** Opens the conversation, pausing the least recently used idle one past LIVE_MAX, or queues it. */
  private live(e: Entry): void {
    if (e.conv || e.opening || this.queue.includes(e)) return;
    if (this.liveCount() >= this.liveMax) {
      const lru = this.leastUsedIdle();
      if (!lru) {
        this.queue.push(e);
        e.state = "queued";
        this.push(e);
        return;
      }
      // shortcut: the slot is free before the old process has exited (briefly LIVE_MAX + 1), await close() if memory shows it.
      void this.close(lru);
    }
    e.starting = this.start(e);
  }

  /** A conversation may be free: the queued discussions open in order. */
  private wake(): void {
    while (this.queue.length && (this.liveCount() < this.liveMax || this.leastUsedIdle())) this.live(this.queue.shift()!);
  }

  private async start(e: Entry): Promise<void> {
    const opening = { keep: true };
    e.opening = opening;
    e.state = "starting";
    e.error = undefined;
    if (!e.fresh && this.o.mode) e.rec.mode = this.o.mode();
    e.fresh = undefined;
    this.push(e);
    // Only a conversation that ran a turn resumes: a Codex thread with no turn would resume without its policy.
    const resumeId = e.rec.engineSessionId;
    const sessionId = !resumeId && e.rec.engine === "claude" ? randomUUID() : undefined;
    // Claude writes its history under this uuid from the first prompt: « Supprimer » can erase it before any turn ends.
    if (sessionId) keepHistoryId(e.rec, sessionId);
    const waiting = new Set(e.pending.map((p) => p.itemId));
    const transcript = e.rec.engine === "own" ? e.rec.items.filter((i) => !waiting.has(i.id) && !(i.kind === "user" && i.unsent)) : undefined;
    const model = e.rec.model;
    let opened: { conversation: EngineConversation; launch: { sessionId: string } };
    try {
      opened = await this.o.open({
        chatId: e.rec.id,
        windowId: e.rec.windowId,
        engine: e.rec.engine,
        profile: e.rec.profile,
        mode: e.rec.mode,
        ...(resumeId ? { resumeId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(transcript ? { transcript } : {}),
        ...(model ? { model } : {}),
      });
    } catch (err) {
      if (e.opening !== opening) return;
      e.opening = undefined;
      // Before the resume fallback: signed in again, the same conversation resumes.
      if (err instanceof SignedOutError) {
        e.state = "signed-out";
        this.push(e);
        this.wake();
        return;
      }
      // Only the engine's own refusal to resume: a stopped machine or a CLI download keeps the id for Réessayer.
      if (resumeId && err instanceof ResumeError) {
        // Once: the next start has no resumeId. The transcript stays; the engine loses the context.
        e.rec.engineSessionId = undefined;
        e.rec.items.push({ kind: "notice", id: randomUUID(), text: RESUME_FAILED });
        return this.start(e);
      }
      e.state = "error";
      e.error = err instanceof Error ? err.message : String(err);
      this.push(e);
      this.wake();
      return;
    }
    const conv = opened.conversation;
    if (!opening.keep) {
      await conv.close().catch((err) => console.error("[chat] close:", err));
      return;
    }
    e.opening = undefined;
    e.conv = conv;
    e.launch = opened.launch;
    keepHistoryId(e.rec, conv.engineSessionId); // Codex: the thread id, known once the thread started
    e.unsubs = [conv.onUpdate((u) => this.update(e, conv, u)), conv.onEnd((x) => this.ended(e, conv, x))];
    e.state = "ready";
    // Changed while it opened: the new one goes from the first message.
    if (e.rec.model !== model) conv.setModel?.(e.rec.model);
    // A model the engine no longer lists: its default.
    if (e.rec.model && conv.models)
      conv.models().then(
        (l) => void (e.conv === conv && e.rec.model && !l.some((m) => m.value === e.rec.model) && this.setModel(e.rec.id, "")),
        () => {},
      );
    this.pump(e);
    this.push(e);
  }

  /** One prompt in flight per conversation: the next waits for turn_end. */
  private pump(e: Entry): void {
    if (!e.conv || e.turn || !e.pending.length || e.state === "signed-out") return;
    e.turn = true;
    e.state = "running";
    // The last turn's error goes with the next message.
    e.error = undefined;
    e.conv.prompt(e.pending.shift()!.text);
  }

  private update(e: Entry, conv: EngineConversation, u: SessionUpdate): void {
    if (e.conv !== conv) return;
    const items = e.rec.items;
    switch (u.type) {
      case "agent_message_chunk": {
        const same = e.streaming?.messageId === u.messageId;
        if (e.streaming && !same) flush(e);
        e.streaming = { messageId: u.messageId, text: (e.streaming?.text ?? "") + u.text };
        // The view the UI holds has this message: a full view per chunk would copy and re-render every item.
        if (same) {
          if (e.rec.windowId) this.o.stream(e.rec.windowId, e.rec.id, { ...e.streaming });
          return;
        }
        break;
      }
      case "agent_message": {
        if (e.streaming?.messageId === u.messageId) e.streaming = undefined;
        const old = items.find((i) => i.kind === "agent" && i.id === u.messageId);
        if (old?.kind === "agent") old.text = u.text;
        else items.push({ kind: "agent", id: u.messageId, text: u.text });
        break;
      }
      case "tool_call":
        items.push({ kind: "tool", id: u.toolCallId, title: u.title, toolKind: u.kind, status: u.status });
        break;
      case "tool_call_update": {
        const t = items.find((i) => i.kind === "tool" && i.id === u.toolCallId);
        if (t?.kind === "tool") {
          t.status = u.status;
          if (u.tab) t.tab = u.tab;
        }
        break;
      }
      case "request_question":
        items.push({ kind: "question", id: u.requestId, questions: u.questions });
        e.state = "waiting";
        break;
      case "turn_end":
        e.turn = false;
        flush(e);
        endQuestions(e.rec);
        if (u.stopReason === "error" && u.error === "signed-out") e.state = "signed-out";
        else {
          e.state = "ready";
          // The own model's max_turns carries its text too.
          e.error = u.error ?? (u.stopReason === "error" ? "L'agent a rencontré une erreur." : undefined);
        }
        // A turn that failed (turn/start refused) may leave an empty Codex thread: never resumed.
        if (u.stopReason !== "error") e.rec.engineSessionId = conv.engineSessionId;
        e.used = e.rec.updatedAt = this.now();
        void this.save(e);
        this.pump(e);
        this.push(e);
        this.wake();
        return;
      default:
        return;
    }
    this.push(e);
  }

  /** The process ended without close(): the transcript stays, retry reopens it. */
  private ended(e: Entry, conv: EngineConversation, x: { code: number | null; error?: string }): void {
    if (e.conv !== conv) return;
    this.detach(e);
    flush(e);
    endQuestions(e.rec);
    e.state = "error";
    e.error = x.error ?? `L'agent s'est arrêté (code ${x.code ?? "inconnu"}).`;
    e.rec.updatedAt = this.now();
    void this.save(e);
    this.push(e);
    this.wake();
  }

  private detach(e: Entry): EngineConversation | undefined {
    const conv = e.conv;
    for (const off of e.unsubs) off();
    e.unsubs = [];
    e.conv = e.launch = undefined;
    e.turn = false;
    return conv;
  }

  /**
   * Closes what was opened (or drops what open() will return); the discussion is paused and written. A close already
   * running is awaited, not skipped: the terminal resumes only once the process is gone.
   */
  private close(e: Entry): Promise<void> {
    if (e.closing) return e.closing;
    const closing = this.closeNow(e).finally(() => {
      if (e.closing === closing) e.closing = undefined;
    });
    e.closing = closing;
    return closing;
  }

  private async closeNow(e: Entry): Promise<void> {
    const i = this.queue.indexOf(e);
    if (i >= 0) this.queue.splice(i, 1);
    if (e.opening) e.opening.keep = false;
    e.opening = undefined;
    const live = e.state !== "paused" && e.state !== "error";
    const conv = this.detach(e);
    if (!live && !conv) return;
    flush(e);
    endQuestions(e.rec);
    e.state = "paused";
    this.push(e);
    await Promise.all([conv?.close().catch((err) => console.error("[chat] close:", err)), this.save(e)]);
  }

  private save(e: Entry): Promise<void> {
    // Removed: a late write (turn end, death, notice) never brings its file back.
    if (this.entries.get(e.rec.id) !== e) return e.saving;
    const rec: ChatRecord = { ...e.rec, ...this.summary(e), items: [...e.rec.items] };
    e.saving = e.saving.then(() => this.o.store.write(rec)).catch((err) => console.error("[chat] not saved:", err));
    return e.saving;
  }

  private summary(e: Entry): ChatSummary {
    // Not live: it reopens in the app's mode (start), so the chip says that one; a fresh one keeps the mode it was created with.
    const mode = !e.fresh && !e.conv && !e.opening && this.o.mode ? this.o.mode() : e.rec.mode;
    return { ...summaryOf(e.rec), mode, state: e.state, messages: e.rec.items.filter((i) => i.kind === "user" || i.kind === "agent").length };
  }

  private view(e: Entry): ChatView {
    return { summary: this.summary(e), items: [...e.rec.items], ...(e.streaming ? { streaming: { ...e.streaming } } : {}), ...(e.error ? { error: e.error } : {}) };
  }

  private push(e: Entry): void {
    if (e.rec.windowId) this.o.notify(e.rec.windowId, this.view(e));
  }
}

const idle = (e: Entry): boolean => !!e.conv && !e.turn && !e.pending.length;
/** Drops the waiting messages, marking their user items never sent. */
function unsend(e: Entry): void {
  for (const p of e.pending) {
    const item = e.rec.items.find((i) => i.kind === "user" && i.id === p.itemId);
    if (item?.kind === "user") item.unsent = true;
  }
  e.pending = [];
}

/** shortcut: one id per engine start, so a discussion reopened without end grows the list; cap it if that shows. */
function keepHistoryId(r: ChatRecord, id: string): void {
  if (!id) return; // the own model keeps no history
  if (!r.historyIds?.includes(id)) r.historyIds = [...(r.historyIds ?? []), id];
}

const openQuestion = (e: Entry): boolean => e.rec.items.some((i) => i.kind === "question" && !i.answer);

/** A message cut short (turn end, death, pause) is kept as said. */
function flush(e: Entry): void {
  if (!e.streaming) return;
  e.rec.items.push({ kind: "agent", id: e.streaming.messageId, text: e.streaming.text });
  e.streaming = undefined;
}

/** The turn is over (end, death, pause): its cards still waiting show as never answered. */
function endQuestions(r: ChatRecord): void {
  for (const i of r.items) if (i.kind === "question" && !i.answer) i.answer = "cancelled";
}

function summaryOf(r: ChatRecord): ChatSummary {
  const { id, title, engine, profile, mode, state, updatedAt, messages } = r;
  return { id, title, engine, profile, mode, state, updatedAt, messages, ...(r.engineSessionId || r.historyIds?.length ? { engineHistory: true as const } : {}) };
}
