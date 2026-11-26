import { execFile } from "node:child_process";
import { chmod, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { HashMismatchError, downloadVerified } from "../../../packages/kernel/src/index.ts";
import { hostSay } from "./locale.ts";

type Agent = "claude" | "codex";

/**
 * The agents' linux-arm64 CLIs, the versions pinned in workshop.Dockerfile: npm's platform packages, one native binary each
 * (`member`, whose file name is `binary`). Claude's is the glibc build the bookworm image needs; Codex's is static (musl).
 */
export const AGENT_CLIS: Record<Agent, { version: string; url: string; sha256: string; bytes: number; member: string; binary: string }> = {
  claude: {
    version: "2.1.325",
    url: "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-arm64/-/claude-code-linux-arm64-2.1.325.tgz",
    sha256: "f50a204ede2553b62a801bacab66d6812f4c82adf27b5fadf589ec7219459cef",
    bytes: 170148882,
    member: "package/claude",
    binary: "claude",
  },
  codex: {
    version: "0.169.0",
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-linux-arm64.tgz",
    sha256: "c1555c8ad3913e703d736584ff15e98eaeda685bf6eaedc83ae15943badbc1ff",
    bytes: 171743625,
    member: "package/vendor/aarch64-unknown-linux-musl/bin/codex",
    binary: "codex",
  },
};

const NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };
const tar = promisify(execFile);

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
    /** Installs `a`'s CLI unless it is there at its version; calls at the same time share one download. */
    async ensure(a: Agent, onPercent?: (p: number | null) => void): Promise<void> {
      if (await installed(a)) return;
      let p = pending.get(a);
      if (!p) {
        const listeners = new Set<(p: number | null) => void>();
        const done = install(a, (x) => listeners.forEach((l) => l(x))).finally(() => pending.delete(a));
        pending.set(a, (p = { done, listeners }));
      }
      if (onPercent) p.listeners.add(onPercent);
      return p.done;
    },
    /** Stops the downloads in progress (AI off); their partial files stay for the next try. */
    cancel(): void {
      aborts.abort();
      aborts = new AbortController();
    },
  };
}

export type AgentCli = ReturnType<typeof createAgentCli>;
