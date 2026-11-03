import { createRpc, type Handler, type Rpc } from "../../shared/rpc";
import { lineSplitter } from "./lines";

export const HOST_STOPPED = "Le noyau de l'agent s'est arrêté.";
/** Pseudo-notification sent to `on()` listeners when the host process exits (no automatic restart). */
export const HOST_EXITED = "$/exited";
const STOP_TIMEOUT_MS = 5_000;

/** The Node process running the noyau (apps/firefox/noyau/host.ts), spoken to in JSON-RPC over its stdin and stdout. */
export interface AgentHost {
  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  /** Dropped while no host runs. */
  notify(method: string, params?: unknown): void;
  /** A notification from the host. */
  on(method: string, cb: (params: any) => void): () => void;
  /** Starts the host if it is not running, then its noyau (`demarrer`, a no-op when it already runs on that profile). */
  ensure(): Promise<void>;
  /** `arreter` (5 s at most), then the process is killed. */
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

export function createHost(o: {
  dataDir: string;
  profilAgent: () => string;
  /** The requests the host sends to Firefox (the browser bridge). */
  handlers: Record<string, Handler>;
  /** Each new process, before any other message: what the host must know first (private tabs mirror). */
  onStart(notify: (method: string, params?: unknown) => void): void;
}): AgentHost {
  const listeners = new Map<string, Set<(params: any) => void>>();
  // createRpc looks handlers up on each message: notifications listened to with on() are added here.
  const handlers: Record<string, Handler> = { ...o.handlers };
  let current: Promise<Running> | null = null;
  let pid: number | null = null;

  const spawn = async (): Promise<Running> => {
    // Imported here, not at the top: the UI bundles import this file's constants.
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const proc = await Subprocess.call({
      command: __WEBAIOS_NODE__,
      arguments: ["--import", __WEBAIOS_TSX__, __WEBAIOS_HOST__],
      environment: { WEBAIOS_DATA_DIR: o.dataDir },
      environmentAppend: true,
      stderr: "pipe",
    });
    const rpc = createRpc({ send: (line) => void proc.stdin.write(line + "\n").catch(() => {}), handlers });
    void readLines(proc.stdout, (l) => rpc.receive(l));
    void readLines(proc.stderr, (l) => console.warn(`[noyau] ${l}`));
    o.onStart((method, params) => rpc.notify(method, params));
    pid = proc.pid;
    void proc.wait().then(() => {
      rpc.close(HOST_STOPPED);
      if (pid === proc.pid) {
        pid = null;
        current = null;
        // Only the current host: an old one exiting late must not report a stop over its successor.
        for (const l of listeners.get(HOST_EXITED) ?? []) l({ message: HOST_STOPPED });
      }
    });
    return { proc, rpc };
  };

  const running = (): Promise<Running> => current ?? Promise.reject(new Error(HOST_STOPPED));

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
      await host.request("demarrer", { profilAgent: o.profilAgent() });
    },
    async stop() {
      const r = await current?.catch(() => null);
      if (!r) return;
      const timeout = new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS));
      await Promise.race([r.rpc.request("arreter").then(() => r.proc.wait()), timeout]).catch(() => {});
      await r.proc.kill();
    },
    get pid() {
      return pid;
    },
  };
  return host;
}
