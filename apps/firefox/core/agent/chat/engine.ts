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
  /** `sessionId`: the id the host chose for a new discussion (engines that take one); `tabTitle`: see toolTitle. */
  open(o: {
    chatId: string;
    resumeId?: string;
    sessionId?: string;
    launch: LaunchSpecLike;
    signal: AbortSignal;
    tabTitle?: (id: unknown) => string | undefined;
  }): Promise<EngineConversation>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

const FIXED: Record<string, { title: string; kind: ToolKind }> = {
  list_tabs: { title: "Regarde les onglets ouverts", kind: "read" },
  current_page: { title: "Regarde la page affichée", kind: "read" },
  capture_screen: { title: "Prend une capture de la page", kind: "read" },
  read_pages: { title: "Lit des pages", kind: "read" },
  search_history: { title: "Cherche dans l'historique", kind: "search" },
  read_history: { title: "Lit l'historique", kind: "read" },
  search_bookmarks: { title: "Cherche dans les favoris", kind: "search" },
  read_recap: { title: "Lit le récapitulatif", kind: "read" },
  show_recap: { title: "Affiche le récapitulatif", kind: "other" },
  fill_field: { title: "Remplit le formulaire", kind: "edit" },
  reveal_value: { title: "Demande une valeur masquée", kind: "other" },
  hand_over: { title: "Passe la main", kind: "other" },
  note_lesson: { title: "Note une leçon", kind: "other" },
  launch_app: { title: "Lance une appli", kind: "execute" },
  stop_app: { title: "Arrête une appli", kind: "execute" },
  app_log: { title: "Lit le journal d'une appli", kind: "read" },
  open_workflow: { title: "Ouvre un workflow", kind: "other" },
  harvest_widget: { title: "Met à jour un widget", kind: "fetch" },
  widget_data: { title: "Lit les données d'un widget", kind: "read" },
  widget_runs: { title: "Lit les exécutions d'un widget", kind: "read" },
  launch_action: { title: "Lance une action", kind: "execute" },
  action_runs: { title: "Lit les exécutions d'une action", kind: "read" },
  list_sites: { title: "Regarde les applis de site", kind: "read" },
  open_site: { title: "Ouvre une appli de site", kind: "other" },
  close_site: { title: "Ferme une appli de site", kind: "other" },
  site_memory: { title: "Consulte la mémoire d'un site", kind: "read" },
  tweak_errors: { title: "Lit les erreurs d'un réglage", kind: "read" },
};

/** French UI title and kind for a tool call; the same map serves both engines.
 *  `o.tabTitle` resolves a read_tab id to its page title (the input only carries the id). */
export function toolTitle(
  _engine: "claude" | "codex",
  name: string,
  input: unknown,
  o?: { tabTitle?: (id: unknown) => string | undefined },
): { title: string; kind: ToolKind } {
  const bare = name.replace(/^mcp__ressac__/, "");
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (bare) {
    case "read_tab": {
      const t = o?.tabTitle?.(i.id) || str(i.title);
      return { title: t ? `Lit la page « ${t} »` : "Lit une page", kind: "read" };
    }
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
      return FIXED[bare] ?? { title: bare, kind: "other" };
  }
}
