import { say } from "../i18n.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { toolsPath, forgetGroup, keepGroup, killGroup } from "../container/runner.js";
import { GEMMA_JSON_INVALID, AI_ABANDONED } from "./dispatcher.js";
import { toPplxScale } from "./d1-scale.js";

export type AiState = "not-installed" | "stopped" | "starting" | "active" | "error";

export interface AiProcess {
  stop(): void;
  onOutput(callback: (code: number | null) => void): void;
  /** Optional: receives each output line (stdout and stderr), for error messages. */
  onLine?(callback: (line: string) => void): void;
}

export interface LocalAiOptions {
  /** `<browser profile>/local-ai`; the decision model is downloaded there in `d1/`. */
  folder: string;
  launch?: (cmd: string, args: string[], o: { cwd: string }) => AiProcess;
  /** The llama-server binary; absent, the decision server cannot start. */
  llamaServer?: string;
  kevUrl?: string;
  ollamaUrl?: string;
  /** Test overrides of the model download. */
  decisionUrl?: string;
  decisionSha256?: string;
  /** Expected size of the model file (default: the shipped one); a longer download is aborted. */
  decisionBytes?: number;
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
/** In order of preference: the MLX build is faster, but not every Ollama serves it. */
export const GEMMA_MODELS = ["gemma4:e4b-mlx", "gemma4:e4b"];
/** Asked for when no Gemma build is detected. */
export const GEMMA_MODEL = GEMMA_MODELS[0]!;
const STARTUP_DELAY_MS = 180_000;
const KEV_DELAY_MS = 60_000;
const GEMMA_DELAY_MS = 120_000;

/** Delay between SIGTERM and SIGKILL when the decision server (its group) does not stop. */
const KILL_DELAY_MS = 5000;

/** Background calls (workflows, watches) free the 5-9 GB model a minute after their last use, not Ollama's 5 min or our old 10. */
export const BACKGROUND_KEEP_ALIVE = "1m";
/** ⌘T: the model stays warm between questions (a background call after it brings Ollama back to 1 min). */
export const INTERACTIVE_KEEP_ALIVE = "10m";

/**
 * Launches the command in its own process group (the server may launch children: killing the parent alone could leave
 * them orphaned). `stop` sends SIGTERM to the group, then SIGKILL after `killDelayMs` if it is still alive. If the Node process
 * exits without stopping the group, it is killed at exit.
 */
export function launchAiProcess(cmd: string, args: string[], o: { cwd: string; killDelayMs?: number }): AiProcess {
  const child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, PATH: toolsPath() }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const pid = child.pid;
  if (pid !== undefined) keepGroup(pid);
  let exited = false;
  child.on("exit", () => {
    exited = true;
    if (pid !== undefined && !killGroup(pid, 0)) forgetGroup(pid);
  });
  return {
    stop: () => {
      if (pid === undefined) return;
      if (!killGroup(pid, "SIGTERM")) {
        forgetGroup(pid);
        return;
      }
      // The group may outlive the first process (a child that ignores SIGTERM): we check the group, not the exit event.
      const timer = setTimeout(() => {
        killGroup(pid, "SIGKILL");
        forgetGroup(pid);
      }, o.killDelayMs ?? KILL_DELAY_MS);
      timer.unref();
      const check = setInterval(() => {
        if (exited && !killGroup(pid, 0)) {
          clearTimeout(timer);
          clearInterval(check);
          forgetGroup(pid);
        }
      }, 100);
      check.unref();
    },
    onOutput: (r) => {
      child.on("exit", (code) => r(code));
      child.on("error", () => r(127));
    },
    onLine: (r) => {
      for (const stream of [child.stdout, child.stderr]) {
        let rest = "";
        stream.on("data", (d: Buffer) => {
          const chunks = (rest + d.toString("utf8")).split(/\r?\n/);
          rest = chunks.pop() ?? "";
          chunks.forEach((l) => l && r(l));
        });
      }
    },
  };
}

const defaultLaunch: NonNullable<LocalAiOptions["launch"]> = (cmd, args, o) => launchAiProcess(cmd, args, o);

/** The call's timeout, and the caller's signal if there is one. */
const delayAnd = (ms: number, signal?: AbortSignal) => (signal ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms));
/** The caller's signal is raised: the call is abandoned (otherwise the original error). */
const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error(AI_ABANDONED);
};

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

export const AI_CLOSED_ERROR = "IA locale fermée";
/** Maximum wait for a cancelled install to finish when the app quits. */
const CANCEL_DELAY_MS = 3000;

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
  private currentState: AiState = "stopped";
  private currentError?: string;
  private process?: AiProcess;
  private startup?: Promise<void>;
  private timeout?: NodeJS.Timeout;
  private lastUsage = 0;
  private generation = 0;
  /** Closed (the browser quits): nothing starts llama-server or calls Ollama anymore. */
  private closed = false;
  /** Install in progress: its cancellation and its end (successful or not). */
  private installation?: { controller: AbortController; end: Promise<unknown> };
  // Modifiable: The decision server's address, imposed by RESSAC_KEV_URL or computed from the port.
  private kevUrl: string;
  private readonly kevForced: boolean;
  readonly ollamaUrl: string;
  /** The Gemma build found in Ollama, kept until a call says it is gone. */
  private gemmaModel: string | undefined;
  private readonly port: number;
  private readonly inactivityMs: number;
  private readonly clock: () => number;
  private readonly launch: NonNullable<LocalAiOptions["launch"]>;

  private say(id: string, args?: Record<string, string | number>): string {
    return say(this.o.locale?.() ?? "en", id, args);
  }

  constructor(private readonly o: LocalAiOptions) {
    this.port = o.port ?? 8008;
    const imposed = o.kevUrl ?? process.env.RESSAC_KEV_URL;
    this.kevForced = Boolean(imposed);
    this.kevUrl = imposed ?? `http://127.0.0.1:${this.port}`;
    this.ollamaUrl = o.ollamaUrl ?? process.env.RESSAC_OLLAMA_URL ?? "http://127.0.0.1:11434";
    this.inactivityMs = o.inactivityMs ?? 600_000;
    this.clock = o.clock ?? Date.now;
    this.launch = o.launch ?? defaultLaunch;
  }

  state(): { state: AiState; error?: string } {
    return this.currentError ? { state: this.currentState, error: this.currentError } : { state: this.currentState };
  }

  private change(e: AiState, error?: string) {
    this.currentState = e;
    this.currentError = error;
    this.o.onState?.(e, error);
  }

  private get d1Folder() { return join(this.o.folder, "d1"); }
  private get modelFile() { return join(this.d1Folder, D1_FILE); }

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

  async check(): Promise<{ ollama: boolean; gemma: boolean; gemmaModel: string | null; decision: boolean }> {
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
    return { ollama, gemma: gemmaModel !== null, gemmaModel, decision: this.kevForced || existsSync(this.modelFile) };
  }

  /**
   * Downloads the decision model into `d1/`, resuming a `.part` left by an earlier try, and checks its SHA-256 before
   * renaming it. Cancelled by `cancelInstall()` or `close()`: rejected « Installation annulée », the `.part` kept for resuming.
   */
  installDecisionModel(onPercent: (percent: number | null) => void): Promise<void> {
    if (this.closed) return Promise.reject(new Error(AI_CLOSED_ERROR));
    if (this.installation) return Promise.reject(new Error(this.say("kernel-ai-install-running")));
    const controller = new AbortController();
    const end = this.download(controller.signal, onPercent).finally(() => {
      if (this.installation?.controller === controller) this.installation = undefined;
    });
    this.installation = { controller: controller, end: end.catch(() => {}) };
    return end;
  }

  /** Cancels the install in progress, if there is one (without waiting for its end). */
  cancelInstall(): void {
    this.installation?.controller.abort();
  }

  private async download(signal: AbortSignal, onPercent: (percent: number | null) => void): Promise<void> {
    if (existsSync(this.modelFile)) return;
    const part = `${this.modelFile}.part`;
    const cancelled = () => new Error(this.say("kernel-ai-install-cancelled"));
    try {
      await mkdir(this.d1Folder, { recursive: true });
      let from = (await stat(part).catch(() => undefined))?.size ?? 0;
      const r = await fetch(this.o.decisionUrl ?? D1_URL, { headers: from ? { range: `bytes=${from}-` } : {}, signal });
      // 416: the .part already holds the whole file (the app quit before checking it).
      if (r.status !== 416) {
        if ((r.status !== 200 && r.status !== 206) || !r.body) throw new Error(`HTTP ${r.status}`);
        if (r.status === 200) from = 0; // the range was ignored: start over
        const total = from + Number(r.headers.get("content-length") ?? NaN);
        let received = from;
        let shown: number | null | undefined;
        const file = await open(part, from ? "a" : "w");
        try {
          for await (const chunk of r.body) {
            await file.write(chunk);
            received += chunk.length;
            if (received > (this.o.decisionBytes ?? D1_BYTES)) throw new Error("too many bytes");
            const percent = Number.isFinite(total) ? Math.floor((received * 100) / total) : null;
            if (percent !== shown) onPercent((shown = percent));
          }
        } finally {
          await file.close();
        }
      }
    } catch (e) {
      if (signal.aborted) throw cancelled();
      if ((e as Error).message === "too many bytes") await rm(part, { force: true });
      throw new Error(this.say("kernel-ai-download-failed", { error: (e as Error).message }));
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    if (signal.aborted) throw cancelled();
    if (hash.digest("hex") !== (this.o.decisionSha256 ?? D1_SHA256)) {
      await rm(part, { force: true });
      throw new Error(this.say("kernel-ai-hash-mismatch"));
    }
    await rename(part, this.modelFile);
  }

  async kev(body: { state: unknown; questions: Record<string, unknown> }, o: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.closed) throw new Error(AI_CLOSED_ERROR);
    checkAbort(o.signal);
    await this.ensureKev();
    checkAbort(o.signal);
    this.lastUsage = this.clock();
    let r: Response;
    try {
      r = await fetch(`${this.kevUrl}/v1/systemone`, {
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
    this.lastUsage = this.clock();
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
      throw new Error(GEMMA_JSON_INVALID);
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
    if (this.closed || !existsSync(this.modelFile)) return;
    this.ensureKev().catch(() => { /* the state says why; the real call will too */ });
  }

  /** Stops the decision server for good: kev() and gemma() are refused afterwards (stop(), on the other hand, allows a relaunch). */
  async close(): Promise<void> {
    this.closed = true;
    const installation = this.installation;
    if (installation) {
      // The app quits: the install is cancelled; its cleanup is awaited, but never longer than the delay.
      installation.controller.abort();
      let timer: NodeJS.Timeout | undefined;
      const delay = new Promise<void>((ok) => (timer = setTimeout(ok, this.o.cancelDelayMs ?? CANCEL_DELAY_MS)));
      await Promise.race([installation.end, delay]);
      clearTimeout(timer);
    }
    await this.stop();
  }

  /** An access for a kernel, closed with it (see AiAccess). */
  access(): AiAccess {
    let closed = false;
    // Checked before the call: kev() launches llama-server synchronously, before its first await; close() stops it afterwards.
    return {
      kev: (body, o) => (closed ? Promise.reject(new Error(AI_CLOSED_ERROR)) : this.kev(body, o)),
      gemma: (o) => (closed ? Promise.reject(new Error(AI_CLOSED_ERROR)) : this.gemma(o)),
      close: async () => {
        closed = true;
        await this.stop();
      },
    };
  }

  async stop(): Promise<void> {
    if (this.timeout) clearInterval(this.timeout);
    this.timeout = undefined;
    const p = this.process;
    this.process = undefined;
    this.startup = undefined;
    this.generation++;
    p?.stop();
    if (this.currentState === "active" || this.currentState === "starting") this.change("stopped");
  }

  private ensureKev(): Promise<void> {
    if (this.currentState === "active") return Promise.resolve();
    if (!this.startup) {
      const d = this.startKev().finally(() => { if (this.startup === d) this.startup = undefined; });
      this.startup = d;
    }
    return this.startup;
  }

  private async startKev(): Promise<void> {
    if (this.kevForced) {
      this.change("active");
      return;
    }
    if (!existsSync(this.modelFile)) {
      this.change("not-installed");
      throw new Error(this.say("kernel-ai-not-installed"));
    }
    if (!this.o.llamaServer) {
      const msg = this.say("kernel-ai-llama-server-missing");
      this.change("error", msg);
      throw new Error(msg);
    }
    const gen = ++this.generation;
    this.change("starting");
    const lines: string[] = [];
    let output: number | null | undefined;
    const args = ["-m", this.modelFile, "--host", "127.0.0.1", "--port", String(this.port), "-ngl", "99", "-np", String(D1_SLOTS), "-c", String(D1_CONTEXT * D1_SLOTS)];
    const p = this.launch(this.o.llamaServer, args, { cwd: this.d1Folder });
    this.process = p;
    p.onLine?.((l) => { lines.push(l); if (lines.length > 20) lines.shift(); });
    let dead = false;
    p.onOutput((code) => {
      dead = true;
      output = code;
      if (this.timeout) clearInterval(this.timeout);
      if (this.process === p) { this.process = undefined; if (this.currentState === "active") this.change("stopped"); }
    });
    const step = this.o.pollMs ?? 500;
    const end = Date.now() + STARTUP_DELAY_MS;
    while (Date.now() < end) {
      if (gen !== this.generation) return; // stop() came through here
      if (dead) {
        const msg = this.say("kernel-ai-llama-start-failed", { detail: lines.slice(-5).join("\n") || `code ${output}` });
        this.change("error", msg);
        throw new Error(msg);
      }
      try {
        const r = await fetch(`${this.kevUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
        if (gen !== this.generation) return;
        // Ready only if our process is alive and the answer names our model (a foreign server may hold the port).
        if (r.ok && !dead && (await r.text()).includes(D1_FILE)) {
          this.lastUsage = this.clock();
          this.change("active");
          this.watchIdle();
          return;
        }
      } catch { /* not ready yet */ }
      await wait(step);
    }
    if (gen !== this.generation) return;
    p.stop();
    this.process = undefined;
    const msg = this.say("kernel-ai-llama-start-timeout", { detail: lines.slice(-5).join("\n") }).trim();
    this.change("error", msg);
    throw new Error(msg);
  }

  private watchIdle() {
    if (this.timeout) clearInterval(this.timeout);
    this.timeout = setInterval(() => {
      if (this.clock() - this.lastUsage >= this.inactivityMs) void this.stop();
    }, this.o.idleCheckMs ?? 5000);
    this.timeout.unref();
  }
}
