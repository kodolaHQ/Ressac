import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionUpdate } from "../../shared/chat";
import { claudeEngine } from "../../core/agent/chat/claude";
import type { EngineConversation } from "../../core/agent/chat/engine";

const fake = join(import.meta.dirname, "..", "tools", "fake-claude-stream.mjs");
const dirs: string[] = [];
const open: EngineConversation[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(o: { resumeId?: string; sessionId?: string } = {}, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ressac-chat-claude-"));
  dirs.push(dir);
  const logFile = join(dir, "log.jsonl");
  const launch = {
    engineArgs: [] as string[],
    command(args: string[]) {
      this.engineArgs = args;
      return [process.execPath, fake, ...args];
    },
    env: { FAKE_CLAUDE_LOG: logFile, ...env },
    ended: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const conv = await claudeEngine.open({ launch, signal: new AbortController().signal, ...o });
  open.push(conv);
  const updates: SessionUpdate[] = [];
  conv.onUpdate((u) => updates.push(u));
  const received = () => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { conv, launch, updates, received };
}

test("argv keeps the kernel lockdown and the SDK adds no duplicate", async () => {
  const { launch, conv } = await start({ sessionId: "11111111-1111-4111-8111-111111111111" });
  const a = launch.engineArgs;
  for (const f of ["--settings", "--setting-sources", "--mcp-config", "--tools", "--allowedTools", "--disallowedTools", "--dangerously-skip-permissions", "--append-system-prompt"])
    expect(a.some((x) => x === f || x.startsWith(`${f}=`))).toBe(false);
  expect(a[a.indexOf("--output-format") + 1]).toBe("stream-json");
  expect(a[a.indexOf("--input-format") + 1]).toBe("stream-json");
  expect(a.join(" ")).toContain("11111111-1111-4111-8111-111111111111");
  expect(conv.engineSessionId).toBe("11111111-1111-4111-8111-111111111111");
});

test("keeps Claude Code's own system prompt (the SDK default would replace it with an empty one)", async () => {
  const { received } = await start();
  const init = received().find((m) => m.request?.subtype === "initialize");
  expect(init.request.systemPrompt).toBeUndefined();
});

test("streams text then ends the turn", async () => {
  const { conv, updates } = await start();
  conv.prompt("hello");
  await expect.poll(() => updates.some((u) => u.type === "turn_end")).toBe(true);
  expect(updates).toEqual([
    { type: "agent_message_chunk", messageId: "msg_1", text: "Bon" },
    { type: "agent_message_chunk", messageId: "msg_1", text: "jour" },
    { type: "agent_message", messageId: "msg_1", text: "Bonjour" },
    { type: "turn_end", stopReason: "end_turn" },
  ]);
});

test("tool_use becomes a tool line", async () => {
  const { conv, updates } = await start();
  conv.prompt("tool");
  await expect.poll(() => updates.some((u) => u.type === "turn_end")).toBe(true);
  expect(updates.filter((u) => u.type.startsWith("tool_call"))).toEqual([
    { type: "tool_call", toolCallId: "tu_1", title: "Lit une page", kind: "read", status: "in_progress" },
    { type: "tool_call_update", toolCallId: "tu_1", status: "completed" },
  ]);
});

test("AskUserQuestion becomes a question card and the answer goes back", async () => {
  const { conv, updates, received } = await start();
  conv.prompt("ask");
  await expect.poll(() => updates.find((u) => u.type === "request_question")).toBeTruthy();
  const q = updates.find((u) => u.type === "request_question")!;
  if (q.type !== "request_question") throw new Error("unreachable");
  expect(q.questions[0]!.question).toBe("Quel train ?");
  conv.answer(q.requestId, { answers: { "Quel train ?": "8 h 04" } });
  await expect.poll(() => received().find((m) => m.type === "control_response")).toMatchObject({
    response: { subtype: "success", request_id: "ask_1", response: { behavior: "allow", updatedInput: { answers: { "Quel train ?": "8 h 04" }, questions: expect.any(Array) } } },
  });
  await expect.poll(() => updates.at(-1)).toEqual({ type: "turn_end", stopReason: "end_turn" });
});

test("a cancelled question is denied", async () => {
  const { conv, updates, received } = await start();
  conv.prompt("ask");
  await expect.poll(() => updates.find((u) => u.type === "request_question")).toBeTruthy();
  const q = updates.find((u) => u.type === "request_question")!;
  if (q.type !== "request_question") throw new Error("unreachable");
  conv.answer(q.requestId, { cancelled: true });
  await expect.poll(() => received().find((m) => m.type === "control_response")).toMatchObject({
    response: { response: { behavior: "deny", message: "L'utilisateur n'a pas répondu." } },
  });
});

test("cancel interrupts the turn", async () => {
  const { conv, updates, received } = await start();
  conv.prompt("wait");
  await expect.poll(() => received().some((m) => m.type === "user")).toBe(true);
  conv.cancel();
  await expect.poll(() => received().some((m) => m.type === "control_request" && m.request.subtype === "interrupt")).toBe(true);
  await expect.poll(() => updates.find((u) => u.type === "turn_end")).toEqual({ type: "turn_end", stopReason: "cancelled" });
});

test("an auth failure ends the turn as signed-out", async () => {
  const { conv, updates } = await start();
  conv.prompt("auth");
  await expect.poll(() => updates.find((u) => u.type === "turn_end")).toEqual({ type: "turn_end", stopReason: "error", error: "signed-out" });
});

test("an error for a signed-in user stays an error", async () => {
  const { conv, updates } = await start();
  conv.prompt("error");
  await expect.poll(() => updates.find((u) => u.type === "turn_end")).toEqual({ type: "turn_end", stopReason: "error", error: "Overloaded: request not authorized to retry (529)" });
});

test("an error with no token is signed-out", async () => {
  const { conv, updates } = await start({}, { FAKE_TOKEN_SOURCE: "none" });
  conv.prompt("error");
  await expect.poll(() => updates.find((u) => u.type === "turn_end")).toEqual({ type: "turn_end", stopReason: "error", error: "signed-out" });
});

test("a cancel with no turn running does not mark the next turn cancelled", async () => {
  const { conv, updates } = await start();
  conv.cancel();
  conv.prompt("hello");
  await expect.poll(() => updates.find((u) => u.type === "turn_end")).toEqual({ type: "turn_end", stopReason: "end_turn" });
});

test("process exit calls ended() once and onEnd fires", async () => {
  const { conv, launch } = await start();
  const ends: { code: number | null }[] = [];
  conv.onEnd((e) => ends.push(e));
  conv.prompt("exit");
  await expect.poll(() => ends.length).toBe(1);
  expect(ends[0]!.code).toBe(3);
  expect(launch.ended).toHaveBeenCalledTimes(1);
  await conv.close();
  expect(launch.stop).toHaveBeenCalled();
  expect(launch.ended).toHaveBeenCalledTimes(1);
});

test("resume passes the stored id", async () => {
  const { launch, conv } = await start({ resumeId: "22222222-2222-4222-8222-222222222222" });
  expect(launch.engineArgs.join(" ")).toContain("--resume");
  expect(launch.engineArgs.join(" ")).toContain("22222222-2222-4222-8222-222222222222");
  expect(conv.engineSessionId).toBe("22222222-2222-4222-8222-222222222222");
});
