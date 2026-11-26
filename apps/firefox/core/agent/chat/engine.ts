import type { AskReply, SessionUpdate, ToolKind } from "../../../shared/chat";

/** The subset of the kernel LaunchSpec adapters use (structural, so the kernel's satisfies it). */
export interface LaunchSpecLike {
  command(engineArgs: string[]): string[];
  env: Record<string, string>;
  codexConfig?: unknown;
  stop(): Promise<void>;
  ended(): void;
}

export interface EngineConversation {
  /** Claude session uuid, Codex thread id: stored for resume. */
  readonly engineSessionId: string;
  /** One user turn (already masked). */
  prompt(text: string): void;
  /** Ends the running turn, the conversation stays. */
  cancel(): void;
  answer(requestId: string, reply: AskReply): void;
  /** Stops the process where it runs. */
  close(): Promise<void>;
  onUpdate(cb: (u: SessionUpdate) => void): () => void;
  onEnd(cb: (e: { code: number | null; error?: string }) => void): () => void;
}

export interface ChatEngine {
  readonly id: "claude" | "codex";
  readonly capabilities: { partialText: boolean; thinking: boolean; ask: boolean; resumeById: boolean };
  /** Starts or resumes one conversation; resolves once the engine is ready for a prompt. */
  open(o: { chatId: string; resumeId?: string; launch: LaunchSpecLike; signal: AbortSignal }): Promise<EngineConversation>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** French UI title and kind for a tool call; the same map serves both engines. */
export function toolTitle(_engine: "claude" | "codex", name: string, input: unknown): { title: string; kind: ToolKind } {
  const bare = name.replace(/^mcp__ressac__/, "");
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (bare) {
    case "read_tab":
      return { title: `Lit la page « ${str(i.title) || "la page"} »`, kind: "read" };
    case "fill":
    case "fill_field":
    case "type_text":
      return { title: "Remplit le formulaire", kind: "edit" };
    case "click":
      return { title: "Clique sur la page", kind: "edit" };
    case "navigate":
    case "open_tab":
      return { title: `Ouvre ${hostOf(str(i.url)) || "une page"}`, kind: "fetch" };
    case "search_web":
      return { title: `Cherche « ${str(i.query)} »`, kind: "search" };
    case "Read":
    case "Glob":
    case "Grep":
      return { title: "Lit un fichier", kind: "read" };
    case "Write":
    case "Edit":
      return { title: `Modifie ${str(i.file_path).split("/").pop() || "un fichier"}`, kind: "edit" };
    case "Bash":
    case "commandExecution":
      return { title: "Lance une commande", kind: "execute" };
    default:
      return { title: bare, kind: "other" };
  }
}
