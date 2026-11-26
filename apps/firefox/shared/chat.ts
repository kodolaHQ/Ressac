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
  | { type: "tool_call"; toolCallId: string; title: string; kind: ToolKind; status: "pending" | "in_progress" }
  | { type: "tool_call_update"; toolCallId: string; status: "in_progress" | "completed" | "failed"; /** The tab it opened or navigated, once done (open_tab, navigate). */ tab?: string }
  | { type: "request_question"; requestId: string; questions: ChatQuestion[] }
  | { type: "turn_end"; stopReason: "end_turn" | "cancelled" | "refusal" | "max_turns" | "error"; error?: string };

export type ChatItem =
  | {
      kind: "user";
      id: string;
      /** The whole message as the engine got it (masked): Ressac's context and the pages' data included. */
      text: string;
      /** What the bubble shows when it differs from `text`: the user's own words, without the context or the pages' data. */
      display?: string;
      /** The tab, the @ pages and ⌘T's pages that went with it (masked): small lines under the bubble. */
      pages?: { title: string; url: string }[];
      /** Never reached the engine (cancelled, or the app quit first). */
      unsent?: true;
    }
  | { kind: "agent"; id: string; text: string }
  | { kind: "tool"; id: string; title: string; toolKind: ToolKind; status: "pending" | "in_progress" | "completed" | "failed"; /** The tab it opened or navigated: its line selects it. */ tab?: string }
  | { kind: "question"; id: string; questions: ChatQuestion[]; answer?: Record<string, string> | "cancelled" }
  | { kind: "notice"; id: string; text: string };

/** "queued" = « En attente d'une discussion libre ». */
export type ChatState = "starting" | "ready" | "running" | "waiting" | "paused" | "error" | "signed-out" | "queued";

export interface ChatSummary {
  id: string;
  title: string;
  engine: "claude" | "codex" | "own";
  profile: string;
  mode: "browser" | "workshop";
  state: ChatState;
  updatedAt: number;
  messages: number;
  /** The engine keeps a conversation of its own for it (it ran a turn): « Supprimer » can erase that history too. */
  engineHistory?: true;
}

/** A model the chat's picker offers. `value` "": the engine's default; `cloud`: an Ollama cloud model's host (off this Mac). */
export interface ChatModel {
  value: string;
  name: string;
  description?: string;
  cloud?: string;
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
  /** Ressac's text waiting to go before the next message (the page's context, an app's prefix): masked then, never typed. */
  prefix?: string;
  /** The window's panel shows the terminal on this conversation (« Mode avancé »), whatever the UI last knew. */
  advanced?: true;
  /** Own model behind a non-loopback API: its host (the « en ligne » mark). */
  remote?: string;
  /** The model picker's choice (`value` "": the engine's default); absent when Réglages' model applies (Ollama, an API). */
  model?: { value: string; name: string };
}

/** `pasted`: [start, end] ranges of pasted text; `clear`: labels the user chose to send in clear. */
/** The composer's « / » commands that run a tool through the agent: the host puts their words before the user's text. */
export const CHAT_COMMANDS = ["search", "read", "tabs", "history", "bookmarks"] as const;
export type ChatCommand = (typeof CHAT_COMMANDS)[number];
/** The commands that take the user's text after them (the query). */
export const COMMAND_WITH_TEXT: ReadonlySet<ChatCommand> = new Set(["search", "history", "bookmarks"]);
/**
 * A « @ » reference: an open tab by its id (the host takes its title and address from the real tab, and the agent may read
 * it in this discussion with no card), or a page of the history or the bookmarks (its title and address, nothing granted).
 */
export type ChatRef = { tab: string } | { title: string; url: string };

export interface ChatDraft {
  text: string;
  pasted: [number, number][];
  clear: string[];
  command?: ChatCommand;
  refs?: ChatRef[];
}
