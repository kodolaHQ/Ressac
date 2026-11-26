import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AskReply, SessionUpdate, ToolKind } from "../../../shared/chat";

/** The subset of the kernel LaunchSpec adapters use (structural, so the kernel's satisfies it). */
export interface LaunchSpecLike {
  command(engineArgs: string[]): string[];
  env: Record<string, string>;
  stop(): Promise<void>;
  ended(): void;
}

/** A model of the engine's own list. `value` "" is the engine's default (no choice made); `default`: the one it runs then. */
export interface EngineModel { value: string; name: string; description?: string; default?: true }

/** Claude's and Codex's open option: a value from the engine's own list (checked by the host); absent, the engine's default. */
export type ModelOption = { model?: string };

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
  /** The engine's own model list (Claude, Codex). */
  models?(): Promise<EngineModel[]>;
  /** From the next message on, same conversation; undefined: the engine's default. */
  setModel?(model: string | undefined): void;
}

/** `L`: what the engine opens on (the kernel's LaunchSpec, or a host session); `X`: options only that engine takes. */
export interface ChatEngine<L = LaunchSpecLike, X = {}> {
  readonly id: "claude" | "codex" | "own";
  /** Starts or resumes one conversation; resolves once the engine is ready for a prompt. */
  /** `sessionId`: the id the host chose for a new discussion (engines that take one); `tabTitle`: see toolTitle. */
  open(
    o: {
      resumeId?: string;
      sessionId?: string;
      launch: L;
      signal: AbortSignal;
      tabTitle?: (id: unknown) => string | undefined;
    } & X,
  ): Promise<EngineConversation>;
}

type EndInfo = { code: number | null; error?: string };

/**
 * What both adapters share: the update and end subscribers, and the engine process's end, reported once with the tail of
 * its stderr on a failed exit. `beforeEnd` runs first (Codex fails its pending requests).
 */
export function engineEvents(launch: Pick<LaunchSpecLike, "ended">) {
  const updateCbs = new Set<(u: SessionUpdate) => void>();
  const endCbs = new Set<(e: EndInfo) => void>();
  return {
    emit: (u: SessionUpdate) => updateCbs.forEach((cb) => cb(u)),
    onUpdate(cb: (u: SessionUpdate) => void) {
      updateCbs.add(cb);
      return () => void updateCbs.delete(cb);
    },
    onEnd(cb: (e: EndInfo) => void) {
      endCbs.add(cb);
      return () => void endCbs.delete(cb);
    },
    /** Tells the end subscribers; the caller reports it once. */
    end: (e: EndInfo) => endCbs.forEach((cb) => cb(e)),
    watch(child: ChildProcessWithoutNullStreams, beforeEnd?: (error?: string) => void) {
      let stderrTail = "";
      let ended = false;
      child.stderr.on("data", (d) => (stderrTail = (stderrTail + d).slice(-2000)));
      const finish = (code: number | null, error?: string) => {
        if (ended) return;
        ended = true;
        beforeEnd?.(error);
        launch.ended();
        endCbs.forEach((cb) => cb(error ? { code, error } : { code }));
      };
      child.once("exit", (code) => finish(code, code ? stderrTail.trim() || undefined : undefined));
      child.once("error", (e) => finish(null, e.message));
    },
  };
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

const TAB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The tab open_tab opened, from its result (the kernel answers with the tab's id alone): a text, or MCP content blocks
 * (Claude's tool_result, Codex's result.content). Other tools: none.
 */
export function openedTab(name: string, result: unknown): { tab?: string } {
  const blocks = Array.isArray(result) ? result.map((b) => (b && typeof b === "object" && "text" in b ? str(b.text) : "")).join("") : result;
  const text = typeof blocks === "string" ? blocks.trim() : "";
  return name.replace(/^mcp__ressac__/, "") === "open_tab" && TAB_ID.test(text) ? { tab: text } : {};
}

/** French UI title and kind for a tool call; the same map serves both engines.
 *  `o.tabTitle` resolves a read_tab id to its page title (the input only carries the id). */
export function toolTitle(
  name: string,
  input: unknown,
  o?: { tabTitle?: (id: unknown) => string | undefined },
): { title: string; kind: ToolKind; tab?: string } {
  const bare = name.replace(/^mcp__ressac__/, "");
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (bare) {
    case "read_tab": {
      const t = o?.tabTitle?.(i.id) || str(i.title);
      return { title: t ? `Lit la page « ${t} »` : "Lit une page", kind: "read" };
    }
    case "navigate":
    case "open_tab": {
      const tab = bare === "navigate" && str(i.id) ? { tab: str(i.id) } : {};
      return { title: `Ouvre ${hostOf(str(i.url)) || "une page"}`, kind: "fetch", ...tab };
    }
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
