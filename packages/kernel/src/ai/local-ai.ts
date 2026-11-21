import { say } from "../i18n.js";
import { AI_CLOSED_ERROR, EMBED_MODEL, LlamaModel, type AiProcess, type AiState, type LlamaModelSpec } from "./llama-model.js";
import { AI_ABANDONED } from "./dispatcher.js";
import { toPplxScale } from "./d1-scale.js";
import type { Writer } from "./writer.js";

export interface LocalAiOptions {
  /** `<browser profile>/local-ai`; the decision model is downloaded there in `d1/`, the search model in `embed/`. */
  folder: string;
  launch?: (cmd: string, args: string[], o: { cwd: string }) => AiProcess;
  /** The llama-server binary; absent, the decision server cannot start. */
  llamaServer?: string;
  kevUrl?: string;
  /** Test overrides of the models' downloads. */
  decisionUrl?: string;
  decisionSha256?: string;
  /** Expected size of the model file (default: the shipped one); a longer download is aborted. */
  decisionBytes?: number;
  embedUrl?: string;
  embedSha256?: string;
  embedServerUrl?: string;
  port?: number;
  inactivityMs?: number;
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

export const D1_FILE = "d1-2B-Q4_K_M.gguf";
export const D1_REVISION = "4a181094d1b6addfaa3a0956f78e7ab2aa406a0c";
export const D1_URL = `https://huggingface.co/LiquidAI/d1-2B-GGUF/resolve/${D1_REVISION}/${D1_FILE}`;
export const D1_SHA256 = "adca5789ad30ae6027e8e936749bb9f19673097492ab26fa1c5b69643ca50b4b";
export const D1_BYTES = 1099629888;
/** Measured: every ai.sort state of the bench fits in 4096 tokens. */
const D1_CONTEXT = 4096;
/** llama-server splits `-c` across its parallel slots: 4 slots of D1_CONTEXT (the dispatcher sends up to 4 calls at once). */
const D1_SLOTS = 4;
export const D1_MODEL: LlamaModelSpec = {
  name: "d1",
  file: D1_FILE,
  url: D1_URL,
  sha256: D1_SHA256,
  bytes: D1_BYTES,
  // The physical batch defaults to 512: any longer prompt got HTTP 500, so it spans a whole slot.
  args: ["-ngl", "99", "-np", String(D1_SLOTS), "-c", String(D1_CONTEXT * D1_SLOTS), "-ub", String(D1_CONTEXT), "-b", String(D1_CONTEXT)],
  idleMs: 600_000,
};
const KEV_DELAY_MS = 60_000;
/** The call's timeout, and the caller's signal if there is one. */
const delayAnd = (ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms));
/** The caller's signal is raised: the call is abandoned (otherwise the original error). */
const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error(AI_ABANDONED);
};

/**
 * Local AI as seen by a kernel. Once `fermer()` is called (kernel shutdown), its calls are refused: a late
 * harvest does not relaunch the server. The next kernel (another agent profile) gets a new access.
 */
export interface AiAccess {
  kev: LocalAi["kev"];
  gemma: LocalAi["gemma"];
  close(): Promise<void>;
}

export class LocalAi {
  /** Closed (the browser quits): nothing starts llama-server anymore. */
  private closed = false;
  /** The decision model; RESSAC_KEV_URL (or `kevUrl`) points it at a server already running. */
  private readonly d1: LlamaModel;
  /** The search model (⌘T Demander): its own llama-server and port, started by its users. */
  readonly embed: LlamaModel;

  constructor(private readonly o: LocalAiOptions) {
    const imposed = o.kevUrl ?? process.env.RESSAC_KEV_URL;
    const common = { folder: o.folder, llamaServer: o.llamaServer, launch: o.launch, clock: o.clock, pollMs: o.pollMs, idleCheckMs: o.idleCheckMs, cancelDelayMs: o.cancelDelayMs, locale: o.locale };
    this.d1 = new LlamaModel(
      { ...D1_MODEL, port: o.port, idleMs: o.inactivityMs ?? D1_MODEL.idleMs },
      { ...common, urlOverride: o.decisionUrl, sha256Override: o.decisionSha256, bytesOverride: o.decisionBytes, serverUrl: imposed, onState: o.onState },
    );
    // RESSAC_EMBED_SERVER_URL (or `embedServerUrl`): a search server already running (tests), taken as installed.
    this.embed = new LlamaModel(EMBED_MODEL, { ...common, urlOverride: o.embedUrl, sha256Override: o.embedSha256, serverUrl: o.embedServerUrl ?? process.env.RESSAC_EMBED_SERVER_URL });
  }

  private say(id: string, args?: Record<string, string | number>): string {
    return say(this.o.locale?.() ?? "en", id, args);
  }

  /** The decision server's state. */
  state(): { state: AiState; error?: string } {
    return this.d1.state();
  }

  /** Which of Ressac's models are in place. */
  async check(): Promise<{ decision: boolean; embed: boolean }> {
    return { decision: this.d1.installed(), embed: this.embed.installed() };
  }

  /** Downloads the decision model into `d1/` (see LlamaModel.install). */
  installDecisionModel(onPercent: (percent: number | null) => void): Promise<void> {
    if (this.closed) return Promise.reject(new Error(AI_CLOSED_ERROR));
    return this.d1.install(onPercent);
  }

  /** Cancels the models' installs in progress, if any (without waiting for their end). */
  cancelInstall(): void {
    this.d1.cancelInstall();
    this.embed.cancelInstall();
  }

  async kev(body: { state: unknown; questions: Record<string, unknown> }, o: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.closed) throw new Error(AI_CLOSED_ERROR);
    checkAbort(o.signal);
    const url = await this.d1.ready();
    checkAbort(o.signal);
    let r: Response;
    try {
      r = await fetch(`${url}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: delayAnd(KEV_DELAY_MS, o.signal),
      });
    } catch (e) {
      checkAbort(o.signal);
      throw new Error(this.say("kernel-ai-llama-unreachable", { error: (e as Error).message }));
    }
    if (!r.ok) throw new Error(this.say("kernel-ai-llama-status", { status: r.status }));
    try {
      return toPplxScale(((await r.json()) as { answers: unknown }).answers);
    } catch (e) {
      checkAbort(o.signal);
      throw e;
    }
  }

  /** A writing job (the kernels' `gemma`, kept under that name): goes to the user's agent; without a writer, the no-account error. */
  gemma(o: { prompt: string; images?: string[]; json?: boolean; signal?: AbortSignal }): Promise<string | unknown> {
    if (this.closed) return Promise.reject(new Error(AI_CLOSED_ERROR));
    const w = this.o.writer;
    return w ? w({ prompt: o.prompt, images: o.images, json: o.json, signal: o.signal }) : Promise.reject(new Error(this.say("kernel-writer-none")));
  }

  /** Stops both servers and cancels the installs for good: kev() and gemma() are refused afterwards (stop(), on the other hand, allows a relaunch). */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.d1.close(), this.embed.close()]);
  }

  /** An access for a kernel, closed with it (see AiAccess). */
  access(): AiAccess {
    let closed = false;
    // Checked before the call: a closed access never starts llama-server; a close() during a startup cancels the launch.
    return {
      kev: (body, o) => (closed ? Promise.reject(new Error(AI_CLOSED_ERROR)) : this.kev(body, o)),
      gemma: (o) => (closed ? Promise.reject(new Error(AI_CLOSED_ERROR)) : this.gemma(o)),
      close: async () => {
        closed = true;
        await this.stop();
      },
    };
  }

  /** Stops the decision server (a kernel's end); the search model is the host's and stays. */
  stop(): Promise<void> {
    return this.d1.stop();
  }

  /** AI off: stops both servers (a later call starts them again). */
  async stopServers(): Promise<void> {
    await Promise.all([this.d1.stop(), this.embed.stop()]);
  }
}
