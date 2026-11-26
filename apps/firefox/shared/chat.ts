// Engine-neutral chat model, shared by the host and the UI bundles: types only.
import type { AgentPanelState } from "./api";

export type ToolKind = "read" | "edit" | "search" | "fetch" | "execute" | "other";

export interface ChatQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/** Key = question text, value = chosen label(s) joined by ", " (Claude's AskUserQuestion shape). */
export type AskReply = { answers: Record<string, string> } | { cancelled: true };

export type SessionUpdate =
  | { type: "agent_message_chunk"; messageId: string; text: string }
  | { type: "agent_message"; messageId: string; text: string }
  | { type: "agent_thought_chunk"; text: string }
  | { type: "tool_call"; toolCallId: string; title: string; kind: ToolKind; status: "pending" | "in_progress" }
  | { type: "tool_call_update"; toolCallId: string; status: "in_progress" | "completed" | "failed"; summary?: string }
  | { type: "request_question"; requestId: string; questions: ChatQuestion[] }
  | { type: "turn_end"; stopReason: "end_turn" | "cancelled" | "refusal" | "max_turns" | "error"; error?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number };

export type ChatItem =
  | { kind: "user"; id: string; text: string; /** Never reached the engine (cancelled, or the app quit first). */ unsent?: true }
  | { kind: "agent"; id: string; text: string }
  | { kind: "tool"; id: string; title: string; toolKind: ToolKind; status: "pending" | "in_progress" | "completed" | "failed"; summary?: string }
  | { kind: "question"; id: string; questions: ChatQuestion[]; answer?: Record<string, string> | "cancelled" }
  | { kind: "notice"; id: string; text: string };

/** "queued" = « En attente d'une discussion libre ». */
export type ChatState = "starting" | "ready" | "running" | "waiting" | "paused" | "error" | "signed-out" | "queued";

export interface ChatSummary {
  id: string;
  title: string;
  engine: "claude" | "codex";
  profile: string;
  mode: "browser" | "workshop";
  state: ChatState;
  updatedAt: number;
  messages: number;
}

export interface ChatView {
  summary: ChatSummary;
  items: ChatItem[];
  streaming?: { messageId: string; text: string };
  error?: string;
  /** While the engine starts: the CLI download, the machine, the image build step, or the instruction review card (`chat.review`). */
  preparing?: Extract<AgentPanelState, { state: "preparing" } | { state: "review" }>;
  /** Messages sent before the discussion's session existed: masked and sent once it does. */
  waiting?: number;
}

/** `pasted`: [start, end] ranges of pasted text; `clear`: labels the user chose to send in clear. */
export interface ChatDraft {
  text: string;
  pasted: [number, number][];
  clear: string[];
}
