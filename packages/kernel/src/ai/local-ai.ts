import { say } from "../i18n.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { toolsPath, forgetGroup, keepGroup, killGroup, type Runner } from "../container/runner.js";
import { GEMMA_JSON_INVALID, AI_ABANDONED } from "./dispatcher.js";

export type AiState = "not-installed" | "stopped" | "starting" | "active" | "error";

export interface AiProcess {
  stop(): void;
  onOutput(callback: (code: number | null) => void): void;
  /** Optional: receives each output line (stdout and stderr), for error messages. */
  onLine?(callback: (line: string) => void): void;
}

export interface LocalAiOptions {
  /** `<browser profile>/local-ai`; Kev is cloned there in `kev/`. */
  folder: string;
  run: Runner;
  launch?: (cmd: string, args: string[], o: { cwd: string }) => AiProcess;
  kevUrl?: string;
  ollamaUrl?: string;
  /** Ollama decision model (same /v1/systemone API as Kev) used instead of launching Kev; an imposed Kev address wins. */
  decisionModel?: string;
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

export const DEPOT_KEV = "https://github.com/jaredpalmer/kev.git";
export const TAG_KEV = "kev-1.0";
export const COMMIT_KEV = "6b719c3c3f367295f6ef336f4f751cf5ff970abc";
export const KEV_MODEL = "jaredpalmer/kev-4b@v1.0";
/** In order of preference: the MLX build is faster, but not every Ollama serves it. */
export const GEMMA_MODELS = ["gemma4:e4b-mlx", "gemma4:e4b"];
/** What the kernel's own install() pulls. */
export const GEMMA_MODEL = GEMMA_MODELS[0]!;
const STARTUP_DELAY_MS = 180_000;
const KEV_DELAY_MS = 60_000;
const GEMMA_DELAY_MS = 120_000;

/** Delay between SIGTERM and SIGKILL when Kev (its group) does not stop. */
const KILL_DELAY_MS = 5000;

/**
 * Launches the command in its own process group (`uv run` launches a Python child: killing uv alone would leave it
 * orphaned). `arreter` sends SIGTERM to the group, then SIGKILL after `delaiKillMs` if it is still alive. If the Node process
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
      // The group may outlive the first process (a child that ignores SIGTERM): we check the group, not `sorti`.
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
 * harvest does not relaunch Kev. The next kernel (another agent profile) gets a new access.
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
  /** Closed (the browser quits): nothing starts Kev or calls Ollama anymore. */
  private closed = false;
  /** Install in progress: its cancellation and its end (successful or not). */
  private installation?: { controller: AbortController; end: Promise<unknown> };
  // Modifiable: Kev's address, imposed by RESSAC_KEV_URL or computed from the port.
  private kevUrl: string;
  private readonly kevForced: boolean;
  readonly ollamaUrl: string;
  /** Decision model served by Ollama; undefined = Kev. */
  private decisionModel: string | undefined;
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
    this.decisionModel = o.decisionModel;
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

  private get kevFolder() { return join(this.o.folder, "kev"); }

  setDecisionModel(model: string | undefined): void {
    this.decisionModel = model;
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

  async check(): Promise<{ kev: boolean; uv: boolean; ollama: boolean; gemma: boolean; gemmaModel: string | null; decision: boolean }> {
    const kev = existsSync(join(this.kevFolder, ".git"));
    const uv = (await this.o.run("uv", ["--version"], { delayMs: 10_000 })).code === 0;
    let ollama = false;
    let gemmaModel: string | null = null;
    let decision = false;
    const wanted = this.kevForced ? undefined : this.decisionModel;
    try {
      const r = await fetch(`${this.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      ollama = r.ok;
      if (r.ok) {
        const { models } = (await r.json()) as { models?: { name?: string }[] };
        gemmaModel = GEMMA_MODELS.find((g) => (models ?? []).some((m) => m.name === g)) ?? null;
        this.gemmaModel = gemmaModel ?? undefined;
        decision = Boolean(wanted) && (models ?? []).some((m) => m.name === wanted || m.name === `${wanted}:latest`);
      }
    } catch { /* unreachable */ }
    return { kev, uv, ollama, gemma: gemmaModel !== null, gemmaModel, decision };
  }

  /** Folder where Kev is cloned before being renamed to `kev/`: an interrupted clone never leaves a partial repo there. */
  private get cloneFolder() { return join(this.o.folder, "kev.clone-in-progress"); }

  /**
   * Installs Kev and Gemma. Cancelled by `annulerInstallation()` or `fermer()`: the current command is killed (its whole
   * group), none follows, a partial clone is erased, and the promise is rejected « Installation annulée ».
   */
  install(progress: (line: string) => void): Promise<void> {
    if (this.closed) return Promise.reject(new Error(AI_CLOSED_ERROR));
    if (this.installation) return Promise.reject(new Error(this.say("kernel-ai-install-running")));
    const controller = new AbortController();
    const end = this.installWith(controller.signal, progress).finally(() => {
      if (this.installation?.controller === controller) this.installation = undefined;
    });
    this.installation = { controller: controller, end: end.catch(() => {}) };
    return end;
  }

  /** Cancels the install in progress, if there is one (without waiting for its end). */
  cancelInstall(): void {
    this.installation?.controller.abort();
  }

  private async installWith(signal: AbortSignal, progress: (line: string) => void): Promise<void> {
    const checkCancel = () => {
      if (signal.aborted) throw new Error(this.say("kernel-ai-install-cancelled"));
    };
    const run = async (cmd: string, args: string[], delayMs?: number) => {
      checkCancel();
      const r = await this.o.run(cmd, args, delayMs ? { delayMs: delayMs, signal } : { signal });
      checkCancel();
      return r;
    };
    const launch = async (cmd: string, args: string[], delayMs?: number) => {
      checkCancel();
      progress(`$ ${[cmd, ...args].join(" ")}`);
      const r = await run(cmd, args, delayMs);
      for (const l of `${r.stdout}\n${r.stderr}`.split(/\r?\n/)) if (l.trim()) progress(l);
      return r;
    };
    // 1. uv
    if ((await launch("uv", ["--version"], 10_000)).code !== 0) throw new Error(this.say("kernel-ai-install-uv"));
    // 2. Kev repo at the pinned commit, cloned aside then renamed. The clone folder belongs only to this code: what is left
    // of an interrupted clone (app killed before it could erase it) is erased before recloning.
    if (!existsSync(join(this.kevFolder, ".git"))) {
      await rm(this.cloneFolder, { recursive: true, force: true });
      try {
        const r = await launch("git", ["clone", "--depth", "1", "--branch", TAG_KEV, DEPOT_KEV, this.cloneFolder]);
        if (r.code !== 0) throw new Error(this.say("kernel-ai-git-clone-failed", { error: r.stderr.trim() }));
        await rename(this.cloneFolder, this.kevFolder);
      } catch (e) {
        await rm(this.cloneFolder, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
    }
    const head = await run("git", ["-C", this.kevFolder, "rev-parse", "HEAD"]);
    if (head.code !== 0 || head.stdout.trim() !== COMMIT_KEV) {
      throw new Error(this.say("kernel-ai-commit-mismatch", { expected: COMMIT_KEV, found: head.stdout.trim() || head.stderr.trim() }));
    }
    // 3. dependencies (an interrupted sync is resumed by the next one, or by `uv run` at Kev's start)
    const sync = await launch("uv", ["sync", "--extra", "serve", "--project", this.kevFolder]);
    if (sync.code !== 0) throw new Error(this.say("kernel-ai-uv-sync-failed", { error: sync.stderr.trim() }));
    // 4. Gemma model. Killing `ollama pull` cuts its request to the Ollama server, which stops the download and keeps its
    // chunks for resuming: they are Ollama's (shared with the user), we do not touch them.
    const pulled = await launch("ollama", ["pull", GEMMA_MODEL]);
    if (pulled.code !== 0) throw new Error(this.say("kernel-ai-pull-failed", { error: pulled.stderr.trim() }));
  }

  async kev(body: { state: unknown; questions: Record<string, unknown> }, o: { signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.closed) throw new Error(AI_CLOSED_ERROR);
    checkAbort(o.signal);
    const model = this.kevForced ? undefined : this.decisionModel;
    if (!model) await this.ensureKev();
    checkAbort(o.signal);
    this.lastUsage = this.clock();
    let r: Response;
    try {
      r = await fetch(`${model ? this.ollamaUrl : this.kevUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(model ? { ...body, model } : body),
        signal: delayAnd(KEV_DELAY_MS, o.signal),
      });
    } catch (e) {
      checkAbort(o.signal);
      throw new Error(`Kev ne répond pas : ${(e as Error).message}`);
    }
    if (!r.ok) throw new Error(`Kev a répondu ${r.status}`);
    this.lastUsage = this.clock();
    try {
      return ((await r.json()) as { answers: unknown }).answers;
    } catch (e) {
      checkAbort(o.signal);
      throw e;
    }
  }

  async gemma(o: { prompt: string; images?: string[]; json?: boolean; signal?: AbortSignal }): Promise<string | unknown> {
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
      keep_alive: "10m",
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

  /** Stops Kev for good: kev() and gemma() are refused afterwards (arreter(), on the other hand, allows a relaunch). */
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
    // Checked before the call: kev() launches Kev synchronously, before its first await; fermer() stops it afterwards.
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
    if (!existsSync(join(this.kevFolder, ".git"))) {
      this.change("not-installed");
      throw new Error("IA locale non installée");
    }
    const gen = ++this.generation;
    this.change("starting");
    const lines: string[] = [];
    let output: number | null | undefined;
    const p = this.launch("uv", ["run", "--extra", "serve", "python", "-m", "kev.serve", "--run", KEV_MODEL, "--port", String(this.port)], { cwd: this.kevFolder });
    this.process = p;
    p.onLine?.((l) => { lines.push(l); if (lines.length > 20) lines.shift(); });
    let dead = false;
    p.onOutput((code) => {
      dead = true;
      output = code;
      if (this.process === p) { this.process = undefined; if (this.currentState === "active") this.change("stopped"); }
    });
    const step = this.o.pollMs ?? 500;
    const end = Date.now() + STARTUP_DELAY_MS;
    while (Date.now() < end) {
      if (gen !== this.generation) return; // arreter() came through here
      if (dead) {
        const msg = `Kev n'a pas démarré : ${lines.slice(-5).join("\n") || `code ${output}`}`;
        this.change("error", msg);
        throw new Error(msg);
      }
      try {
        const r = await fetch(`${this.kevUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
        if (gen !== this.generation) return;
        if (r.ok) {
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
    const msg = `Kev n'a pas démarré : délai dépassé. ${lines.slice(-5).join("\n")}`.trim();
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
