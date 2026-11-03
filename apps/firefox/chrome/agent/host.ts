import { createRpc, type Handler, type Rpc } from "../../shared/rpc";

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

export const HOST_STOPPED = "Le noyau de l'agent s'est arrêté.";
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

/** Calls `cb` with each line of a Subprocess pipe until it ends. */
async function readLines(pipe: any, cb: (line: string) => void): Promise<void> {
  let buffer = "";
  try {
    for (let s: string; (s = await pipe.readString()); ) {
      buffer += s;
      for (let i: number; (i = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(i + 1)) cb(buffer.slice(0, i));
    }
  } catch {
    // The pipe closed with the process.
  }
}

export function createHost(o: {
  dataDir: string;
  profilAgent: () => string;
  /** The requests the host sends to Firefox (the browser bridge). */
  handlers: Record<string, Handler>;
  /** Each new process: what the host must know before anything else (private tabs mirror). */
  onStart(host: AgentHost): void;
}): AgentHost {
  const listeners = new Map<string, Set<(params: any) => void>>();
  // createRpc looks handlers up on each message: notifications listened to with on() are added here.
  const handlers: Record<string, Handler> = { ...o.handlers };
  let current: Promise<Running> | null = null;
  let pid: number | null = null;

  const spawn = async (): Promise<Running> => {
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
    pid = proc.pid;
    void proc.wait().then(() => {
      rpc.close(HOST_STOPPED);
      if (pid === proc.pid) {
        pid = null;
        current = null;
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
        current.then(
          () => o.onStart(host),
          () => (current = null),
        );
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
