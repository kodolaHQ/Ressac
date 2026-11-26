import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionUpdate } from "../../shared/chat";
import { codexEngine } from "../../core/agent/chat/codex";
import type { EngineConversation } from "../../core/agent/chat/engine";

// A fake `codex app-server`, shared with the chat e2e: logs every line it receives, scripts a turn by its prompt text.
const FAKE = join(import.meta.dirname, "..", "tools", "fake-codex-app-server.cjs");

const dirs: string[] = [];
const open: EngineConversation[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(o: { resumeId?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ressac-chat-codex-"));
  dirs.push(dir);
  const logFile = join(dir, "log.jsonl");
  const launch = {
    engineArgs: undefined as string[] | undefined,
    command(args: string[]) {
      this.engineArgs = args;
      return [process.execPath, FAKE];
    },
    env: { FAKE_CODEX_LOG: logFile },
    ended: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const conv = await codexEngine.open({ launch, signal: new AbortController().signal, tabTitle: (id) => (id === 7 ? "Le Monde" : undefined), ...o });
  open.push(conv);
  const updates: SessionUpdate[] = [];
  conv.onUpdate((u) => updates.push(u));
  const received = (): { id?: unknown; method?: string; params?: any; result?: any }[] =>
    readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const turnEnd = () => expect.poll(() => updates.some((u) => u.type === "turn_end")).toBe(true);
  return { conv, launch, updates, received, turnEnd };
}

test("handshake: initialize, initialized, then thread/start with the thread's policy", async () => {
  const { conv, launch, received } = await start();
  expect(launch.engineArgs).toEqual([]);
  const r = received();
  expect(r.map((m) => m.method)).toEqual(["initialize", "initialized", "thread/start"]);
  expect(r[0]!.params).toEqual({ clientInfo: { name: "ressac", title: "Ressac", version: expect.any(String) } });
  expect(r[1]!.id).toBeUndefined();
  expect(r[2]!.params).toEqual({ cwd: "/workspace", approvalPolicy: "never", sandbox: "danger-full-access" });
  expect(conv.engineSessionId).toBe("thr_new");
});

test("open({resumeId}) resumes the thread by id", async () => {
  const { conv, received } = await start({ resumeId: "thr_old" });
  expect(received()[2]).toMatchObject({ method: "thread/resume", params: { threadId: "thr_old" } });
  expect(conv.engineSessionId).toBe("thr_old");
});

test("a prompt starts a turn; deltas, the message and the end follow", async () => {
  const { conv, updates, received, turnEnd } = await start();
  conv.prompt("hello");
  await turnEnd();
  expect(received().find((m) => m.method === "turn/start")!.params).toEqual({ threadId: "thr_new", input: [{ type: "text", text: "hello" }] });
  expect(updates).toEqual([
    { type: "agent_message_chunk", messageId: "msg_1", text: "Bon" },
    { type: "agent_message_chunk", messageId: "msg_1", text: "jour" },
    { type: "agent_message", messageId: "msg_1", text: "Bonjour" },
    { type: "turn_end", stopReason: "end_turn" },
  ]);
});

test("an MCP tool call becomes a tool line", async () => {
  const { conv, updates, turnEnd } = await start();
  conv.prompt("tool");
  await turnEnd();
  expect(updates.filter((u) => u.type.startsWith("tool_call"))).toEqual([
    { type: "tool_call", toolCallId: "call_1", title: "Lit la page « Le Monde »", kind: "read", status: "in_progress" },
    { type: "tool_call_update", toolCallId: "call_1", status: "completed" },
  ]);
});

test("an approval request is accepted", async () => {
  const { conv, received, turnEnd } = await start();
  conv.prompt("approve");
  await turnEnd();
  expect(received().find((m) => m.id === "srv_1")).toEqual({ id: "srv_1", result: { decision: "accept" } });
});

test("requestUserInput becomes a question card and the answer goes back by question id", async () => {
  const { conv, updates, received, turnEnd } = await start();
  conv.prompt("ask");
  await expect.poll(() => updates.find((u) => u.type === "request_question")).toBeTruthy();
  const q = updates.find((u) => u.type === "request_question")!;
  if (q.type !== "request_question") throw new Error();
  expect(q.questions).toEqual([{ question: "Quelle couleur ?", header: "Couleur", options: [{ label: "Bleu", description: "le ciel" }], multiSelect: false }]);
  conv.answer(q.requestId, { answers: { "Quelle couleur ?": "Bleu" } });
  await turnEnd();
  expect(received().find((m) => m.id === "srv_1")).toEqual({ id: "srv_1", result: { answers: { q1: { answers: ["Bleu"] } } } });
});

test("cancel() during a turn interrupts that turn and ends it cancelled", async () => {
  const { conv, updates, received, turnEnd } = await start();
  conv.prompt("wait");
  await expect.poll(() => received().some((m) => m.method === "turn/start")).toBe(true);
  conv.cancel();
  await turnEnd();
  expect(received().find((m) => m.method === "turn/interrupt")!.params).toEqual({ threadId: "thr_new", turnId: "turn_1" });
  expect(updates).toContainEqual({ type: "turn_end", stopReason: "cancelled" });
});

test("cancel() with no running turn sends nothing", async () => {
  const { conv, received, turnEnd } = await start();
  conv.cancel();
  conv.prompt("hello");
  await turnEnd();
  expect(received().some((m) => m.method === "turn/interrupt")).toBe(false);
});

test("an unauthorized turn reads as signed out", async () => {
  const { conv, updates, turnEnd } = await start();
  conv.prompt("unauth");
  await turnEnd();
  expect(updates).toContainEqual({ type: "turn_end", stopReason: "error", error: "signed-out" });
});

test("close() stops the launch; the process exit calls ended() and onEnd once", async () => {
  const { conv, launch } = await start();
  const ends: unknown[] = [];
  conv.onEnd((e) => ends.push(e));
  await conv.close();
  open.splice(0);
  expect(launch.stop).toHaveBeenCalled();
  await expect.poll(() => ends).toEqual([{ code: 0 }]);
  expect(launch.ended).toHaveBeenCalledTimes(1);
});
