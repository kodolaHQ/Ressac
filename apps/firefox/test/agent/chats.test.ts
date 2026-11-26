import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { LaunchSpec } from "@ressac/kernel";
import type { AskReply, ChatView, SessionUpdate } from "../../shared/chat";
import type { EngineConversation } from "../../core/agent/chat/engine";
import { ChatStore } from "../../core/agent/chat-store";
import { Chats, LIVE_MAX, SignedOutError, type OpenOptions } from "../../core/agent/chats";

class FakeConv implements EngineConversation {
  prompts: string[] = [];
  answers: [string, AskReply][] = [];
  cancels = 0;
  closed = false;
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
function prepare(auto = true) {
  const dir = mkdtempSync(join(tmpdir(), "ressac-chats-"));
  dirs.push(dir);
  const store = new ChatStore(join(dir, "chats"));
  const opens: Opened[] = [];
  const views: [string, ChatView][] = [];
  let clock = 1000;
  const chats = new Chats({
    store,
    now: () => ++clock,
    notify: (w, v) => views.push([w, v]),
    open: (o) =>
      new Promise((resolve, reject) => {
        const conv = new FakeConv(o.resumeId ?? o.sessionId ?? `thread-${opens.length + 1}`);
        const launch = { sessionId: `kernel-${opens.length + 1}` } as LaunchSpec;
        const opened: Opened = { o, conv, resolve: () => resolve({ conversation: conv, launch }), reject };
        opens.push(opened);
        if (auto) opened.resolve();
      }),
  });
  managers.push(chats);
  const state = (id: string) => views.filter(([, v]) => v.summary.id === id).at(-1)?.[1].summary.state;
  const onDisk = (id: string) => JSON.parse(readFileSync(join(dir, "chats", `${id}.json`), "utf8"));
  return { chats, store, opens, views, state, onDisk };
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
  conv.emit({ type: "tool_call_update", toolCallId: "t1", status: "completed", summary: "3 lignes" });
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
    { kind: "tool", id: "t1", title: "Lit une page", toolKind: "read", status: "completed", summary: "3 lignes" },
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
  await chats.pause(b.summary.id);
  opens[1]!.resolve();
  await tick();
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
  expect((await chats.list("w2", "perso")).find((s) => s.id === a.summary.id)?.state).toBe("paused");
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
  opens[1]!.reject(new Error("No conversation found"));
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
