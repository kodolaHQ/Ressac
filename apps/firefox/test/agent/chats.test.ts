import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { AskReply, ChatView, SessionUpdate } from "../../shared/chat";
import type { EngineConversation } from "../../core/agent/chat/engine";
import { ChatStore } from "../../core/agent/chat-store";
import { Chats, LIVE_MAX, ResumeError, SignedOutError, type OpenOptions } from "../../core/agent/chats";

class FakeConv implements EngineConversation {
  prompts: string[] = [];
  answers: [string, AskReply][] = [];
  cancels = 0;
  closed = false;
  modelsSet: (string | undefined)[] = [];
  list = [{ value: "", name: "Défaut" }, { value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }];
  async models() {
    return this.list;
  }
  setModel(m: string | undefined) {
    this.modelsSet.push(m);
  }
  private updates = new Set<(u: SessionUpdate) => void>();
  private ends = new Set<(e: { code: number | null; error?: string }) => void>();
  constructor(readonly engineSessionId: string) {}
  prompt(t: string) {
    this.prompts.push(t);
  }
  cancel() {
    this.cancels++;
  }
  answer(id: string, r: AskReply) {
    this.answers.push([id, r]);
  }
  async close() {
    this.closed = true;
  }
  onUpdate(cb: (u: SessionUpdate) => void) {
    this.updates.add(cb);
    return () => this.updates.delete(cb);
  }
  onEnd(cb: (e: { code: number | null; error?: string }) => void) {
    this.ends.add(cb);
    return () => this.ends.delete(cb);
  }
  emit(u: SessionUpdate) {
    this.updates.forEach((cb) => cb(u));
  }
  die(code: number | null, error?: string) {
    this.ends.forEach((cb) => cb(error ? { code, error } : { code }));
  }
  endTurn() {
    this.emit({ type: "turn_end", stopReason: "end_turn" });
  }
}

const dirs: string[] = [];
const managers: Chats[] = [];
afterEach(async () => {
  // Pending writes land before the folder goes.
  await Promise.all(managers.splice(0).map((c) => c.stopAll()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Opened {
  o: OpenOptions;
  conv: FakeConv;
  resolve: () => void;
  reject: (e: Error) => void;
}

/** `auto`: every open resolves at once; otherwise the test resolves each one. */
function prepare(auto = true, mode?: () => "browser" | "workshop") {
  const dir = mkdtempSync(join(tmpdir(), "ressac-chats-"));
  dirs.push(dir);
  const store = new ChatStore(join(dir, "chats"));
  const opens: Opened[] = [];
  const views: [string, ChatView][] = [];
  const streams: [string, string, { messageId: string; text: string }][] = [];
  let clock = 1000;
  const chats = new Chats({
    store,
    now: () => ++clock,
    ...(mode ? { mode } : {}),
    notify: (w, v) => views.push([w, v]),
    stream: (w, chatId, s) => streams.push([w, chatId, s]),
    open: (o) =>
      new Promise((resolve, reject) => {
        const conv = new FakeConv(o.engine === "own" ? "" : (o.resumeId ?? o.sessionId ?? `thread-${opens.length + 1}`));
        const launch = { sessionId: `kernel-${opens.length + 1}` };
        const opened: Opened = { o, conv, resolve: () => resolve({ conversation: conv, launch }), reject };
        opens.push(opened);
        if (auto) opened.resolve();
      }),
  });
  managers.push(chats);
  const state = (id: string) => views.filter(([, v]) => v.summary.id === id).at(-1)?.[1].summary.state;
  const onDisk = (id: string) => JSON.parse(readFileSync(join(dir, "chats", `${id}.json`), "utf8"));
  return { chats, store, opens, views, streams, state, onDisk };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const opts = { profile: "claude", mode: "browser" as const, engine: "claude" as const, spaceId: "perso" };

test("a fourth discussion pauses the least recently used idle one", async () => {
  const { chats, opens, state } = prepare();
  const a = await chats.create("w1", opts);
  const b = await chats.create("w1", opts);
  const c = await chats.create("w2", opts);
  await tick();
  chats.prompt(b.summary.id, "salut", "salut"); // b is used after a
  opens[1]!.conv.endTurn();
  expect(LIVE_MAX).toBe(3);
  const d = await chats.create("w2", opts);
  await tick();
  expect(opens).toHaveLength(4);
  expect(opens[0]!.conv.closed).toBe(true);
  expect(state(a.summary.id)).toBe("paused");
  expect(chats.sessionIdOf(a.summary.id)).toBeNull();
  for (const x of [b, c, d]) expect(chats.sessionIdOf(x.summary.id)).not.toBeNull();
  expect(state(d.summary.id)).toBe("ready");
  // A live session maps back to its discussion; a paused one's no longer does.
  for (const x of [b, c, d]) expect(chats.chatOfSession(chats.sessionIdOf(x.summary.id)!)).toBe(x.summary.id);
  expect(chats.chatOfSession("unknown")).toBeUndefined();
});

test("all three busy: the fourth is queued and opens when a turn ends", async () => {
  const { chats, opens, state } = prepare();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await chats.create("w1", opts)).summary.id);
  await tick();
  for (const id of ids) chats.prompt(id, "travaille", "travaille");
  const d = await chats.create("w1", opts);
  await tick();
  expect(opens).toHaveLength(3);
  expect(state(d.summary.id)).toBe("queued");
  chats.prompt(d.summary.id, "et moi", "et moi");
  opens[1]!.conv.endTurn();
  await tick();
  expect(opens).toHaveLength(4);
  expect(opens[1]!.conv.closed).toBe(true); // the one that just went idle
  expect(opens[3]!.conv.prompts).toEqual(["et moi"]);
  expect(state(d.summary.id)).toBe("running");
});

test("a prompt given while starting is sent once open, in order", async () => {
  const { chats, opens } = prepare(false);
  const a = await chats.create("w1", opts);
  chats.prompt(a.summary.id, "un", "un");
  chats.prompt(a.summary.id, "deux", "deux");
  expect(opens[0]!.conv.prompts).toEqual([]);
  opens[0]!.resolve();
  await tick();
  expect(opens[0]!.conv.prompts).toEqual(["un"]); // one prompt in flight: the adapters track one turn
  opens[0]!.conv.endTurn();
  expect(opens[0]!.conv.prompts).toEqual(["un", "deux"]);
});

test("a prompt during a running turn waits for turn_end", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", opts);
  await tick();
  chats.prompt(a.summary.id, "un", "un");
  chats.prompt(a.summary.id, "deux", "deux");
  expect(opens[0]!.conv.prompts).toEqual(["un"]);
  opens[0]!.conv.endTurn();
  expect(opens[0]!.conv.prompts).toEqual(["un", "deux"]);
});

test("process death mid-turn: error state, transcript kept, retry resumes by engineSessionId", async () => {
  const { chats, opens, state, onDisk } = prepare();
  const a = await chats.create("w1", opts);
  const id = a.summary.id;
  await tick();
  const sessionId = opens[0]!.o.sessionId!;
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/); // (d) Claude: a uuid chosen by the manager
  chats.prompt(id, "un", "un");
  opens[0]!.conv.emit({ type: "agent_message", messageId: "m1", text: "Réponse de Camille Aubrac" });
  opens[0]!.conv.endTurn();
  chats.prompt(id, "deux", "deux");
  opens[0]!.conv.emit({ type: "agent_message_chunk", messageId: "m2", text: "En cours" });
  opens[0]!.conv.die(137);
  await tick();
  expect(state(id)).toBe("error");
  expect(chats.active("w1")?.error).toBeTruthy();
  expect(chats.sessionIdOf(id)).toBeNull();
  // (b) never prompt an ended conversation: the message waits for the retry
  chats.prompt(id, "trois", "trois");
  expect(opens[0]!.conv.prompts).toEqual(["un", "deux"]);
  await expect.poll(() => onDisk(id).items.map((i: { text?: string }) => i.text)).toEqual(["un", "Réponse de Camille Aubrac", "deux", "En cours"]);
  await chats.retry(id);
  await tick();
  expect(opens).toHaveLength(2);
  expect(opens[1]!.o.resumeId).toBe(sessionId);
  expect(opens[1]!.conv.prompts).toEqual(["trois"]);
  expect(chats.active("w1")?.items.map((i) => (i as { text?: string }).text)).toEqual(["un", "Réponse de Camille Aubrac", "deux", "En cours", "trois"]);
});

test("a discussion with no finished turn reopens fresh (Codex resumes a thread only once it ran a turn)", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", { ...opts, engine: "codex", profile: "codex" });
  await tick();
  expect(opens[0]!.o.sessionId).toBeUndefined();
  await chats.pause(a.summary.id);
  await chats.select("w1", a.summary.id);
  await tick();
  expect(opens[1]!.o.resumeId).toBeUndefined();
  chats.prompt(a.summary.id, "un", "un");
  opens[1]!.conv.endTurn();
  await chats.pause(a.summary.id);
  await chats.select("w1", a.summary.id);
  await tick();
  expect(opens[2]!.o.resumeId).toBe("thread-2");
});

test("chunks fold into streaming then into one agent item; the store is written at turn end", async () => {
  const { chats, opens, onDisk } = prepare();
  const a = await chats.create("w1", opts);
  const id = a.summary.id;
  await tick();
  chats.prompt(id, "un", "un");
  const conv = opens[0]!.conv;
  conv.emit({ type: "agent_message_chunk", messageId: "m1", text: "Bon" });
  conv.emit({ type: "agent_message_chunk", messageId: "m1", text: "jour" });
  expect(chats.active("w1")?.streaming).toEqual({ messageId: "m1", text: "Bonjour" });
  conv.emit({ type: "tool_call", toolCallId: "t1", title: "Lit une page", kind: "read", status: "pending" });
  conv.emit({ type: "tool_call_update", toolCallId: "t1", status: "completed" });
  conv.emit({ type: "request_question", requestId: "q1", questions: [{ question: "Laquelle ?", header: "Choix", options: [], multiSelect: false }] });
  expect(chats.active("w1")?.summary.state).toBe("waiting");
  chats.answer(id, "q1", { answers: { "Laquelle ?": "A" } });
  expect(conv.answers).toEqual([["q1", { answers: { "Laquelle ?": "A" } }]]);
  expect(chats.active("w1")?.summary.state).toBe("running");
  conv.emit({ type: "agent_message", messageId: "m1", text: "Bonjour Lucie Ferrand" });
  expect(onDisk(id).items).toHaveLength(0); // not yet: written at turn end
  conv.endTurn();
  await tick();
  const view = chats.active("w1")!;
  expect(view.streaming).toBeUndefined();
  expect(view.items).toEqual([
    { kind: "user", id: expect.any(String), text: "un" },
    { kind: "tool", id: "t1", title: "Lit une page", toolKind: "read", status: "completed" },
    { kind: "question", id: "q1", questions: expect.any(Array), answer: { "Laquelle ?": "A" } },
    { kind: "agent", id: "m1", text: "Bonjour Lucie Ferrand" },
  ]);
  await expect.poll(() => onDisk(id).items).toEqual(view.items);
  expect(onDisk(id).title).toBe("un");
});

test("store holds the masked text given to prompt, never another text", async () => {
  const { chats, opens, onDisk } = prepare();
  const a = await chats.create("w1", opts);
  await tick();
  chats.prompt(a.summary.id, "Page : Mutuelle\n\nAppelle [NOM_1]", "Appelle [NOM_1]");
  expect(opens[0]!.conv.prompts).toEqual(["Page : Mutuelle\n\nAppelle [NOM_1]"]);
  opens[0]!.conv.endTurn();
  await tick();
  await expect.poll(() => onDisk(a.summary.id).items).toHaveLength(1);
  const text = JSON.stringify(onDisk(a.summary.id));
  expect(text).toContain("Appelle [NOM_1]");
  expect(text).not.toContain("Page : Mutuelle");
});

test("a failed open leaves an error and no live slot; an open that lands after a pause is closed", async () => {
  const { chats, opens, state } = prepare(false);
  const a = await chats.create("w1", opts);
  opens[0]!.reject(new Error("pas de conteneur"));
  await tick();
  expect(state(a.summary.id)).toBe("error");
  expect(chats.active("w1")?.error).toBe("pas de conteneur");
  const b = await chats.create("w1", opts);
  const pausing = chats.pause(b.summary.id);
  opens[1]!.resolve();
  await pausing;
  expect(opens[1]!.conv.closed).toBe(true);
  expect(chats.sessionIdOf(b.summary.id)).toBeNull();
});

test("closeWindow pauses its discussions, stopAll closes every open conversation", async () => {
  const { chats, opens, state } = prepare();
  const a = await chats.create("w1", opts);
  const b = await chats.create("w2", opts);
  await tick();
  chats.prompt(a.summary.id, "un", "un");
  await chats.closeWindow("w1");
  expect(opens[0]!.conv.closed).toBe(true);
  expect(state(a.summary.id)).toBe("paused");
  expect(chats.active("w1")).toBeNull();
  // a close() that ends the process is not a death
  opens[0]!.conv.die(0);
  expect((await chats.list("perso")).find((s) => s.id === a.summary.id)?.state).toBe("paused");
  await chats.stopAll();
  expect(opens[1]!.conv.closed).toBe(true);
  expect(chats.sessionIdOf(b.summary.id)).toBeNull();
});

test("pauseIdle pauses idle discussions and never a running turn", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", opts);
  const b = await chats.create("w1", opts);
  await tick();
  chats.prompt(b.summary.id, "un", "un");
  await chats.pauseIdle();
  expect(opens[0]!.conv.closed).toBe(true);
  expect(opens[1]!.conv.closed).toBe(false);
  expect(chats.sessionIdOf(a.summary.id)).toBeNull();
});

test("cancel ends the running turn and drops the messages waiting behind it", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", opts);
  await tick();
  chats.prompt(a.summary.id, "un", "un");
  chats.prompt(a.summary.id, "deux", "deux");
  chats.cancel(a.summary.id);
  expect(opens[0]!.conv.cancels).toBe(1);
  opens[0]!.conv.emit({ type: "turn_end", stopReason: "cancelled" });
  expect(opens[0]!.conv.prompts).toEqual(["un"]);
  expect(chats.active("w1")?.items.map((i) => (i.kind === "user" ? [i.text, i.unsent] : null))).toEqual([["un", undefined], ["deux", true]]);
});

test("a turn that ended in error does not make the thread resumable", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", { ...opts, engine: "codex", profile: "codex" });
  await tick();
  chats.prompt(a.summary.id, "un", "un");
  opens[0]!.conv.emit({ type: "turn_end", stopReason: "error", error: "signed-out" });
  await chats.pause(a.summary.id);
  await chats.select("w1", a.summary.id);
  await tick();
  expect(opens[1]!.o.resumeId).toBeUndefined();
});

test("a resume that fails opens fresh once, with a notice, and the transcript and waiting messages stay", async () => {
  const { chats, opens } = prepare(false);
  const a = await chats.create("w1", opts);
  const id = a.summary.id;
  opens[0]!.resolve();
  await tick();
  chats.prompt(id, "un", "un");
  opens[0]!.conv.endTurn();
  await chats.pause(id);
  await chats.select("w1", id);
  chats.prompt(id, "deux", "deux");
  expect(opens[1]!.o.resumeId).toBe(opens[0]!.o.sessionId);
  opens[1]!.reject(new ResumeError(new Error("No conversation found")));
  await tick();
  expect(opens).toHaveLength(3);
  expect(opens[2]!.o.resumeId).toBeUndefined();
  expect(opens[2]!.o.sessionId).not.toBe(opens[0]!.o.sessionId);
  opens[2]!.resolve();
  await tick();
  expect(opens[2]!.conv.prompts).toEqual(["deux"]);
  const items = chats.active("w1")!.items;
  expect(items.map((i) => i.kind)).toEqual(["user", "user", "notice"]);
  expect(items[2]).toMatchObject({ text: expect.stringContaining("n'a pas pu être reprise") });
  // A fresh open that fails is an error, not another fresh open.
  await chats.pause(id);
  await chats.select("w1", id);
  opens[3]!.reject(new Error("boom"));
  await tick();
  expect(opens).toHaveLength(4);
  expect(chats.active("w1")?.summary.state).toBe("error");
});

test("messages waiting when a window closes go after the reopen; at app quit they are marked never sent", async () => {
  const { chats, opens } = prepare(false);
  const a = await chats.create("w1", opts);
  chats.prompt(a.summary.id, "un", "un");
  await chats.closeWindow("w1");
  await chats.select("w2", a.summary.id);
  opens[1]!.resolve();
  await tick();
  expect(opens[1]!.conv.prompts).toEqual(["un"]);
  expect(chats.active("w2")?.items[0]).not.toHaveProperty("unsent");
  const b = await chats.create("w2", opts);
  chats.prompt(b.summary.id, "deux", "deux");
  await chats.stopAll();
  expect((await chats.select("w2", b.summary.id))?.items[0]).toMatchObject({ text: "deux", unsent: true });
});

test("an open refused as signed out leaves the discussion signed-out, its resume id and waiting messages kept", async () => {
  const { chats, opens, state } = prepare(false);
  const a = await chats.create("w1", opts);
  const id = a.summary.id;
  opens[0]!.resolve();
  await tick();
  chats.prompt(id, "un", "un");
  opens[0]!.conv.endTurn();
  await chats.pause(id);
  chats.prompt(id, "deux", "deux");
  opens[1]!.reject(new SignedOutError());
  await tick();
  expect(state(id)).toBe("signed-out");
  // No fresh reopen: signed in again, retry resumes the same conversation and sends what waited.
  expect(opens).toHaveLength(2);
  await chats.retry(id);
  expect(opens[2]!.o.resumeId).toBe(opens[0]!.o.sessionId);
  opens[2]!.resolve();
  await tick();
  expect(opens[2]!.conv.prompts).toEqual(["deux"]);
});

test("a notice joins the transcript, is pushed and written", async () => {
  const { chats, onDisk } = prepare();
  const a = await chats.create("w1", opts);
  await chats.notice(a.summary.id, "Échanges faits dans le terminal");
  expect(chats.active("w1")!.items.at(-1)).toMatchObject({ kind: "notice", text: "Échanges faits dans le terminal" });
  expect(onDisk(a.summary.id).items.at(-1)).toMatchObject({ kind: "notice" });
});

test("pause resolves only once the engine conversation has closed (« Mode avancé » starts its terminal after it)", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", opts);
  await tick();
  let closed!: () => void;
  opens[0]!.conv.close = () => new Promise<void>((r) => (closed = r));
  let paused = false;
  const pausing = chats.pause(a.summary.id).then(() => (paused = true));
  await tick();
  expect(paused).toBe(false);
  closed();
  await pausing;
  expect(paused).toBe(true);
});

test("a transient open error on a resume keeps the engine id: error state, Réessayer resumes the same conversation", async () => {
  const { chats, opens, state } = prepare(false);
  const a = await chats.create("w1", opts);
  const id = a.summary.id;
  opens[0]!.resolve();
  await tick();
  chats.prompt(id, "un", "un");
  opens[0]!.conv.endTurn();
  await chats.pause(id);
  await chats.select("w1", id);
  opens[1]!.reject(new Error("La machine est arrêtée"));
  await tick();
  expect(opens).toHaveLength(2);
  expect(state(id)).toBe("error");
  expect(chats.active("w1")?.error).toBe("La machine est arrêtée");
  expect(chats.resumeIdOf(id)).toBe(opens[0]!.o.sessionId);
  await chats.retry(id);
  expect(opens[2]!.o.resumeId).toBe(opens[0]!.o.sessionId);
});

test("a paused discussion reopens in the app's current mode, keeping its resume id", async () => {
  let mode: "browser" | "workshop" = "workshop";
  const { chats, opens } = prepare(true, () => mode);
  const a = await chats.create("w1", { ...opts, mode: "workshop" });
  const id = a.summary.id;
  await tick();
  expect(opens[0]!.o.mode).toBe("workshop");
  chats.prompt(id, "un", "un");
  opens[0]!.conv.endTurn();
  await chats.pause(id);
  mode = "browser";
  const v = await chats.select("w1", id);
  await tick();
  expect(opens[1]!.o).toMatchObject({ mode: "browser", resumeId: opens[0]!.o.sessionId });
  expect(v?.summary.mode).toBe("browser");
});

test("a mode change (lab off) shows the new mode at once on idle and paused discussions, not at the next message", async () => {
  let mode: "browser" | "workshop" = "workshop";
  const { chats, views } = prepare(true, () => mode);
  const idleOne = (await chats.create("w1", { ...opts, mode: "workshop" })).summary.id;
  const pausedOne = (await chats.create("w2", { ...opts, mode: "workshop" })).summary.id;
  await tick();
  await chats.pause(pausedOne);
  mode = "browser";
  await chats.modeChanged();
  const last = (id: string) => views.filter(([, v]) => v.summary.id === id).at(-1)![1].summary;
  for (const id of [idleOne, pausedOne]) expect(last(id)).toMatchObject({ mode: "browser", state: "paused" });
});

test("a discussion created with an explicit mode opens in it (the chip's choice may reach the host after the create)", async () => {
  const { chats, opens } = prepare(true, () => "browser");
  await chats.create("w1", { ...opts, mode: "workshop" });
  await tick();
  expect(opens[0]!.o.mode).toBe("workshop");
});

test("selecting from window B a discussion live in window A reopens it bound to B", async () => {
  const { chats, opens, state } = prepare();
  const a = await chats.create("w1", opts);
  const id = a.summary.id;
  await tick();
  chats.prompt(id, "un", "un");
  opens[0]!.conv.endTurn();
  await chats.select("w2", id);
  await tick();
  expect(opens[0]!.conv.closed).toBe(true);
  expect(opens).toHaveLength(2);
  expect(opens[1]!.o).toMatchObject({ windowId: "w2", resumeId: opens[0]!.o.sessionId });
  expect(chats.active("w1")).toBeNull();
  expect(chats.active("w2")?.summary.id).toBe(id);
  expect(state(id)).toBe("ready");
});

test("close waits for a close already running and for an open still running (« Mode avancé » starts after both)", async () => {
  const { chats, opens } = prepare(false);
  const a = await chats.create("w1", opts);
  const id = a.summary.id;
  opens[0]!.resolve();
  await tick();
  let closed!: () => void;
  opens[0]!.conv.close = () => new Promise<void>((r) => (closed = r));
  let idleDone = false;
  void chats.pauseIdle().then(() => (idleDone = true));
  let paused = false;
  const pausing = chats.pause(id).then(() => (paused = true));
  await tick();
  expect(paused).toBe(false);
  closed();
  await pausing;
  expect(idleDone).toBe(true);
  // Still opening: the pause resolves once what the open returns has closed.
  await chats.select("w1", id);
  let closed2!: () => void;
  opens[1]!.conv.close = () => new Promise<void>((r) => (closed2 = r));
  let paused2 = false;
  const pausing2 = chats.pause(id).then(() => (paused2 = true));
  await tick();
  opens[1]!.resolve();
  await tick();
  expect(paused2).toBe(false);
  closed2();
  await pausing2;
  expect(opens[1]!.conv.prompts).toEqual([]);
});

test("a question still waiting when the turn ends (Arrêter, death, pause) is marked unanswered and takes no answer", async () => {
  const { chats, opens, onDisk } = prepare();
  const a = await chats.create("w1", opts);
  const id = a.summary.id;
  await tick();
  const ask = (requestId: string) =>
    opens.at(-1)!.conv.emit({ type: "request_question", requestId, questions: [{ question: "Laquelle ?", header: "", options: [], multiSelect: false }] });
  const answerOf = (requestId: string) => chats.active("w1")!.items.find((i) => i.id === requestId);
  // Cancel while waiting: the turn ends cancelled.
  chats.prompt(id, "un", "un");
  ask("q1");
  chats.cancel(id);
  opens[0]!.conv.emit({ type: "turn_end", stopReason: "cancelled" });
  expect(answerOf("q1")).toMatchObject({ answer: "cancelled" });
  chats.answer(id, "q1", { answers: { "Laquelle ?": "A" } });
  expect(opens[0]!.conv.answers).toEqual([]);
  expect(answerOf("q1")).toMatchObject({ answer: "cancelled" });
  // Process death.
  chats.prompt(id, "deux", "deux");
  ask("q2");
  opens[0]!.conv.die(1);
  expect(answerOf("q2")).toMatchObject({ answer: "cancelled" });
  // Pause.
  await chats.retry(id);
  await tick();
  chats.prompt(id, "trois", "trois");
  ask("q3");
  await chats.pause(id);
  expect(answerOf("q3")).toMatchObject({ answer: "cancelled" });
  await expect.poll(() => onDisk(id).items.find((i: { id: string }) => i.id === "q3")?.answer).toBe("cancelled");
});

test("a card saved unanswered (the app quit mid-turn) loads as unanswered", async () => {
  const { chats, store } = prepare();
  const rec = { id: "old", title: "t", engine: "claude" as const, profile: "claude", mode: "browser" as const, state: "paused" as const, updatedAt: 1, messages: 0, windowId: null, spaceId: "perso", items: [{ kind: "question" as const, id: "q", questions: [] }] };
  await store.write(rec);
  const v = await chats.select("w1", "old");
  expect(v!.items[0]).toMatchObject({ answer: "cancelled" });
});

test("a chunk of a message already streaming sends only its text, not a full view", async () => {
  const { chats, opens, views, streams } = prepare();
  const id = (await chats.create("w1", opts)).summary.id;
  await tick();
  chats.prompt(id, "un", "un");
  const conv = opens[0]!.conv;
  conv.emit({ type: "agent_message_chunk", messageId: "m1", text: "Bon" });
  const n = views.length;
  expect(views.at(-1)![1].streaming).toEqual({ messageId: "m1", text: "Bon" });
  conv.emit({ type: "agent_message_chunk", messageId: "m1", text: "jour" });
  conv.emit({ type: "agent_message_chunk", messageId: "m1", text: " !" });
  expect(views.length).toBe(n);
  expect(streams).toEqual([
    ["w1", id, { messageId: "m1", text: "Bonjour" }],
    ["w1", id, { messageId: "m1", text: "Bonjour !" }],
  ]);
  // A new message flushes the old one into the items: a full view.
  conv.emit({ type: "agent_message_chunk", messageId: "m2", text: "Et" });
  expect(views.length).toBe(n + 1);
  expect(views.at(-1)![1].items.at(-1)).toEqual({ kind: "agent", id: "m1", text: "Bonjour !" });
});

test("remove: a paused discussion leaves the list and the disk", async () => {
  const { chats, store } = prepare();
  const a = await chats.create("w1", opts);
  const b = await chats.create("w1", opts);
  await tick();
  await chats.pause(a.summary.id);
  await chats.remove(a.summary.id);
  expect(await store.read(a.summary.id)).toBeNull();
  expect((await chats.list("perso")).map((s) => s.id)).toEqual([b.summary.id]);
  expect(await chats.select("w1", a.summary.id)).toBeNull();
  await chats.remove("unknown-id"); // no throw
});

test("remove: a live discussion's engine closes (its kernel session stops) before it goes", async () => {
  const { chats, store, opens } = prepare();
  const a = await chats.create("w1", opts);
  await tick();
  chats.prompt(a.summary.id, "travaille", "travaille");
  await chats.remove(a.summary.id);
  expect(opens[0]!.conv.closed).toBe(true);
  expect(chats.sessionIdOf(a.summary.id)).toBeNull();
  expect(await store.read(a.summary.id)).toBeNull();
});

test("remove: a discussion still opening closes what its open returns", async () => {
  const { chats, opens } = prepare(false);
  const a = await chats.create("w1", opts);
  const removed = chats.remove(a.summary.id);
  opens[0]!.resolve();
  await removed;
  expect(opens[0]!.conv.closed).toBe(true);
  expect(await chats.list("perso")).toEqual([]);
});

test("remove: the window's active discussion is no longer active; a send to it does nothing", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", opts);
  await tick();
  await chats.remove(a.summary.id);
  expect(chats.active("w1")).toBeNull();
  chats.prompt(a.summary.id, "encore", "encore");
  chats.answer(a.summary.id, "q1", { cancelled: true });
  await chats.notice(a.summary.id, "note");
  expect(opens[0]!.conv.prompts).toEqual([]);
  expect(await chats.list("perso")).toEqual([]);
});

test("remove: a save still writing when it starts does not bring the file back", async () => {
  const { chats, store, opens } = prepare();
  const a = await chats.create("w1", opts);
  await tick();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const write = store.write.bind(store);
  store.write = async (rec) => {
    await gate;
    return write(rec);
  };
  chats.prompt(a.summary.id, "un", "un");
  opens[0]!.conv.endTurn(); // its save waits on the gate
  const removed = chats.remove(a.summary.id);
  release();
  expect(await removed).toEqual({ engine: "claude", historyIds: [opens[0]!.o.sessionId], windows: ["w1"] });
  await tick();
  expect(await store.read(a.summary.id)).toBeNull();
});

test("remove during the first turn: the engine's id is known for its history, the box shows; other windows are named", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", opts);
  await tick();
  chats.prompt(a.summary.id, "travaille", "travaille");
  expect((await chats.list("perso"))[0]?.engineHistory).toBe(true);
  await chats.select("w2", a.summary.id); // now live in w2
  await tick();
  expect(await chats.remove(a.summary.id)).toEqual({ engine: "claude", historyIds: [opens[1]!.o.sessionId, opens[0]!.o.sessionId], windows: ["w2"] });
});

const own = { ...opts, engine: "own" as const, profile: "own" };

test("sessionIdOf works with a host launch (a bare kernel session id)", async () => {
  const { chats } = prepare();
  const a = await chats.create("w1", own);
  await tick();
  expect(chats.sessionIdOf(a.summary.id)).toBe("kernel-1");
});

test("an own discussion opens with its transcript, without the messages still to send", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", own);
  await tick();
  expect(opens[0]!.o.transcript).toEqual([]);
  chats.prompt(a.summary.id, "un", "un");
  opens[0]!.conv.emit({ type: "agent_message", messageId: "m1", text: "réponse" });
  opens[0]!.conv.endTurn();
  chats.prompt(a.summary.id, "deux", "deux");
  chats.prompt(a.summary.id, "trois", "trois");
  chats.cancel(a.summary.id); // "trois" never sent
  opens[0]!.conv.endTurn();
  await chats.pause(a.summary.id);
  chats.prompt(a.summary.id, "quatre", "quatre"); // reopens with "quatre" waiting
  await tick();
  const o = opens[1]!.o;
  expect(o.resumeId).toBeUndefined();
  expect(o.sessionId).toBeUndefined();
  expect(o.transcript?.map((i) => (i as { text?: string }).text)).toEqual(["un", "réponse", "deux"]);
  expect(opens[1]!.conv.prompts).toEqual(["quatre"]);
});

test("an own discussion never offers to erase an engine history", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", own);
  await tick();
  chats.prompt(a.summary.id, "un", "un");
  opens[0]!.conv.endTurn();
  expect(chats.active("w1")?.summary.engineHistory).toBeUndefined();
  expect(await chats.remove(a.summary.id)).toEqual({ engine: "own", historyIds: [], windows: ["w1"] });
});

test("a turn ending on its step cap shows the engine's text (own model)", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", own);
  await tick();
  chats.prompt(a.summary.id, "un", "un");
  opens[0]!.conv.emit({ type: "turn_end", stopReason: "max_turns", error: "L'agent s'est arrêté." });
  expect(chats.active("w1")?.error).toBe("L'agent s'est arrêté.");
  expect(chats.active("w1")?.summary.state).toBe("ready");
  chats.prompt(a.summary.id, "deux", "deux");
  opens[0]!.conv.endTurn();
  expect(chats.active("w1")?.error).toBeUndefined();
});

test("model: a new discussion takes the one given, opens with it, and keeps it on disk", async () => {
  const { chats, opens, onDisk } = prepare();
  const a = await chats.create("w1", { ...opts, model: "opus" });
  await tick();
  expect(opens[0]!.o.model).toBe("opus");
  expect(chats.modelOf(a.summary.id)).toBe("opus");
  expect(onDisk(a.summary.id).model).toBe("opus");
  const b = await chats.create("w1", opts);
  await tick();
  expect(opens[1]!.o.model).toBeUndefined();
  expect(chats.modelOf(b.summary.id)).toBeUndefined();
});

test("setModel: the live conversation switches (no restart), the record keeps it for the next open", async () => {
  const { chats, opens, onDisk } = prepare();
  const a = await chats.create("w1", opts);
  await tick();
  await chats.setModel(a.summary.id, "sonnet");
  expect(opens[0]!.conv.modelsSet).toEqual(["sonnet"]);
  expect(opens).toHaveLength(1);
  expect(onDisk(a.summary.id).model).toBe("sonnet");
  await chats.setModel(a.summary.id, "");
  expect(opens[0]!.conv.modelsSet).toEqual(["sonnet", undefined]);
  expect(chats.modelOf(a.summary.id)).toBeUndefined();
  await chats.setModel(a.summary.id, "opus");
  await chats.pause(a.summary.id);
  chats.prompt(a.summary.id, "re", "re");
  await tick();
  expect(opens[1]!.o.model).toBe("opus");
});

test("a model the engine no longer lists falls back to its default at open", async () => {
  const { chats, opens } = prepare();
  const a = await chats.create("w1", { ...opts, model: "gone" });
  await tick();
  await tick();
  expect(opens[0]!.conv.modelsSet).toEqual([undefined]);
  expect(chats.modelOf(a.summary.id)).toBeUndefined();
  expect(await chats.models(a.summary.id)).toEqual(opens[0]!.conv.list);
});
