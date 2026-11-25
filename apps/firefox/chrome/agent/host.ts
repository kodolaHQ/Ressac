import { createRpc, type Handler, type Rpc } from "../../shared/rpc";
import { format } from "../../shared/i18n";
import { hostCommand } from "./command";
import { lineSplitter } from "./lines";
import type { LoadResult, PassportFiles } from "../passport/store";

/** The shown text when the host process is gone. */
export const hostStopped = (locale: string) => format(locale, "chrome-host-stopped");
/** Pseudo-notification sent to `on()` listeners when the host process exits (no automatic restart). */
export const HOST_EXITED = "$/exited";
const STOP_TIMEOUT_MS = 5_000;
/** A passport read waits this long for the keychain (design § 4.2), then the profile is unreadable for now. */
const PASSPORT_LOAD_CAP_MS = 20_000;

/**
 * Design § 5.2, at each host start: every profile's passport (`passport.replace`), then `passport.ready` naming those it
 * could not read; the host's tools answer nothing before. A read still pending at the cap counts as unreadable, and its
 * passport follows ready once it completes (a replace lifts the banner, ruling F9).
 */
export async function pushPassports(request: (method: string, params: unknown) => Promise<unknown>, files: Pick<PassportFiles, "list" | "load">, capMs = PASSPORT_LOAD_CAP_MS): Promise<void> {
  const replace = (r: LoadResult) => request("passport.replace", { profile: r.profile, entries: r.entries });
  const unreadable: string[] = [];
  let readySent!: () => void;
  const afterReady = new Promise<void>((r) => (readySent = r));
  await Promise.all(
    (await files.list()).map(async (profile) => {
      const load = files.load(profile);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const r = await Promise.race([load, new Promise<null>((ok) => (timer = setTimeout(() => ok(null), capMs)))]).finally(() => clearTimeout(timer));
        if (r === null) {
          unreadable.push(profile);
          void Promise.all([load, afterReady]).then(([late]) => (late.state === "unreadable" ? undefined : replace(late))).catch((e) => console.error("[ressac] passport push failed:", (e as Error)?.name));
        } else if (r.state === "unreadable") unreadable.push(profile);
        // Refused by the host (it holds nothing for it): unreadable, so ready still comes and the banner says so.
        else await replace(r).catch(() => void unreadable.push(profile));
      } catch {
        // A load that threw: unreadable, so ready still comes.
        unreadable.push(profile);
      }
    }),
  );
  await request("passport.ready", { unreadable });
  readySent();
}

/** The Node process running the kernel (apps/firefox/host/host.ts), spoken to in JSON-RPC over its stdin and stdout. */
export interface AgentHost {
  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  /** Dropped while no host runs. */
  notify(method: string, params?: unknown): void;
  /** A notification from the host. */
  on(method: string, cb: (params: any) => void): () => void;
  /** Starts the host if it is not running, then its kernel (`start`, a no-op when it already runs on that profile). */
  ensure(): Promise<void>;
  /** `stop` (5 s at most), then the process is killed. */
  stop(): Promise<void>;
  /** The host's pid while it runs (tests check it is gone after quitting). */
  readonly pid: number | null;
}

interface Running {
  proc: any;
  rpc: Rpc;
}

/** Calls `cb` with each line of a Subprocess pipe until it ends. Not readString(): it gives "" for a chunk holding only part of a character. */
async function readLines(pipe: any, cb: (line: string) => void): Promise<void> {
  const push = lineSplitter(cb);
  try {
    for (let chunk: ArrayBuffer; (chunk = await pipe.read()).byteLength; ) push(chunk);
  } catch {
    // The pipe closed with the process.
  }
}

/**
 * The browser's environment minus what would inject code or certificates into the host's Node (NODE_OPTIONS, NODE_PATH,
 * NODE_EXTRA_CA_CERTS… and the dynamic loader's DYLD_*): whoever sets the app's environment must not run code in the host.
 */
export function hostEnvironment(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("NODE_") && !k.startsWith("DYLD_")));
}

export function createHost(o: {
  dataDir: string;
  agentProfile: () => string;
  locale: () => string;
  /** settings.aiEnabled: off, the host starts no Docker, local model nor kernel. */
  aiEnabled: () => boolean;
  /** The requests the host sends to Firefox (the browser bridge). */
  handlers: Record<string, Handler>;
  /** Each new process, before any other message: what the host must know first (private tabs mirror). `request` goes to that process only. */
  onStart(notify: (method: string, params?: unknown) => void, request: (method: string, params?: unknown) => Promise<unknown>): void;
  /** A process ended without stop() asking it to (a crash, a kill): once per process. */
  onUnexpectedExit?(code: number | null): void;
}): AgentHost {
  const listeners = new Map<string, Set<(params: any) => void>>();
  // createRpc looks handlers up on each message: notifications listened to with on() are added here.
  const handlers: Record<string, Handler> = { ...o.handlers };
  let current: Promise<Running> | null = null;
  let pid: number | null = null;
  // The processes stop() ended: their exit is no crash.
  const stopped = new WeakSet<object>();

  const spawn = async (): Promise<Running> => {
    // Imported here, not at the top: the UI bundles import this file's constants.
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const cmd = await hostCommand(Services.dirsvc.get("GreD", Ci.nsIFile).path, (p) => IOUtils.exists(p));
    const proc = await Subprocess.call({
      command: cmd.command,
      arguments: cmd.arguments,
      environment: { ...hostEnvironment(Subprocess.getEnvironment()), ...cmd.environment, RESSAC_DATA_DIR: o.dataDir },
      stderr: "pipe",
    });
    const rpc = createRpc({ send: (line) => void proc.stdin.write(line + "\n").catch(() => {}), handlers });
    let gone = false;
    // stdout closing is the host going: dropped at once, so Réessayer spawns a new one instead of hitting this rpc.
    const exited = () => {
      if (gone) return;
      gone = true;
      rpc.close(hostStopped(o.locale()));
      if (pid === proc.pid) {
        pid = null;
        current = null;
        // Only the current host: an old one exiting late must not report a stop over its successor.
        for (const l of listeners.get(HOST_EXITED) ?? []) l({ message: hostStopped(o.locale()) });
      }
    };
    void readLines(proc.stdout, (l) => rpc.receive(l)).then(exited);
    void readLines(proc.stderr, (l) => console.warn(`[kernel] ${l}`));
    o.onStart((method, params) => rpc.notify(method, params), (method, params) => rpc.request(method, params));
    pid = proc.pid;
    void proc.wait().then(({ exitCode }: { exitCode: number | null }) => {
      exited();
      if (!stopped.has(proc)) o.onUnexpectedExit?.(exitCode);
    });
    return { proc, rpc };
  };

  const running = (): Promise<Running> => current ?? Promise.reject(new Error(hostStopped(o.locale())));

  const host: AgentHost = {
    request: (method, params, signal) => running().then((r) => r.rpc.request(method, params, signal)),
    notify(method, params) {
      void current?.then((r) => r.rpc.notify(method, params));
    },
    on(method, cb) {
      let set = listeners.get(method);
      if (!set) {
        const s = (set = new Set());
        listeners.set(method, s);
        handlers[method] = (p) => void [...s].forEach((l) => l(p));
      }
      set.add(cb);
      return () => void set.delete(cb);
    },
    async ensure() {
      if (!current) {
        current = spawn();
        current.catch(() => (current = null));
      }
      await host.request("start", { agentProfile: o.agentProfile(), locale: o.locale(), aiEnabled: o.aiEnabled() });
    },
    async stop() {
      const r = await current?.catch(() => null);
      if (!r) return;
      stopped.add(r.proc);
      const timeout = new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS));
      await Promise.race([r.rpc.request("stop").then(() => r.proc.wait()), timeout]).catch(() => {});
      await r.proc.kill();
    },
    get pid() {
      return pid;
    },
  };
  return host;
}
