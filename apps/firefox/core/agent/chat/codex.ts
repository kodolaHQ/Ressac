// The Codex engine: `codex app-server` in the workshop, JSON-RPC over stdio JSONL (no `jsonrpc` field).
// The kernel's LaunchSpec owns the lockdown flags (before `app-server`); this adapter only sets the thread's policy.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ChatQuestion } from "../../../shared/chat";
import type {
  AgentMessageDelta,
  InitializeParams,
  ItemNotification,
  ModelListResponse,
  RequestUserInputParams,
  RequestUserInputResponse,
  RpcId,
  RpcRequest,
  RpcResponse,
  ThreadItem,
  ThreadResponse,
  ThreadResumeParams,
  ThreadStartParams,
  TurnHolder,
  TurnStartParams,
} from "./codex-protocol";
import { engineEvents, openedTab, toolTitle, type ChatEngine, type EngineConversation, type EngineModel, type LaunchSpecLike, type ModelOption } from "./engine";

const AUTH = /\b(log ?in|not logged in|authenticat\w*|unauthori[sz]ed|401)\b/i;
// The app-server only shows it in its user agent.
const CLIENT: InitializeParams = { clientInfo: { name: "ressac", title: "Ressac", version: "1" } };
const TOOL_ITEMS = new Set(["mcpToolCall", "commandExecution", "fileChange"]);

function itemTitle(item: ThreadItem, tabTitle?: (id: unknown) => string | undefined) {
  if (item.type === "mcpToolCall" && "tool" in item) return toolTitle(item.tool, item.arguments, { tabTitle });
  if (item.type === "fileChange" && "changes" in item) return toolTitle("Edit", { file_path: item.changes[0]?.path });
  return toolTitle("commandExecution", {});
}

export const codexEngine: ChatEngine<LaunchSpecLike, ModelOption> = {
  id: "codex",

  async open({ resumeId, launch, signal, tabTitle, model }): Promise<EngineConversation> {
    const events = engineEvents(launch);
    const { emit } = events;

    const cmd = launch.command([]);
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...launch.env }, signal });
    const send = (m: object) => void (child.stdin.writable && child.stdin.write(JSON.stringify(m) + "\n"));

    let nextId = 0;
    const pending = new Map<RpcId, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
    const request = <T>(method: string, params: unknown) =>
      new Promise<T>((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
        send({ id, method, params });
      });

    events.watch(child, (error) => {
      for (const p of pending.values()) p.reject(new Error(error ?? "codex app-server ended"));
      pending.clear();
    });

    let threadId = "";
    let turnId = "";
    let running = false;
    let cancelling = false;
    let interrupted = false;
    const questions = new Map<string, { rpcId: RpcId; ids: Map<string, string> }>();

    // Once both the cancel and the turn id are known (the turn/start answer can come after cancel()).
    const interrupt = () => {
      if (!cancelling || interrupted || !turnId) return;
      interrupted = true;
      request("turn/interrupt", { threadId, turnId }).catch(() => {});
    };
    const setTurn = (id: string) => {
      turnId = id;
      interrupt();
    };

    const onRequest = (m: RpcRequest) => {
      if (m.method.endsWith("/requestApproval")) return send({ id: m.id, result: { decision: "accept" } });
      if (m.method === "item/tool/requestUserInput") {
        const p = m.params as RequestUserInputParams;
        const requestId = String(m.id);
        questions.set(requestId, { rpcId: m.id, ids: new Map(p.questions.map((q) => [q.question, q.id])) });
        const qs: ChatQuestion[] = p.questions.map((q) => ({ question: q.question, header: q.header, options: q.options ?? [], multiSelect: false }));
        return emit({ type: "request_question", requestId, questions: qs });
      }
      send({ id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } });
    };

    const onNotification = (method: string, params: unknown) => {
      switch (method) {
        case "turn/started":
          return setTurn((params as TurnHolder).turn.id);
        case "item/agentMessage/delta": {
          const p = params as AgentMessageDelta;
          return emit({ type: "agent_message_chunk", messageId: p.itemId, text: p.delta });
        }
        case "item/started": {
          const { item } = params as ItemNotification;
          if (TOOL_ITEMS.has(item.type)) emit({ type: "tool_call", toolCallId: item.id, ...itemTitle(item, tabTitle), status: "in_progress" });
          return;
        }
        case "item/completed": {
          const { item } = params as ItemNotification;
          if (item.type === "agentMessage" && "text" in item) emit({ type: "agent_message", messageId: item.id, text: item.text });
          else if (TOOL_ITEMS.has(item.type)) {
            const done = "status" in item && item.status === "completed";
            const tab = done && item.type === "mcpToolCall" && "tool" in item ? openedTab(item.tool, "result" in item ? item.result?.content : undefined) : {};
            emit({ type: "tool_call_update", toolCallId: item.id, status: done ? "completed" : "failed", ...tab });
          }
          return;
        }
        case "turn/completed": {
          const { turn } = params as TurnHolder;
          running = cancelling = interrupted = false;
          turnId = "";
          const said = turn.error?.message ?? "";
          if (turn.status === "interrupted") emit({ type: "turn_end", stopReason: "cancelled" });
          else if (turn.status === "failed" && (turn.error?.codexErrorInfo === "unauthorized" || AUTH.test(said)))
            emit({ type: "turn_end", stopReason: "error", error: "signed-out" });
          else if (turn.status === "failed") emit({ type: "turn_end", stopReason: "error", ...(said ? { error: said } : {}) });
          else emit({ type: "turn_end", stopReason: "end_turn" });
          return;
        }
      }
    };

    createInterface({ input: child.stdout }).on("line", (line) => {
      let m: Partial<RpcRequest & RpcResponse>;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.method !== undefined && m.id !== undefined) onRequest(m as RpcRequest);
      else if (m.method !== undefined) onNotification(m.method, m.params);
      else if (m.id !== undefined) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p?.reject(new Error(m.error.message));
        else p?.resolve(m.result);
      }
    });

    try {
      await request("initialize", CLIENT);
      send({ method: "initialized" });
      const pick = model ? { model } : {};
      const start: ThreadStartParams = { cwd: "/workspace", approvalPolicy: "never", sandbox: "danger-full-access", ...pick };
      const resume: ThreadResumeParams = { threadId: resumeId ?? "", ...pick };
      threadId = (await (resumeId ? request<ThreadResponse>("thread/resume", resume) : request<ThreadResponse>("thread/start", start))).thread.id;
    } catch (e) {
      await launch.stop();
      throw e;
    }

    const models = async (): Promise<EngineModel[]> =>
      (await request<ModelListResponse>("model/list", {})).data
        .filter((m) => !m.hidden)
        .map((m) => ({ value: m.model || m.id, name: m.displayName || m.model || m.id, ...(m.description ? { description: m.description } : {}), ...(m.isDefault ? { default: true as const } : {}) }));
    // A turn's model stays the thread's: going back to the default sends the default's id once.
    let wanted = model;
    let overridden = !!model;
    const turnModel = async (): Promise<string | undefined> => {
      if (wanted) return (overridden = true), wanted;
      if (!overridden) return undefined;
      const d = (await models().catch(() => [])).find((m) => m.default)?.value;
      if (d) overridden = false;
      return d;
    };

    return {
      engineSessionId: threadId,
      models,
      setModel(m) {
        wanted = m;
      },
      prompt(text) {
        running = true;
        turnModel().then((m) => {
          const params: TurnStartParams = { threadId, input: [{ type: "text", text }], ...(m ? { model: m } : {}) };
          return request<TurnHolder>("turn/start", params);
        }).then(
          (r) => setTurn(r.turn.id),
          (e: Error) => {
            running = cancelling = false;
            emit({ type: "turn_end", stopReason: "error", error: AUTH.test(e.message) ? "signed-out" : e.message });
          },
        );
      },
      cancel() {
        if (!running) return;
        cancelling = true;
        interrupt();
      },
      answer(requestId, reply) {
        const q = questions.get(requestId);
        if (!q) return;
        questions.delete(requestId);
        const answers: RequestUserInputResponse["answers"] = {};
        if ("answers" in reply) for (const [text, value] of Object.entries(reply.answers)) {
          const id = q.ids.get(text);
          if (id) answers[id] = { answers: [value] };
        }
        send({ id: q.rpcId, result: { answers } satisfies RequestUserInputResponse });
      },
      async close() {
        child.stdin.end();
        await launch.stop();
      },
      onUpdate: events.onUpdate,
      onEnd: events.onEnd,
    };
  },
};
