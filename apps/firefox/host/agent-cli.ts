import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { HashMismatchError, downloadVerified } from "../../../packages/kernel/src/index.ts";
import { hostSay } from "./locale.ts";
import { AGENT_CLIS, type Agent } from "../shared/downloads.ts";

export { AGENT_CLIS };

export const NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };
/** The pinned CLI a profile runs (the image carries none): its command's when it is one, else by its MCP config. */
export const profileCli = (p: { interactive: readonly string[]; mcpConfig: string }): Agent => {
  const bin = basename(p.interactive[0] ?? "");
  return bin === "claude" || bin === "codex" ? bin : p.mcpConfig === "codex-toml" ? "codex" : "claude";
};
const tar = promisify(execFile);

/** `p` as a real folder: a link (never followed) or a file in its place is removed first. */
async function realDir(p: string): Promise<void> {
  if (!(await lstat(p).catch(() => null))?.isDirectory()) await rm(p, { force: true });
  await mkdir(p, { recursive: true });
}

/**
 * Downloads an agent's CLI into `<internal>/cli/<agent>/<binary>` (the container's /workspace/.ressac, read-only there, first
 * on its PATH). RESSAC_CLI_<AGENT>_URL/_SHA256/_BYTES and RESSAC_TEST_CLI_PRESENT: dev and tests only, like RESSAC_VM_IMAGE_*.
 */
export function createAgentCli(o: { internal: string; download?: typeof downloadVerified; env?: NodeJS.ProcessEnv }) {
  const env = o.env ?? process.env;
  const dev = !env.RESSAC_KERNEL_RESOURCES;
  const download = o.download ?? downloadVerified;
  const pending = new Map<Agent, { done: Promise<void>; listeners: Set<(p: number | null) => void> }>();
  let aborts = new AbortController();

  function pinned(a: Agent) {
    const pin = AGENT_CLIS[a];
    const k = `RESSAC_CLI_${a.toUpperCase()}`;
    const url = env[`${k}_URL`];
    const sha256 = env[`${k}_SHA256`];
    if (!dev || !url || !sha256) return pin;
    return { ...pin, url, sha256, bytes: Number(env[`${k}_BYTES`]) || pin.bytes };
  }

  async function installed(a: Agent): Promise<boolean> {
    if (dev && env.RESSAC_TEST_CLI_PRESENT === "1") return true;
    return (await readFile(join(o.internal, "cli", a, "version"), "utf8").catch(() => "")) === AGENT_CLIS[a].version;
  }

  async function install(a: Agent, onPercent: (p: number | null) => void): Promise<void> {
    const pin = pinned(a);
    const final = join(o.internal, "cli", a);
    const work = `${final}.download`;
    const archive = join(work, `${pin.version}.tgz`);
    await realDir(join(o.internal, "cli"));
    await realDir(work);
    // A download left by another version would resume into a wrong file: only this version's is kept.
    for (const f of await readdir(work).catch(() => [])) if (f !== `${basename(archive)}.part`) await rm(join(work, f), { recursive: true, force: true });
    try {
      await download({ ...pin, file: archive, signal: aborts.signal, onPercent, cancelled: () => new Error(hostSay("host-cli-cancelled", { agent: NAMES[a] })) });
    } catch (e) {
      if (!(e instanceof HashMismatchError)) throw e; // a cut download keeps its .part for the next try
      await rm(work, { recursive: true, force: true });
      throw new Error(hostSay("host-cli-hash", { agent: NAMES[a] }));
    }
    // One named member only (bsdtar), flattened: the binary lands at <work>/<binary>.
    await tar("/usr/bin/tar", ["-xzf", archive, "-C", work, "--strip-components", String(pin.member.split("/").length - 1), pin.member]);
    await rm(archive);
    await chmod(join(work, pin.binary), 0o755);
    await writeFile(join(work, "version"), pin.version);
    await rm(final, { recursive: true, force: true });
    await rename(work, final);
  }

  return {
    installed,
    /**
     * Installs `a`'s CLI unless it is there at its version; calls at the same time share one download. `wait` bounds this
     * caller's wait only (its signal, its delay): the download goes on for the next call.
     */
    async ensure(a: Agent, onPercent?: (p: number | null) => void, wait?: { signal?: AbortSignal; delayMs?: number }): Promise<void> {
      if (await installed(a)) return;
      let p = pending.get(a);
      if (!p) {
        const listeners = new Set<(p: number | null) => void>();
        const done = install(a, (x) => listeners.forEach((l) => l(x))).finally(() => pending.delete(a));
        pending.set(a, (p = { done, listeners }));
      }
      if (onPercent) p.listeners.add(onPercent);
      if (!wait) return p.done;
      const { signal, delayMs } = wait;
      let timer: NodeJS.Timeout | undefined;
      let onAbort = () => {};
      try {
        await Promise.race([
          p.done,
          new Promise<never>((_, reject) => {
            onAbort = () => reject(signal!.reason ?? new Error("aborted"));
            if (signal?.aborted) return onAbort();
            signal?.addEventListener("abort", onAbort, { once: true });
            if (delayMs !== undefined) timer = setTimeout(() => reject(new Error(hostSay("host-cli-slow", { agent: NAMES[a] }))), delayMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (onPercent) p.listeners.delete(onPercent);
      }
    },
    /** Stops the downloads in progress (AI off); their partial files stay for the next try. */
    cancel(): void {
      aborts.abort();
      aborts = new AbortController();
    },
  };
}

export type AgentCli = ReturnType<typeof createAgentCli>;
