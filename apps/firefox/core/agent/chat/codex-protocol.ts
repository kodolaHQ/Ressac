// `codex app-server` messages the chat uses, hand-written from codex-rs/app-server-protocol (v2) at tag rust-v0.169.0.
// JSON-RPC 2.0 over stdio JSONL without the `jsonrpc` field. Only the fields the adapter reads or sends.

export type RpcId = number | string;
export interface RpcRequest { id: RpcId; method: string; params?: unknown }
export interface RpcResponse { id: RpcId; result?: unknown; error?: { code: number; message: string } }

export interface InitializeParams { clientInfo: { name: string; title?: string; version: string } }

export interface ThreadStartParams {
  cwd: string;
  approvalPolicy: "never";
  sandbox: "danger-full-access";
  model?: string;
}
export interface ThreadResumeParams { threadId: string; model?: string }
/** thread/start and thread/resume results. */
export interface ThreadResponse { thread: { id: string } }

/** `model`: for this turn and the next ones (the thread keeps it). */
export interface TurnStartParams { threadId: string; input: { type: "text"; text: string }[]; model?: string }

/** model/list (first page). `model` is the id turns take; `isDefault`: the one used without a choice. */
export interface ModelListResponse {
  data: { id: string; model: string; displayName: string; description: string; hidden: boolean; isDefault: boolean }[];
  nextCursor: string | null;
}

export type CodexErrorInfo = string | Record<string, unknown>;
export interface Turn {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { message: string; codexErrorInfo?: CodexErrorInfo | null } | null;
}
/** turn/start result, turn/started and turn/completed params. */
export interface TurnHolder { turn: Turn }

export type ThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; arguments: unknown; status: "inProgress" | "completed" | "failed"; result?: { content?: unknown } | null }
  | { type: "commandExecution"; id: string; command: string; status: "inProgress" | "completed" | "failed" | "declined" }
  | { type: "fileChange"; id: string; changes: { path: string }[]; status: "inProgress" | "completed" | "failed" | "declined" }
  | { type: string; id: string; status?: string };
/** item/started and item/completed params. */
export interface ItemNotification { item: ThreadItem; threadId: string; turnId: string }
export interface AgentMessageDelta { threadId: string; turnId: string; itemId: string; delta: string }

/** item/tool/requestUserInput: no multi-select in this protocol. */
export interface RequestUserInputParams {
  questions: { id: string; header: string; question: string; options?: { label: string; description: string }[] | null }[];
}
/** Keyed by question id. */
export interface RequestUserInputResponse { answers: Record<string, { answers: string[] }> }
