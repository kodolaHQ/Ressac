import { say } from "../i18n.js";
import { AI_CLOSED_ERROR, EMBED_MODEL, LlamaModel, type AiProcess, type AiState, type LlamaModelSpec } from "./llama-model.js";
import { WRITER_JSON_INVALID, AI_ABANDONED } from "./dispatcher.js";
import { toPplxScale } from "./d1-scale.js";
import type { Writer } from "./writer.js";

export interface LocalAiOptions {
  /** `<browser profile>/local-ai`; the decision model is downloaded there in `d1/`, the search model in `embed/`. */
  folder: string;
  launch?: (cmd: string, args: string[], o: { cwd: string }) => AiProcess;
  /** The llama-server binary; absent, the decision server cannot start. */
  llamaServer?: string;
  kevUrl?: string;
  ollamaUrl?: string;
  /** Test overrides of the models' downloads. */
  decisionUrl?: string;
  decisionSha256?: string;
  /** Expected size of the model file (default: the shipped one); a longer download is aborted. */
  decisionBytes?: number;
  embedUrl?: string;
  embedSha256?: string;
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
  /** Writes for the kernels (workflow `ai.write`, action layouts); absent, they go to Gemma. ⌘T always calls gemma() directly. */
  writer?: Writer;
}

export const D1_FILE = "d1-2B-Q4_K_M.gguf";
export const D1_REVISION = "4a181094d1b6addfaa3a0956f78e7ab2aa406a0c";
export const D1_URL = `https://huggingface.co/LiquidAI/d1-2B-GGUF/resolve/${D1_REVISION}/${D1_FILE}`;
export const D1_SHA256 = "adca5789ad30ae6027e8e936749bb9f19673097492ab26fa1c5b69643ca50b4b";
export const D1_BYTES = 1099629888;
/** Measured: every ai.sort and watcher state of the bench fits in 4096 tokens. */
const D1_CONTEXT = 4096;
/** llama-server splits `-c` across its parallel slots: 4 slots of D1_CONTEXT (the dispatcher sends up to 4 calls at once). */
const D1_SLOTS = 4;
export const D1_MODEL: LlamaModelSpec = {
  name: "d1",
  file: D1_FILE,
  url: D1_URL,
  sha256: D1_SHA256,
  bytes: D1_BYTES,
  port: 8008,
  args: ["-ngl", "99", "-np", String(D1_SLOTS), "-c", String(D1_CONTEXT * D1_SLOTS)],
  idleMs: 600_000,
};
/** In order of preference: the MLX build is faster, but not every Ollama serves it. */
export const GEMMA_MODELS = ["gemma4:e4b-mlx", "gemma4:e4b"];
/** Asked for when no Gemma build is detected. */
export const GEMMA_MODEL = GEMMA_MODELS[0]!;
const KEV_DELAY_MS = 60_000;
const GEMMA_DELAY_MS = 120_000;

/** Background calls (workflows, watches) free the 5-9 GB model a minute after their last use, not Ollama's 5 min or our old 10. */
export const BACKGROUND_KEEP_ALIVE = "1m";
/** ⌘T: the model stays warm between questions (a background call after it brings Ollama back to 1 min). */
export const INTERACTIVE_KEEP_ALIVE = "10m";

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
  /** Closed (the browser quits): nothing starts llama-server or calls Ollama anymore. */
  private closed = false;
  /** The decision model; RESSAC_KEV_URL (or `kevUrl`) points it at a server already running. */
  private readonly d1: LlamaModel;
  private readonly kevForced: boolean;
  /** The search model (⌘T Demander): its own llama-server and port, started by its users. */
  readonly embed: LlamaModel;
  readonly ollamaUrl: string;
  /** The Gemma build found in Ollama, kept until a call says it is gone. */
  private gemmaModel: string | undefined;

  constructor(private readonly o: LocalAiOptions) {
    const imposed = o.kevUrl ?? process.env.RESSAC_KEV_URL;
    this.kevForced = Boolean(imposed);
    this.ollamaUrl = o.ollamaUrl ?? process.env.RESSAC_OLLAMA_URL ?? "http://127.0.0.1:11434";
    const common = { folder: o.folder, llamaServer: o.llamaServer, launch: o.launch, clock: o.clock, pollMs: o.pollMs, idleCheckMs: o.idleCheckMs, cancelDelayMs: o.cancelDelayMs, locale: o.locale };
    this.d1 = new LlamaModel(
      { ...D1_MODEL, port: o.port ?? D1_MODEL.port, idleMs: o.inactivityMs ?? D1_MODEL.idleMs },
      { ...common, urlOverride: o.decisionUrl, sha256Override: o.decisionSha256, bytesOverride: o.decisionBytes, serverUrl: imposed, onState: o.onState },
    );
    this.embed = new LlamaModel(EMBED_MODEL, { ...common, urlOverride: o.embedUrl, sha256Override: o.embedSha256 });
  }

  private say(id: string, args?: Record<string, string | number>): string {
    return say(this.o.locale?.() ?? "en", id, args);
  }

  /** The decision server's state. */
  state(): { state: AiState; error?: string } {
    return this.d1.state();
  }

  /** The preferred Gemma build among the installed models (undefined: none, or Ollama unreachable). */
  private async detectGemma(): Promise<string | undefined> {
    try {
      const r = await fetch(`${this.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return undefined;
      const { models } = (await r.json()) as { models?: { name?: string }[] };
      return GEMMA_MODELS.find((g) => (models ?? []).some((m) => m.name === g));
    } catch {
      return undefined;
    }
  }

  async check(): Promise<{ ollama: boolean; gemma: boolean; gemmaModel: string | null; decision: boolean; embed: boolean }> {
    let ollama = false;
    let gemmaModel: string | null = null;
    try {
      const r = await fetch(`${this.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      ollama = r.ok;
      if (r.ok) {
        const { models } = (await r.json()) as { models?: { name?: string }[] };
        gemmaModel = GEMMA_MODELS.find((g) => (models ?? []).some((m) => m.name === g)) ?? null;
        this.gemmaModel = gemmaModel ?? undefined;
      }
    } catch { /* unreachable */ }
    return { ollama, gemma: gemmaModel !== null, gemmaModel, decision: this.kevForced || this.d1.installed(), embed: this.embed.installed() };
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

  /** keepAlive: how long Ollama keeps the model loaded after the call; background work by default, ⌘T asks longer. */
  async gemma(o: { prompt: string; images?: string[]; json?: boolean; signal?: AbortSignal; keepAlive?: string }): Promise<string | unknown> {
    if (this.closed) throw new Error(AI_CLOSED_ERROR);
    checkAbort(o.signal);
    // Nothing installed: ask for the preferred tag anyway, Ollama's refusal is the error.
    const model = (this.gemmaModel ??= await this.detectGemma()) ?? GEMMA_MODEL;
    checkAbort(o.signal);
    const message: Record<string, unknown> = { role: "user", content: o.prompt };
    if (o.images?.length) message.images = o.images;
    const body: Record<string, unknown> = {
      model,
      messages: [message],
      stream: false,
      think: false,
      keep_alive: o.keepAlive ?? BACKGROUND_KEEP_ALIVE,
      options: { num_ctx: 16384, temperature: 0.2 },
    };
    if (o.json) body.format = "json";
    let r: Response;
    try {
      r = await fetch(`${this.ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: delayAnd(GEMMA_DELAY_MS, o.signal),
      });
    } catch {
      checkAbort(o.signal);
      throw new Error("Ollama n'est pas lancé");
    }
    if (!r.ok) {
      this.gemmaModel = undefined;
      throw new Error(`Ollama a répondu ${r.status}`);
    }
    let response: { message?: { content?: string } };
    try {
      response = (await r.json()) as { message?: { content?: string } };
    } catch (e) {
      checkAbort(o.signal);
      throw e;
    }
    const content = response.message?.content ?? "";
    if (!o.json) return content;
    try {
      return JSON.parse(content);
    } catch {
      throw new Error(WRITER_JSON_INVALID);
    }
  }

  /** Ollama answers and a Gemma build is installed (only Ollama's tags are read: no extra probe). Never throws. */
  async hasGemma(): Promise<boolean> {
    this.gemmaModel = await this.detectGemma();
    return this.gemmaModel !== undefined;
  }

  /** Asks Ollama to load the installed Gemma build (a request without a prompt only loads it), so a later call skips the cold start. Never throws. */
  async warm(): Promise<void> {
    if (this.closed) return;
    try {
      const model = (this.gemmaModel ??= await this.detectGemma());
      if (!model) return;
      await fetch(`${this.ollamaUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, keep_alive: INTERACTIVE_KEEP_ALIVE }),
        signal: AbortSignal.timeout(GEMMA_DELAY_MS),
      });
    } catch { /* Ollama unreachable: the real call will say so */ }
  }

  /** Starts the decision server ahead of a first call when the model is installed. Never throws. */
  warmDecision(): void {
    if (!this.closed) this.d1.warm();
  }

  /** Stops both servers and cancels the installs for good: kev() and gemma() are refused afterwards (stop(), on the other hand, allows a relaunch). */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([this.d1.close(), this.embed.close()]);
  }

  /** An access for a kernel, closed with it (see AiAccess). */
  access(): AiAccess {
    let closed = false;
    // Checked before the call: kev() launches llama-server synchronously, before its first await; close() stops it afterwards.
    return {
      kev: (body, o) => (closed ? Promise.reject(new Error(AI_CLOSED_ERROR)) : this.kev(body, o)),
      gemma: (o) => {
        if (closed) return Promise.reject(new Error(AI_CLOSED_ERROR));
        const w = this.o.writer;
        return w ? w({ prompt: o.prompt, images: o.images, json: o.json, signal: o.signal }) : this.gemma(o);
      },
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
}
