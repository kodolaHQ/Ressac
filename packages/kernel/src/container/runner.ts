import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `signal`: cancels the command (its whole process group is killed), the result then has the code CODE_CANCELLED. */
export type Runner = (command: string, args: string[], opts?: { delaiMs?: number; signal?: AbortSignal }) => Promise<RunResult>;

/** Code returned when the timeout is exceeded (same convention as timeout(1)). */
export const CODE_TIMEOUT_EXCEEDED = 124;

/** Code returned when the command is cancelled by its signal (128 + SIGTERM). */
export const CODE_CANCELLED = 143;

/** Delay between SIGTERM and SIGKILL when a cancelled group does not stop. */
const CANCEL_KILL_DELAY_MS = 2000;

/** Process groups still alive: killed synchronously if the Node process exits without stopping them. */
const liveGroups = new Set<number>();
let connectedOutput = false;

/** Sends `signal` to the whole group `pid`; false if the group is already dead (0: simple check). */
export function killGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Remembers a group launched `detached`: if it is still alive when the Node process exits, it is killed (SIGKILL). */
export function keepGroup(pid: number): void {
  liveGroups.add(pid);
  if (connectedOutput) return;
  connectedOutput = true;
  process.on("exit", () => {
    for (const g of liveGroups) killGroup(g, "SIGKILL");
  });
}

export function forgetGroup(pid: number): void {
  liveGroups.delete(pid);
}

/** Folders where docker and its helpers (credentials) live when the app is launched from the Finder. */
export const TOOLS_FOLDERS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  join(homedir(), ".orbstack", "bin"),
  join(homedir(), ".docker", "bin"), // Docker Desktop installed per user
];

/** PATH enriched with tool folders (the app launched from the Finder has a minimal PATH). */
export const toolsPath = (): string => [process.env.PATH ?? "", ...TOOLS_FOLDERS].filter(Boolean).join(":");

/** Launches a command without ever throwing: a failure reads in `code`. */
export const defaultRunner: Runner = (command, args, opts = {}) => {
  if (opts.signal) return runCancelable(command, args, opts.signal, opts.delaiMs);
  return new Promise((resolve) => {
    const PATH = toolsPath();
    execFile(
      command,
      args,
      { timeout: opts.delaiMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH } },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (e.code === "ENOENT") return resolve({ code: 127, stdout, stderr: `${command} introuvable` });
        if (e.killed && opts.delaiMs) return resolve({ code: CODE_TIMEOUT_EXCEEDED, stdout, stderr: "Délai dépassé" });
        resolve({ code: typeof e.code === "number" ? e.code : 1, stdout, stderr });
      },
    );
  });
};

/**
 * Cancellable variant: the command lives in its own process group (git launches git-remote-https, uv its
 * compilations; execFile cannot create one). Cancelling, or exceeding the timeout, sends SIGTERM to the group, then
 * SIGKILL after 2 s if it is still alive; if Node exits before, the group is killed at exit.
 */
function runCancelable(command: string, args: string[], signal: AbortSignal, delayMs?: number): Promise<RunResult> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ code: CODE_CANCELLED, stdout: "", stderr: "Annulé" });
    const child = spawn(command, args, { env: { ...process.env, PATH: toolsPath() }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const pid = child.pid;
    if (pid !== undefined) keepGroup(pid);
    const sorties = { stdout: "", stderr: "" };
    const keep = (key: "stdout" | "stderr") => (d: Buffer) => {
      if (sorties[key].length < 64 * 1024 * 1024) sorties[key] += d.toString("utf8");
    };
    child.stdout?.on("data", keep("stdout"));
    child.stderr?.on("data", keep("stderr"));
    let delayExceeded = false;
    const kill = () => {
      if (pid === undefined || !killGroup(pid, "SIGTERM")) return;
      const timer = setTimeout(() => {
        killGroup(pid, "SIGKILL");
        forgetGroup(pid);
      }, CANCEL_KILL_DELAY_MS);
      timer.unref();
    };
    const cancel = () => kill();
    signal.addEventListener("abort", cancel, { once: true });
    const timerDelay = delayMs
      ? setTimeout(() => {
          delayExceeded = true;
          kill();
        }, delayMs)
      : undefined;
    let finished = false;
    const finish = (r: RunResult) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", cancel);
      clearTimeout(timerDelay);
      if (pid !== undefined && !killGroup(pid, 0)) forgetGroup(pid);
      resolve(r);
    };
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish(e.code === "ENOENT" ? { code: 127, ...sorties, stderr: `${command} introuvable` } : { code: 1, ...sorties, stderr: e.message }),
    );
    child.on("close", (code) => {
      if (signal.aborted) return finish({ code: CODE_CANCELLED, ...sorties, stderr: sorties.stderr || "Annulé" });
      if (delayExceeded) return finish({ code: CODE_TIMEOUT_EXCEEDED, ...sorties, stderr: "Délai dépassé" });
      finish({ code: code ?? 1, ...sorties });
    });
  });
}
