import { say } from "../i18n.js";
import { AI_CLOSED_ERROR, EMBED_MODEL, LlamaModel, type AiProcess, type AiState } from "./llama-model.js";
import type { Writer } from "./writer.js";

export interface LocalAiOptions {
  /** `<browser profile>/local-ai`; the search model is downloaded there in `embed/`. */
  folder: string;
  launch?: (cmd: string, args: string[], o: { cwd: string }) => AiProcess;
  /** The llama-server binary; absent, the search server cannot start. */
  llamaServer?: string;
  /** Test overrides of the search model's download. */
  embedUrl?: string;
  embedSha256?: string;
  embedServerUrl?: string;
  clock?: () => number;
  onState?: (e: AiState, error?: string) => void;
  /** Polling interval of /v1/models at startup (500 ms by default). */
  pollMs?: number;
  /** Inactivity check interval (5 s by default). */
  idleCheckMs?: number;
  /** Maximum wait, at close, for a cancelled install to finish (3 s by default). */
  cancelDelayMs?: number;
  /** The shown language, read when an install error is written (default: English). */
  locale?: () => string;
  /** Writes for the kernels (workflow `ressac.gemma`, action layouts); absent, those calls fail with the no-account error. */
  writer?: Writer;
}

/**
 * Local AI as seen by a kernel. Once `fermer()` is called (kernel shutdown), its calls are refused: a late
 * harvest does not relaunch the server. The next kernel (another agent profile) gets a new access.
 */
export interface AiAccess {
  gemma: LocalAi["gemma"];
  close(): Promise<void>;
}

export class LocalAi {
  /** Closed (the browser quits): nothing starts llama-server anymore. */
  private closed = false;
  /** The search model (⌘T Demander): its own llama-server and port, started by its users. */
  readonly embed: LlamaModel;

  constructor(private readonly o: LocalAiOptions) {
    const common = { folder: o.folder, llamaServer: o.llamaServer, launch: o.launch, clock: o.clock, pollMs: o.pollMs, idleCheckMs: o.idleCheckMs, cancelDelayMs: o.cancelDelayMs, locale: o.locale };
    // RESSAC_EMBED_SERVER_URL (or `embedServerUrl`): a search server already running (tests), taken as installed.
    this.embed = new LlamaModel(EMBED_MODEL, { ...common, urlOverride: o.embedUrl, sha256Override: o.embedSha256, serverUrl: o.embedServerUrl ?? process.env.RESSAC_EMBED_SERVER_URL, onState: o.onState });
  }

  private say(id: string, args?: Record<string, string | number>): string {
    return say(this.o.locale?.() ?? "en", id, args);
  }

  /** Which of Ressac's models are in place. */
  async check(): Promise<{ embed: boolean }> {
    return { embed: this.embed.installed() };
  }

  /** Cancels the search model's install in progress, if any (without waiting for its end). */
  cancelInstall(): void {
    this.embed.cancelInstall();
  }

  /** A writing job (the kernels' `gemma`, kept under that name): goes to the user's agent; without a writer, the no-account error. */
  gemma(o: { prompt: string; images?: string[]; json?: boolean; signal?: AbortSignal }): Promise<string | unknown> {
    if (this.closed) return Promise.reject(new Error(AI_CLOSED_ERROR));
    const w = this.o.writer;
    return w ? w({ prompt: o.prompt, images: o.images, json: o.json, signal: o.signal }) : Promise.reject(new Error(this.say("kernel-writer-none")));
  }

  /** Stops the search server and cancels its install for good: gemma() is refused afterwards (stopServers(), on the other hand, allows a relaunch). */
  async close(): Promise<void> {
    this.closed = true;
    await this.embed.close();
  }

  /** An access for a kernel, closed with it (see AiAccess). The search model is the host's and stays. */
  access(): AiAccess {
    let closed = false;
    return {
      gemma: (o) => (closed ? Promise.reject(new Error(AI_CLOSED_ERROR)) : this.gemma(o)),
      close: async () => void (closed = true),
    };
  }

  /** AI off: stops the search server (a later call starts it again). */
  stopServers(): Promise<void> {
    return this.embed.stop();
  }
}
