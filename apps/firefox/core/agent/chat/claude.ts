// The Claude engine: the Agent SDK drives the workshop's pinned `claude` over stream-json pipes.
// The kernel's LaunchSpec owns the lockdown flags; this adapter sets no SDK option that maps to one of them.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { query, type PermissionResult, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AskReply, ChatQuestion } from "../../../shared/chat";
import { engineEvents, toolTitle, type ChatEngine, type EngineConversation, type EngineModel, type LaunchSpecLike, type ModelOption } from "./engine";

const AUTH = /\b(log ?in|not logged in|authenticat\w*|401)\b/i;

export const claudeEngine: ChatEngine<LaunchSpecLike, ModelOption> = {
  id: "claude",

  async open({ resumeId, sessionId, launch, signal, tabTitle, model }): Promise<EngineConversation> {
    const engineSessionId = resumeId ?? sessionId ?? randomUUID();
    const events = engineEvents(launch);
    const { emit } = events;

    // The prompt iterable: one SDKUserMessage per user turn, ended by close().
    const queue: SDKUserMessage[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const push = () => (wake?.(), (wake = undefined));
    async function* input(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
      }
    }

    const questions = new Map<string, (r: AskReply) => void>();
    const tools = new Set<string>();
    let messageId = "";
    let cancelling = false;
    let authFailed = false;
    // Claude Code reports apiKeySource "none" for subscribers too: only a missing token proves a signed-out CLI.
    let noToken = false;
    let running = false;
    // The model asked for, and the one the CLI runs: set_model goes before the next message when they differ.
    let wanted = model;
    let applied = model;

    const abort = new AbortController();
    if (signal.aborted) abort.abort();
    else signal.addEventListener("abort", () => abort.abort(), { once: true });

    const q = query({
      prompt: input(),
      options: {
        abortController: abort,
        cwd: "/workspace",
        // The SDK resolves its own bundled binary unless a path is given, and throws when that optional package is
        // absent (we skip it at install). This name is never run: spawnClaudeCodeProcess builds the real argv.
        pathToClaudeCodeExecutable: "claude",
        // Without it the SDK sends an empty system prompt; the terminal agent runs on Claude Code's own (+ the kernel's append file).
        systemPrompt: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
        permissionMode: "default",
        ...(model ? { model } : {}),
        ...(resumeId ? { resume: resumeId } : { sessionId: engineSessionId }),
        canUseTool: async (name, toolInput, { signal: toolSignal }): Promise<PermissionResult> => {
          if (name !== "AskUserQuestion") return { behavior: "allow", updatedInput: toolInput };
          const requestId = randomUUID();
          const reply = await new Promise<AskReply>((resolve) => {
            questions.set(requestId, resolve);
            toolSignal.addEventListener("abort", () => resolve({ cancelled: true }), { once: true });
            emit({ type: "request_question", requestId, questions: (toolInput.questions ?? []) as ChatQuestion[] });
          });
          questions.delete(requestId);
          return "answers" in reply
            ? { behavior: "allow", updatedInput: { ...toolInput, answers: reply.answers } }
            : { behavior: "deny", message: "L'utilisateur n'a pas répondu." };
        },
        spawnClaudeCodeProcess: (o) => {
          const cmd = launch.command(o.args);
          const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...launch.env }, signal: o.signal });
          events.watch(child);
          return child;
        },
      },
    });

    const handle = (m: SDKMessage) => {
      switch (m.type) {
        case "stream_event": {
          if (m.parent_tool_use_id) return;
          const e = m.event;
          if (e.type === "message_start") messageId = e.message.id;
          else if (e.type === "content_block_delta" && e.delta.type === "text_delta") emit({ type: "agent_message_chunk", messageId, text: e.delta.text });
          return;
        }
        case "assistant": {
          if (m.error === "authentication_failed") authFailed = true;
          const blocks = m.message.content;
          const text = blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
          if (text && !m.parent_tool_use_id) emit({ type: "agent_message", messageId: m.message.id, text });
          for (const b of blocks) {
            // The question card stands for AskUserQuestion; no tool line.
            if (b.type !== "tool_use" || b.name === "AskUserQuestion") continue;
            tools.add(b.id);
            emit({ type: "tool_call", toolCallId: b.id, ...toolTitle(b.name, b.input, { tabTitle }), status: "in_progress" });
          }
          return;
        }
        case "user": {
          const content = m.message.content;
          if (typeof content === "string") return;
          for (const b of content) {
            if (b.type !== "tool_result" || !tools.delete(b.tool_use_id)) continue;
            emit({ type: "tool_call_update", toolCallId: b.tool_use_id, status: b.is_error ? "failed" : "completed" });
          }
          return;
        }
        case "result": {
          const wasCancel = cancelling;
          cancelling = running = false;
          const said = m.subtype === "success" ? m.result : m.errors.join("\n");
          if (wasCancel) emit({ type: "turn_end", stopReason: "cancelled" });
          else if (m.is_error && (authFailed || ("api_error_status" in m && m.api_error_status === 401) || AUTH.test(said) || noToken))
            emit({ type: "turn_end", stopReason: "error", error: "signed-out" });
          else if (m.subtype === "error_max_turns") emit({ type: "turn_end", stopReason: "max_turns" });
          else if (m.is_error) emit({ type: "turn_end", stopReason: "error", ...(said ? { error: said } : {}) });
          else emit({ type: "turn_end", stopReason: m.stop_reason === "refusal" ? "refusal" : "end_turn" });
          authFailed = false;
          return;
        }
      }
    };

    try {
      noToken = (await q.initializationResult()).account?.tokenSource === "none";
    } catch (e) {
      await launch.stop();
      throw e;
    }
    // An iterator error after the process ended is the exit onEnd already reports.
    void (async () => {
      try {
        for await (const m of q) handle(m);
      } catch {}
    })();

    return {
      engineSessionId,
      prompt(text) {
        running = true;
        const send = () => (queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }), push());
        if (wanted === applied) return send();
        const asked = wanted;
        // Answered before the message goes: the turn runs on the new model. Refused: the old one runs, the next message asks again.
        q.setModel(asked).then(
          () => void (applied = asked),
          (e: unknown) => console.error("[chat] model refused:", e instanceof Error ? e.message : e),
        ).finally(send);
      },
      async models() {
        // Claude Code lists « default » (no --model) first: the empty choice.
        return (await q.initializationResult()).models.map(
          (m): EngineModel => ({ value: m.value === "default" ? "" : m.value, name: m.displayName, ...(m.description ? { description: m.description } : {}), ...(m.value === "default" ? { default: true as const } : {}) }),
        );
      },
      setModel(m) {
        wanted = m;
      },
      cancel() {
        if (!running) return;
        cancelling = true;
        q.interrupt().catch(() => {});
      },
      answer(requestId, reply) {
        questions.get(requestId)?.(reply);
      },
      async close() {
        closed = true;
        push();
        for (const resolve of questions.values()) resolve({ cancelled: true });
        await launch.stop();
      },
      onUpdate: events.onUpdate,
      onEnd: events.onEnd,
    };
  },
};
