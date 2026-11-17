import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { cpus, homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createZstdDecompress } from "node:zlib";
import { HashMismatchError, VOLUME_HOME, createRunner, downloadVerified, type ContainerEngine, type RunResult, type Runner, type WakeReason } from "../../../packages/kernel/src/index.ts";
import { hostLocale, hostSay } from "./locale.ts";

/** The machine image, built by scripts/vm/build-image.sh and published by scripts/vm/publish-image.sh. */
export const VM_IMAGE = {
  version: "3.24.4-5.8.10-20062535e787",
  url: "https://updates.getressac.app/vm/ressac-vm-3.24.4-5.8.10-20062535e787.raw.zst",
  sha256: "1be8f8cfe85ead60fdd61ad4bc376e2965d4c103f3652e2e12a2678fd391ce19",
  bytes: 526076788,
};

/**
 * VM_IMAGE, or another image (a local build, a trial) named by RESSAC_VM_IMAGE_URL (file:// allowed) and
 * RESSAC_VM_IMAGE_SHA256. Its version comes from RESSAC_VM_IMAGE_VERSION, else its `ressac-vm-<version>.raw.zst` name;
 * RESSAC_VM_IMAGE_BYTES caps the download (4 GiB by default).
 */
export function vmImage(env: NodeJS.ProcessEnv = process.env): typeof VM_IMAGE {
  const url = env.RESSAC_VM_IMAGE_URL;
  const sha256 = env.RESSAC_VM_IMAGE_SHA256;
  if (!url || !sha256) return VM_IMAGE;
  const version = env.RESSAC_VM_IMAGE_VERSION || /ressac-vm-([^/]+)\.raw\.zst$/.exec(url)?.[1] || sha256.slice(0, 16);
  return { version, url, sha256, bytes: Number(env.RESSAC_VM_IMAGE_BYTES) || 4 * 2 ** 30 };
}

export type MachineStatus =
  | { kind: "unsupported" | "absent" | "stopped" | "starting" | "running" }
  | { kind: "downloading"; percent: number | null }
  | { kind: "error"; message: string };

const NAME = "ressac";
export const MACHINE_HOME = join(homedir(), ".ressac-vm");
/** macOS's sun_path is 104 bytes with its final NUL. */
const SOCKET_MAX = 103;
/** Lima's vz network: the Mac seen from the guest. */
const HOST_ADDRESS = "192.168.5.2";
const BLOCK = 4096;
const ZERO = Buffer.alloc(BLOCK);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The Lima + Podman machine that runs the workshop. Every limactl call runs with Ressac's own LIMA_HOME, so the user's
 * `~/.lima` (and its `_config/override.yaml`) never applies. Started on demand by `wake`, stopped by a poll: right away
 * when woken only for a harvest, after `idleMs` with nothing busy otherwise.
 */
export function createMachine(o: {
  home?: string;
  /** Lima's own layout: `<prefix>/bin/limactl` finds its guest agent in `<prefix>/share/lima`. */
  limactl: string;
  podman: string;
  /** scripts/vm/lima.yaml. */
  template: string;
  /** The workflow engine folder (the kernel's docker/engine), mounted read-only for the harvests. */
  engine: string;
  ressacRoot: string;
  run?: Runner;
  busy: () => Promise<boolean>;
  idleMs?: number;
  pollMs?: number;
  supported?: () => Promise<boolean>;
  image?: { version: string; url: string; sha256: string; bytes: number };
}) {
  const home = o.home ?? MACHINE_HOME;
  const run = o.run ?? createRunner(hostLocale);
  const image = o.image ?? VM_IMAGE;
  const idleMs = o.idleMs ?? 15 * 60_000;
  const pollMs = o.pollMs ?? 60_000;
  const dir = join(home, NAME);
  const socket = join(dir, "sock", "podman.sock");
  const { limactl, podman } = o;
  const tar = join(home, `${VOLUME_HOME}.tar`);
  const raw = join(home, `ressac-vm-${image.version}.raw`);
  const tooLong = Buffer.byteLength(socket) > SOCKET_MAX;

  const lima = (args: string[], x: { delayMs?: number; input?: string } = {}) => run(limactl, args, { delayMs: 120_000, ...x, env: { LIMA_HOME: home } });
  const shell = (args: string[], x: { delayMs?: number; input?: string } = {}) => lima(["shell", "--workdir", "/", NAME, ...args], x);
  const pod = (args: string[], delayMs = 60_000) => run(podman, ["--url", `unix://${socket}`, ...args], { delayMs });
  const detail = (r: RunResult) => (r.stderr || r.stdout).trim().split("\n").at(-1) ?? "";
  const startFailed = (d: string) => new Error(hostSay("host-machine-start-failed", { detail: d }));
  const damaged = () => new Error(hostSay("host-machine-damaged"));

  let status: MachineStatus = tooLong ? { kind: "error", message: hostSay("host-machine-socket-too-long", { path: socket }) } : { kind: "absent" };
  const listeners = new Set<(s: MachineStatus) => void>();
  const set = (s: MachineStatus) => {
    status = s;
    for (const l of listeners) l(s);
  };

  // Every change of the machine runs one at a time: two wakes start once, a stop never cuts a start.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const p = chain.then(f);
    chain = p.catch(() => {});
    return p;
  };

  let hv: Promise<boolean> | undefined;
  const supported = () => (hv ??= o.supported ? o.supported() : run("sysctl", ["-n", "kern.hv_support"]).then((r) => r.stdout.trim() === "1"));
  /** Throws why the machine cannot run on this Mac. */
  async function usable(): Promise<void> {
    if (tooLong) throw new Error((status as { message: string }).message);
    if (await supported()) return;
    set({ kind: "unsupported" });
    throw new Error(hostSay("host-machine-unsupported"));
  }

  /**
   * The instance as Lima lists it. "empty": listed with no disk at all (a create or first start that did not finish), safe
   * to delete. "damaged": a disk but neither Running nor Stopped; it may hold the logins, so it is never deleted unasked.
   */
  async function instance(): Promise<"absent" | "empty" | "damaged" | "Stopped" | "Running"> {
    const r = await lima(["list", "--json"]);
    if (r.code !== 0) throw startFailed(detail(r));
    const found = r.stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { name: string; status: string })
      .find((i) => i.name === NAME);
    if (!found) return "absent";
    // Lima 2.3 renames the image to `disk` at the first start; the older names count too, should that change again.
    if (!["disk", "diffdisk", "basedisk"].some((f) => existsSync(join(dir, f)))) return "empty";
    return found.status === "Running" || found.status === "Stopped" ? found.status : "damaged";
  }

  /** Paths go inside double-quoted YAML (and Lima templates some fields): refuse any that could escape them. */
  function safe(path: string): string {
    if (/["\\\p{Cc}]|\{\{/u.test(path)) throw new Error(hostSay("host-machine-path-invalid", { path }));
    return path;
  }
  async function render(): Promise<string> {
    const values: Record<string, string> = {
      IMAGE: safe(raw),
      RESSAC_ROOT: safe(o.ressacRoot),
      ENGINE: safe(o.engine),
      CPUS: String(Math.max(1, Math.floor(cpus().length / 2))),
    };
    return (await readFile(o.template, "utf8")).replace(/\{\{(IMAGE|RESSAC_ROOT|ENGINE|CPUS)\}\}/g, (_, k: string) => values[k]!);
  }

  let downloads: AbortController | undefined;
  /** The decompressed image at `raw`: downloaded (or read from a file:// URL) and checked against its SHA-256. */
  async function fetchImage(): Promise<void> {
    if (existsSync(raw)) return;
    await mkdir(home, { recursive: true });
    const local = image.url.startsWith("file:");
    const zst = local ? fileURLToPath(image.url) : `${raw}.zst`;
    try {
      if (local) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(zst)) hash.update(chunk as Buffer);
        if (hash.digest("hex") !== image.sha256) throw new HashMismatchError();
      } else if (!existsSync(zst)) {
        downloads = new AbortController();
        set({ kind: "downloading", percent: null });
        await downloadVerified({
          ...image,
          file: zst,
          signal: downloads.signal,
          onPercent: (percent) => set({ kind: "downloading", percent }),
          cancelled: () => new Error(hostSay("host-machine-cancelled")),
        });
      }
      await decompress(zst, raw);
    } catch (e) {
      throw new Error(hostSay("host-machine-download-failed", { detail: (e as Error).message }));
    } finally {
      downloads = undefined;
    }
    if (!local) await rm(zst, { force: true });
  }

  /** zstd → raw, leaving holes for zero blocks: the 3 GiB image takes its real 1.7 GB on disk. */
  async function decompress(from: string, to: string): Promise<void> {
    const part = `${to}.part`;
    const out = await open(part, "w");
    let pos = 0;
    try {
      await pipeline(createReadStream(from), createZstdDecompress(), async (source: AsyncIterable<Buffer>) => {
        for await (const chunk of source) {
          // Contiguous non-zero blocks go out in one write.
          let from = -1;
          for (let i = 0; i < chunk.length; i += BLOCK) {
            const b = chunk.subarray(i, i + BLOCK);
            const zero = b.equals(ZERO.subarray(0, b.length));
            if (!zero && from < 0) from = i;
            if (zero && from >= 0) {
              await out.write(chunk, from, i - from, pos + from);
              from = -1;
            }
          }
          if (from >= 0) await out.write(chunk, from, chunk.length - from, pos + from);
          pos += chunk.length;
        }
      });
      await out.truncate(pos);
    } finally {
      await out.close();
    }
    await rename(part, to);
  }

  /** Boots (unless already running), waits for Podman, upgrades a guest older than the image, imports saved logins. */
  async function start(running: boolean): Promise<void> {
    if (!running) {
      await writeFile(join(dir, "lima.yaml"), await render());
      set({ kind: "starting" });
      const r = await lima(["start", "--tty=false", NAME], { delayMs: 5 * 60_000 });
      if (r.code !== 0) throw startFailed(detail(r));
    }
    for (let i = 0; ; i++) {
      const r = await pod(["info"], 10_000);
      if (r.code === 0) break;
      if (i >= 30) throw startFailed(detail(r));
      await sleep(500);
    }
    if (running) return;
    if ((await shell(["cat", "/etc/ressac-vm-version"])).stdout.trim() !== image.version) {
      const u = await shell(["sudo", "apk", "upgrade", "--no-cache"], { delayMs: 10 * 60_000 });
      if (u.code === 0) await shell(["sudo", "tee", "/etc/ressac-vm-version"], { input: `${image.version}\n` });
    }
    await rm(raw, { force: true }); // the instance has its own disk now
    if (existsSync(tar)) {
      await pod(["volume", "create", "--ignore", VOLUME_HOME]);
      // A failed import keeps the export: the next start tries again.
      if ((await pod(["volume", "import", VOLUME_HOME, tar], 10 * 60_000)).code === 0) await rm(tar, { force: true });
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let mode: WakeReason = "user";
  let idle = 0;
  let wakes = 0;
  let polling = false;
  function watch(reason: WakeReason): void {
    if (!timer || reason === "user") mode = reason; // a harvest on a machine running for the user keeps the idle rule
    idle = 0;
    wakes++;
    timer ??= setInterval(() => void poll(), pollMs);
    timer.unref?.();
  }
  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const seen = wakes;
      if (await o.busy()) idle = 0;
      else if (mode === "harvest" || (idle += pollMs) >= idleMs)
        await serial(async () => {
          if (wakes === seen && timer) await stopInner(); // a wake since the busy check wins
        });
    } catch {
      // The next poll tries again.
    } finally {
      polling = false;
    }
  }
  const unwatch = () => {
    clearInterval(timer);
    timer = undefined;
  };

  /** On failure the poll stays armed and tries again. */
  async function stopInner(): Promise<void> {
    if ((await instance()) === "Running") {
      await shell(["sudo", "fstrim", "-a"], { delayMs: 60_000 }); // gives freed blocks back to the Mac's disk
      if ((await lima(["stop", NAME], { delayMs: 60_000 })).code !== 0) {
        const f = await lima(["stop", "--force", NAME]);
        if (f.code !== 0) throw startFailed(detail(f));
      }
    }
    unwatch();
    set({ kind: "stopped" });
  }

  async function installInner(reason: WakeReason): Promise<void> {
    await usable();
    const was = await instance();
    if (was === "Running" || was === "Stopped") return;
    if (was === "damaged") throw damaged();
    if (was === "empty") await lima(["delete", "--force", NAME]);
    await fetchImage();
    const yaml = join(home, `${NAME}.yaml`);
    await writeFile(yaml, await render());
    const c = await lima(["create", "--tty=false", "--name", NAME, yaml]);
    await rm(yaml, { force: true });
    if (c.code !== 0) throw startFailed(detail(c));
    await start(false);
    watch(reason);
    set({ kind: "running" });
  }

  /** Runs a change; a failure shows as the `error` status (unless the Mac cannot run the machine at all). */
  const guarded = <T>(f: () => Promise<T>): Promise<T> =>
    serial(async () => {
      try {
        return await f();
      } catch (e) {
        if (status.kind !== "unsupported") set({ kind: "error", message: (e as Error).message });
        throw e;
      }
    });

  // The status at launch; a machine left running (crash) gets the idle rule.
  if (!tooLong)
    void serial(async () => {
      if (!(await supported())) return set({ kind: "unsupported" });
      const was = await instance();
      if (was === "Running") watch("user");
      set(was === "damaged" ? { kind: "error", message: damaged().message } : { kind: was === "Running" ? "running" : was === "Stopped" ? "stopped" : "absent" });
    }).catch(() => {});

  return {
    kind: "machine" as const,
    binary: () => podman,
    args: () => ["--url", `unix://${socket}`],
    hostAddress: () => HOST_ADDRESS,
    async up() {
      if (tooLong || !(await supported())) return false;
      return (await instance().catch(() => "absent")) === "Running" && (await pod(["info"], 10_000)).code === 0;
    },
    wake: (reason: WakeReason) =>
      guarded(async () => {
        await usable();
        const was = await instance();
        if (was === "absent" || was === "empty" || was === "damaged") return installInner(reason);
        if (was === "Stopped" || status.kind !== "running") await start(was === "Running");
        watch(reason);
        set({ kind: "running" });
      }),
    status: () => status,
    onStatus(l: (s: MachineStatus) => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    install: () => guarded(() => installInner("user")),
    stop: () => serial(stopInner),
    /**
     * Keeps the logins: exports them first (unless an export is still waiting to be imported), then deletes the instance.
     * A damaged instance is started for that; when it cannot be, or the export fails, the instance is kept.
     */
    remove: () =>
      guarded(async () => {
        if (tooLong) return;
        unwatch();
        const was = await instance();
        if (was !== "absent" && was !== "empty" && !existsSync(tar)) {
          await start(was === "Running");
          const exists = await pod(["volume", "exists", VOLUME_HOME]);
          // 1 is "no such volume"; any other failure (125, timeout) must not pass for it.
          if (exists.code !== 0 && exists.code !== 1) throw new Error(hostSay("host-machine-export-failed", { detail: detail(exists) }));
          if (exists.code === 0) {
            const e = await pod(["volume", "export", VOLUME_HOME, "--output", `${tar}.part`], 10 * 60_000);
            if (e.code !== 0) throw new Error(hostSay("host-machine-export-failed", { detail: detail(e) }));
            await rename(`${tar}.part`, tar);
          }
        }
        if (was !== "absent") await lima(["delete", "--force", NAME]);
        set({ kind: "absent" });
      }),
    async close() {
      unwatch();
      downloads?.abort();
      if (tooLong || !(await supported())) return;
      await serial(async () => {
        if ((await instance()) === "Running") await stopInner();
      }).catch(() => {});
    },
    async usage(): Promise<{ memoryMB: number; diskMB: number } | null> {
      if (tooLong || (await instance().catch(() => "absent")) === "absent") return null;
      const diskKB = Number((await run("du", ["-sk", dir])).stdout.split(/\s/)[0]) || 0;
      // The vz process that holds the instance's disk open is the machine (plus Lima's own small host agent).
      const pids = (await run("lsof", ["-t", join(dir, "disk")])).stdout.split("\n").filter((p) => /^\d+$/.test(p));
      const rss = pids.length ? (await run("ps", ["-o", "rss=", "-p", pids.join(",")])).stdout : "";
      const memoryKB = rss.split(/\s+/).reduce((n, v) => n + (Number(v) || 0), 0);
      return { memoryMB: Math.round(memoryKB / 1024), diskMB: Math.round(diskKB / 1024) };
    },
  } satisfies ContainerEngine & Record<string, unknown>;
}
