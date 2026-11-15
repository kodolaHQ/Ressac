import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { OllamaStatus } from "../shared/settings.ts";
import { hostSay } from "./locale.ts";

/** The Ollama Ressac downloads when the machine has none: the official archive, checked against its published hash. */
export const OLLAMA_VERSION = "0.40.13";
export const OLLAMA_SHA256 = "bae29252232b9e1358cf5801a7d65a07442af18fb5467cb68c7fc3711f59c511";
export const OLLAMA_ARCHIVE = `https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}/ollama-darwin.tgz`;
// shortcut: 0.40 is the oldest version the decision model was tried on, not a measured minimum; lower it once an older one is known to work.
export const OLLAMA_MIN = "0.40.0";
export const OLLAMA_LOCAL_URL = "http://127.0.0.1:11434";
const APP = "/Applications/Ollama.app";
const CLIS = ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"];

export const NOT_STARTED = () => hostSay("host-ollama-not-started");
export const BAD_ARCHIVE = () => hostSay("host-ollama-bad-archive");

/** True when version `a` is older than `b` (numeric parts; a missing or odd part counts as 0). */
export function olderThan(a: string, b: string): boolean {
  const parts = (s: string) => s.split(".").map((p) => parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

export interface OllamaRuntimeOptions {
  /** The address the local AI calls. */
  url: string;
  dataDir: string;
  /** False when the address is not this machine's default one: Ressac then starts and installs nothing. */
  managed: boolean;
  fetch?: typeof fetch;
  exists?: (path: string) => boolean;
  /** Runs a command to its end; resolves with its exit code. */
  run?: (cmd: string, args: string[]) => Promise<number>;
  /** Starts a long-lived process. */
  launch?: (cmd: string, args: string[]) => { kill(): void };
  startDelayMs?: number;
  pollMs?: number;
  archive?: { url: string; sha256: string };
}

/** Claude Code's prompt, its tools and AGENTS.md fill a third or more of the 32k Ollama picks on a 48 GB Mac: a local agent needs room to work. */
const CONTEXT_LENGTH = "65536";
const defaultRun = (cmd: string, args: string[]) => new Promise<number>((ok) => execFile(cmd, args, (e) => ok(e ? 1 : 0)));
const defaultLaunch = (cmd: string, args: string[]) => {
  const child = spawn(cmd, args, { stdio: "ignore", env: { ...process.env, OLLAMA_CONTEXT_LENGTH: CONTEXT_LENGTH } });
  child.on("error", () => {});
  return child;
};

/**
 * Makes sure an Ollama answers on this machine: uses the running one, starts the installed one, or downloads its own
 * (on request only). An Ollama too old for the decision model is reported, never replaced.
 */
export function createOllamaRuntime(o: OllamaRuntimeOptions) {
  const f = o.fetch ?? fetch;
  const exists = o.exists ?? existsSync;
  const run = o.run ?? defaultRun;
  const launch = o.launch ?? defaultLaunch;
  const archive = o.archive ?? { url: OLLAMA_ARCHIVE, sha256: OLLAMA_SHA256 };
  const root = join(o.dataDir, "ollama");
  const folder = join(root, OLLAMA_VERSION);
  const own = join(folder, "ollama");
  /** Ressac's own copy: this version's, else the newest one an older Ressac downloaded (a version bump never strands it). */
  function ownBinary(): string | undefined {
    if (exists(own)) return own;
    let names: string[] = [];
    try {
      names = readdirSync(root).filter((n) => !n.endsWith(".part"));
    } catch {
      // no copy yet
    }
    return names
      .sort((a, b) => (olderThan(a, b) ? 1 : olderThan(b, a) ? -1 : 0))
      .map((n) => join(root, n, "ollama"))
      .find(exists);
  }
  /** The `ollama serve` this process started (its own copy or a command-line install); stopped with Ressac. */
  let child: { kill(): void } | undefined;
  let starting: Promise<void> | undefined;

  async function version(): Promise<string | undefined> {
    try {
      const r = await f(`${o.url}/api/version`, { signal: AbortSignal.timeout(2000) });
      return r.ok ? String(((await r.json()) as { version?: unknown }).version ?? "") : undefined;
    } catch {
      return undefined;
    }
  }

  async function status(): Promise<OllamaStatus> {
    if (!o.managed) return { kind: "unmanaged" };
    const v = await version();
    if (v !== undefined) return olderThan(v, OLLAMA_MIN) ? { kind: "outdated", version: v, min: OLLAMA_MIN } : { kind: "ready", version: v };
    return { kind: exists(APP) || CLIS.some(exists) || ownBinary() ? "stopped" : "absent" };
  }

  /** Starts the installed Ollama (the app first, then a command-line install, then Ressac's own copy) and waits for it. */
  function start(): Promise<void> {
    starting ??= (async () => {
      if (!o.managed || (await version()) !== undefined) return;
      // shortcut: an Ollama already running keeps its own context length (its app's setting), Ressac never restarts it.
      if (exists(APP)) await run("open", ["-g", "--env", `OLLAMA_CONTEXT_LENGTH=${CONTEXT_LENGTH}`, "-a", APP]);
      else {
        const binary = CLIS.find(exists) ?? ownBinary();
        if (!binary) throw new Error(NOT_STARTED());
        child = launch(binary, ["serve"]);
      }
      for (const end = Date.now() + (o.startDelayMs ?? 30_000); Date.now() < end; ) {
        if ((await version()) !== undefined) return;
        await new Promise((r) => setTimeout(r, o.pollMs ?? 500));
      }
      throw new Error(NOT_STARTED());
    })().finally(() => (starting = undefined));
    return starting;
  }

  /** Downloads Ressac's own Ollama (skipped when it is already there), then starts it. `progress`: 0-100, null without a total. */
  async function install(progress: (percent: number | null) => void): Promise<void> {
    if (!o.managed) throw new Error(NOT_STARTED());
    if (!exists(own)) {
      const part = `${folder}.part`;
      await rm(part, { recursive: true, force: true });
      await mkdir(part, { recursive: true });
      try {
        const r = await f(archive.url);
        if (!r.ok || !r.body) throw new Error(hostSay("host-ollama-download-failed", { status: String(r.status) }));
        const total = Number(r.headers.get("content-length")) || 0;
        const tgz = join(part, "ollama.tgz");
        const hash = createHash("sha256");
        let got = 0;
        // pipeline: a write error (a full disk) rejects here, instead of an uncaught error ending the host.
        await pipeline(
          r.body as unknown as AsyncIterable<Uint8Array>,
          async function* (chunks: AsyncIterable<Uint8Array>) {
            for await (const chunk of chunks) {
              hash.update(chunk);
              got += chunk.length;
              progress(total ? Math.min(100, Math.round((got / total) * 100)) : null);
              yield chunk;
            }
          },
          createWriteStream(tgz),
        );
        if (hash.digest("hex") !== archive.sha256) throw new Error(BAD_ARCHIVE());
        if ((await run("tar", ["-xzf", tgz, "-C", part])) !== 0) throw new Error(BAD_ARCHIVE());
        await rm(tgz, { force: true });
        await rm(folder, { recursive: true, force: true });
        await rename(part, folder);
        // The copies of older versions go: only this one is ever started again.
        for (const n of await readdir(root)) if (n !== OLLAMA_VERSION && !n.endsWith(".part")) await rm(join(root, n), { recursive: true, force: true });
      } catch (e) {
        await rm(part, { recursive: true, force: true });
        throw e;
      }
    }
    await start();
  }

  return { status, start, install, close: () => child?.kill() };
}

export type OllamaRuntime = ReturnType<typeof createOllamaRuntime>;
