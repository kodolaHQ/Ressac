import { say } from "../i18n.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { toolsPath, forgetGroup, keepGroup, killGroup } from "../container/runner.js";

export type AiState = "not-installed" | "stopped" | "starting" | "active" | "error";

export interface AiProcess {
  stop(): void;
  onOutput(callback: (code: number | null) => void): void;
  /** Optional: receives each output line (stdout and stderr), for error messages. */
  onLine?(callback: (line: string) => void): void;
}

/**
 * A GGUF model Ressac downloads into `<folder>/<name>/` and serves with the shipped llama-server. `port` fixes the server's
 * port (tests); absent, each launch takes a free port from the OS, so a foreign server can never hold it.
 */
export type LlamaModelSpec = { name: string; file: string; url: string; sha256: string; bytes: number; port?: number; args: string[]; idleMs: number };

export interface LlamaModelOptions {
  /** `<browser profile>/local-ai`; the model goes into `<folder>/<spec.name>/`. */
  folder: string;
  /** The llama-server binary; absent, the server cannot start. */
  llamaServer?: string | null;
  /** Test overrides of the model download. */
  urlOverride?: string;
  sha256Override?: string;
  /** Expected size of the model file (default: the spec's); a longer download is aborted. */
  bytesOverride?: number;
  /** A server already running elsewhere (tests): ready() answers it without launching anything. */
  serverUrl?: string;
  launch?: (cmd: string, args: string[], o: { cwd: string }) => AiProcess;
  clock?: () => number;
  onState?: (e: AiState, error?: string) => void;
  /** Polling interval of /v1/models at startup (500 ms by default). */
  pollMs?: number;
  /** Inactivity check interval (5 s by default). */
  idleCheckMs?: number;
  /** Maximum wait, at close, for a cancelled install to finish (3 s by default). */
  cancelDelayMs?: number;
  /** The shown language, read when an error is written (default: English). */
  locale?: () => string;
}

export const AI_CLOSED_ERROR = "IA locale fermée";

const STARTUP_DELAY_MS = 180_000;
/** Delay between SIGTERM and SIGKILL when the server (its group) does not stop. */
const KILL_DELAY_MS = 5000;
/** Maximum wait for a cancelled install to finish when the app quits. */
const CANCEL_DELAY_MS = 3000;

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** A port free right now on 127.0.0.1 (the OS picks it; released before llama-server binds it). */
function freePort(): Promise<number> {
  return new Promise((ok, ko) => {
    const s = createServer();
    s.on("error", ko);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

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

const defaultLaunch: NonNullable<LlamaModelOptions["launch"]> = (cmd, args, o) => launchAiProcess(cmd, args, o);

/**
 * One model served by llama-server: its download (resumable, size-capped, SHA-256 checked) and its server, started on
 * demand and stopped after `spec.idleMs` without a call. Once closed (the browser quits), nothing downloads or starts.
 */
export class LlamaModel {
  private currentState: AiState = "stopped";
  private currentError?: string;
  private process?: AiProcess;
  private startup?: Promise<string>;
  private timeout?: NodeJS.Timeout;
  private lastUsage = 0;
  private generation = 0;
  private closed = false;
  /** Set once a CPU relaunch started after a death at start on the GPU: from then on this model runs on the CPU. */
  private cpuOnly = false;
  /** Install in progress: its cancellation and its end (successful or not). */
  private installation?: { controller: AbortController; end: Promise<unknown> };
  /** The running (or starting) server's URL: `serverUrl`, else 127.0.0.1 on the port of the last launch. */
  private baseUrl: string;
  private readonly clock: () => number;
  private readonly launch: NonNullable<LlamaModelOptions["launch"]>;

  constructor(readonly spec: LlamaModelSpec, private readonly o: LlamaModelOptions) {
    this.baseUrl = o.serverUrl ?? `http://127.0.0.1:${spec.port ?? 0}`;
    this.clock = o.clock ?? Date.now;
    this.launch = o.launch ?? defaultLaunch;
  }

  private say(id: string, args?: Record<string, string | number>): string {
    return say(this.o.locale?.() ?? "en", id, args);
  }

  private get folder() { return join(this.o.folder, this.spec.name); }
  private get modelFile() { return join(this.folder, this.spec.file); }

  state(): { state: AiState; error?: string } {
    return this.currentError ? { state: this.currentState, error: this.currentError } : { state: this.currentState };
  }

  private change(e: AiState, error?: string) {
    this.currentState = e;
    this.currentError = error;
    this.o.onState?.(e, error);
  }

  /** The file is in place (only renamed there once its SHA-256 matched), or a server runs elsewhere (`serverUrl`). */
  installed(): boolean {
    return Boolean(this.o.serverUrl) || existsSync(this.modelFile);
  }

  /**
   * Downloads the model, resuming a `.part` left by an earlier try, and checks its SHA-256 before renaming it. Cancelled by
   * `cancelInstall()` or `close()`: rejected « Installation annulée », the `.part` kept for resuming.
   */
  install(onPercent: (percent: number | null) => void): Promise<void> {
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
      await mkdir(this.folder, { recursive: true });
      let from = (await stat(part).catch(() => undefined))?.size ?? 0;
      const r = await fetch(this.o.urlOverride ?? this.spec.url, { headers: from ? { range: `bytes=${from}-` } : {}, signal });
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
            if (received > (this.o.bytesOverride ?? this.spec.bytes)) throw new Error("too many bytes");
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
    // Checked per chunk: hashing 1.4 GB takes seconds, and the slot stays taken until the cancel lands.
    for await (const chunk of createReadStream(part)) {
      if (signal.aborted) throw cancelled();
      hash.update(chunk as Buffer);
    }
    if (signal.aborted) throw cancelled();
    if (hash.digest("hex") !== (this.o.sha256Override ?? this.spec.sha256)) {
      await rm(part, { force: true });
      throw new Error(this.say("kernel-ai-hash-mismatch"));
    }
    await rename(part, this.modelFile);
  }

  /** The server's base URL once it answers, launching it if needed; each call counts as a use for the idle stop. */
  async ready(): Promise<string> {
    if (this.closed) throw new Error(AI_CLOSED_ERROR);
    this.lastUsage = this.clock();
    if (this.currentState !== "active") {
      if (!this.startup) {
        const d = this.start().finally(() => { if (this.startup === d) this.startup = undefined; });
        this.startup = d;
      }
      await this.startup;
    }
    this.lastUsage = this.clock();
    return this.baseUrl;
  }

  /** Starts the server ahead of a first call when the model is installed. Never throws. */
  warm(): void {
    if (this.closed || !this.installed()) return;
    this.ready().catch(() => { /* the state says why; the real call will too */ });
  }

  /** Stops the server; a later ready() launches it again. */
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

  /** For good: cancels the install (its cleanup awaited, never longer than the delay) and stops the server. */
  async close(): Promise<void> {
    this.closed = true;
    const installation = this.installation;
    if (installation) {
      installation.controller.abort();
      let timer: NodeJS.Timeout | undefined;
      const delay = new Promise<void>((ok) => (timer = setTimeout(ok, this.o.cancelDelayMs ?? CANCEL_DELAY_MS)));
      await Promise.race([installation.end, delay]);
      clearTimeout(timer);
    }
    await this.stop();
  }

  private async start(cpu = this.cpuOnly): Promise<string> {
    if (this.o.serverUrl) {
      this.change("active");
      return this.baseUrl;
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
    let port: number;
    try {
      port = this.spec.port ?? (await freePort());
    } catch (e) {
      if (gen !== this.generation) throw new Error(AI_CLOSED_ERROR);
      const msg = this.say("kernel-ai-llama-start-failed", { detail: (e as Error).message });
      this.change("error", msg);
      throw new Error(msg);
    }
    if (gen !== this.generation) throw new Error(AI_CLOSED_ERROR); // stop() or close() came during the wait
    this.baseUrl = `http://127.0.0.1:${port}`;
    const lines: string[] = [];
    let output: number | null | undefined;
    // A later -ngl wins in llama-server's parser: "-ngl 0" puts every layer on the CPU.
    const args = ["-m", this.modelFile, "--host", "127.0.0.1", "--port", String(port), ...this.spec.args, ...(cpu ? ["-ngl", "0"] : [])];
    const p = this.launch(this.o.llamaServer, args, { cwd: this.folder });
    this.process = p;
    p.onLine?.((l) => { lines.push(l); if (lines.length > 20) lines.shift(); });
    let dead = false;
    p.onOutput((code) => {
      dead = true;
      output = code;
      if (this.process !== p) return; // an older server: the current one keeps its idle timer
      if (this.timeout) clearInterval(this.timeout);
      this.timeout = undefined;
      this.process = undefined;
      if (this.currentState === "active") this.change("stopped");
    });
    const step = this.o.pollMs ?? 500;
    const end = Date.now() + STARTUP_DELAY_MS;
    while (Date.now() < end) {
      if (gen !== this.generation) throw new Error(AI_CLOSED_ERROR); // stop() came through here
      if (dead) {
        // A GPU llama.cpp cannot use (a macOS 13 VM's paravirtual GPU aborts at load): one more try on the CPU.
        if (!cpu) return this.start(true);
        const msg = this.say("kernel-ai-llama-start-failed", { detail: lines.slice(-5).join("\n") || `code ${output}` });
        this.change("error", msg);
        throw new Error(msg);
      }
      try {
        const r = await fetch(`${this.baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
        if (gen !== this.generation) throw new Error(AI_CLOSED_ERROR);
        // Ready only if our process is alive and the answer names our model (a foreign server may hold the port).
        if (r.ok && !dead && (await r.text()).includes(this.spec.file)) {
          this.lastUsage = this.clock();
          if (cpu) this.cpuOnly = true; // kept only once it works: a passing failure does not cost the GPU for good
          this.change("active");
          this.watchIdle();
          return this.baseUrl;
        }
      } catch { /* not ready yet */ }
      await wait(step);
    }
    if (gen !== this.generation) throw new Error(AI_CLOSED_ERROR);
    p.stop();
    this.process = undefined;
    const msg = this.say("kernel-ai-llama-start-timeout", { detail: lines.slice(-5).join("\n") }).trim();
    this.change("error", msg);
    throw new Error(msg);
  }

  private watchIdle() {
    if (this.timeout) clearInterval(this.timeout);
    this.timeout = setInterval(() => {
      if (this.clock() - this.lastUsage >= this.spec.idleMs) void this.stop();
    }, this.o.idleCheckMs ?? 5000);
    this.timeout.unref();
  }
}

export const EMBED_FILE = "embeddinggemma-300M-Q8_0.gguf";
export const EMBED_REVISION = "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12";
export const EMBED_URL = `https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/${EMBED_REVISION}/${EMBED_FILE}`;

/** EmbeddingGemma 300M (Google, Gemma Terms of Use), ggml-org's Q8_0 GGUF: the vectors ⌘T Demander compares pages with. */
export const EMBED_MODEL: LlamaModelSpec = {
  name: "embed",
  file: EMBED_FILE,
  url: EMBED_URL,
  sha256: "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63",
  bytes: 333590944,
  // A whole page document in one batch (the 512-token default refuses a long one).
  args: ["--embedding", "--pooling", "mean", "-ngl", "99", "-ub", "2048", "-b", "2048"],
  // Short: the page indexer works in passes and ⌘T warms it, so 334 MB need not stay up between them.
  idleMs: 120_000,
};
