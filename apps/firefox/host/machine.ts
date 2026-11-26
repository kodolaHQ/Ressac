import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, createReadStream, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { appendFile, chmod, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { cpus, homedir, totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createZstdDecompress } from "node:zlib";
import { HashMismatchError, VOLUME_HOME, createRunner, downloadVerified, sha256File, type ContainerEngine, type RunResult, type Runner, type WakeReason } from "../../../packages/kernel/src/index.ts";
import { hostLocale, hostSay } from "./locale.ts";
import { isSmallMac, type MachineStatus } from "../shared/settings.ts";
import { VM_IMAGE_BYTES } from "../shared/downloads.ts";

/** The machine image, built by scripts/vm/build-image.sh and published by scripts/vm/publish-image.sh. */
export const VM_IMAGE = {
  version: "3.24.4-5.8.11-080782491c00",
  url: "https://updates.getressac.app/vm/ressac-vm-3.24.4-5.8.11-080782491c00.raw.zst",
  sha256: "05e944a7632aa6c5e6256d37b29c7d153adffef2d28bf91d1d42e3053086623d",
  bytes: VM_IMAGE_BYTES, // in shared/downloads.ts: the welcome shows it
};

/**
 * VM_IMAGE, or another image (a local build, a trial) named by RESSAC_VM_IMAGE_URL (file:// allowed) and
 * RESSAC_VM_IMAGE_SHA256. Its version comes from RESSAC_VM_IMAGE_VERSION, else its `ressac-vm-<version>.raw.zst` name;
 * RESSAC_VM_IMAGE_BYTES caps the download (4 GiB by default). Dev only: the packaged host (RESSAC_KERNEL_RESOURCES set)
 * always takes VM_IMAGE.
 */
export function vmImage(env: NodeJS.ProcessEnv = process.env): typeof VM_IMAGE {
  const url = env.RESSAC_VM_IMAGE_URL;
  const sha256 = env.RESSAC_VM_IMAGE_SHA256;
  if (!url || !sha256 || env.RESSAC_KERNEL_RESOURCES) return VM_IMAGE;
  const version = env.RESSAC_VM_IMAGE_VERSION || /ressac-vm-([^/]+)\.raw\.zst$/.exec(url)?.[1] || sha256.slice(0, 16);
  return { version, url, sha256, bytes: Number(env.RESSAC_VM_IMAGE_BYTES) || 4 * 2 ** 30 };
}

export type { MachineStatus };

const NAME = "ressac";
export const MACHINE_HOME = join(homedir(), ".ressac-vm");

/** A Mac of 8 GiB or less (shared/settings.ts isSmallMac): the VM boots smaller and the local models unload sooner. */
export const smallMac = (total = totalmem()) => isSmallMac(total, process.env.RESSAC_TEST_SMALL_MAC);
/**
 * macOS memory pressure level: kern.memorystatus_vm_pressure_level, 1 normal, 2 warn, 4 critical. RESSAC_TEST_PRESSURE_FILE
 * (tests): a file holding the level instead. Unreadable: calm.
 */
export async function memoryLevel(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const file = env.RESSAC_TEST_PRESSURE_FILE;
  const level = file
    ? await readFile(file, "utf8").catch(() => "1")
    : await promisify(execFile)("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).then((r) => r.stdout, () => "1");
  return Number(level.trim()) || 1;
}
export const memoryCalm = async (env: NodeJS.ProcessEnv = process.env) => (await memoryLevel(env)) <= 1;
/** Scheduled harvests and page indexing may start: always, unless saving memory under macOS pressure. */
export const memoryAllows = (saving: boolean, env: NodeJS.ProcessEnv = process.env) => (saving ? memoryCalm(env) : Promise.resolve(true));
/**
 * Some time after the Mac wakes: a wake is a jump of the wall clock between two `tick`s (a timer stops while the Mac
 * sleeps). `ok` ticks too, so a job whose timer fires first at wake already sees it.
 */
export function createWakeGrace(graceMs: number, now = () => Date.now()): { tick(): void; ok(): boolean } {
  let last = now();
  let wokeAt = -Infinity;
  const tick = () => {
    const t = now();
    if (t - last > 30_000) wokeAt = t;
    last = t;
  };
  return { tick, ok: () => (tick(), now() - wokeAt >= graceMs) };
}
/** macOS's sun_path is 104 bytes with its final NUL. */
const SOCKET_MAX = 103;
/** Lima's vz network: the Mac seen from the guest. */
const HOST_ADDRESS = "192.168.5.2";
const BLOCK = 4096;
/**
 * $1 limactl, $2 instance, $3 grace (s), $4 1 when a start may be in flight: waits up to 5 min for it to run, $5 the
 * launch's token: once a newer launch wrote its own to $LIMA_HOME/launch, the machine is its, never stopped from here.
 * $6 (the crash watcher): the host's pid, waited for first.
 */
export const QUIT_STOP = [
  `L=$1 N=$2 T=$5`,
  `[ -z "$6" ] || while kill -0 "$6" 2>/dev/null; do sleep 10; done`,
  `sleep "$3"`,
  `mine() { [ "$(cat "$LIMA_HOME/launch" 2>/dev/null)" = "$T" ] || exit 0; }`,
  `st() { "$L" list --format '{{.Status}}' "$N" 2>/dev/null; }`,
  `if [ "$4" = 1 ]; then i=0; while mine && [ $i -lt 300 ] && [ "$(st)" != Running ]; do sleep 1; i=$((i + 1)); done; fi`,
  `mine`,
  `[ "$(st)" = Running ] || exit 0`,
  // An apk upgrade in the guest is never cut (a broken Podman would follow): waited for, up to 5 min.
  `i=0; while [ $i -lt 150 ] && "$L" shell --workdir / "$N" pgrep -x apk >/dev/null 2>&1; do sleep 2; i=$((i + 1)); done`,
  `mine`,
  `"$L" stop "$N" || "$L" stop --force "$N"`,
].join("\n");
const detached = (args: string[], env: Record<string, string>) =>
  spawn("/bin/sh", ["-c", ...args], { detached: true, stdio: "ignore", env: { ...process.env, ...env } }).unref();
const ZERO = Buffer.alloc(BLOCK);
/** Rewrites the guest's mark from what it really runs (apk may deliver less than the image), keeping its setup hash. */
const MARK = `h=$(sed 's/.*-//' /etc/ressac-vm-version); echo "$(cat /etc/alpine-release)-$(podman version -f '{{.Client.Version}}')-$h" >/etc/ressac-vm-version\n`;
/**
 * Run as root in the guest (stdin): `apk upgrade` detached, so the boot goes on and apk is never cut by a timeout; the
 * mark is rewritten by the job itself once apk succeeds. Skipped while an apk runs (an earlier boot's job).
 */
export const UPGRADE = `pgrep -x apk >/dev/null && exit 0
JOB=$(cat <<'EOF'
apk upgrade --no-cache || exit 1
${MARK}EOF
)
nohup sh -c "$JOB" >/dev/null 2>&1 </dev/null &
`;
/** `<alpine>-<podman>-<setup hash>`, as guest-setup.sh writes it. */
const parts = (v: string) => {
  const [alpine = "", podman = "", setup = ""] = v.split("-");
  return { alpine, podman, setup, branch: alpine.split(".").slice(0, 2).join(".") };
};
const older = (a: string, b: string): boolean => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The packaged engine folder copied to `<dataDir>/engine-<content hash>`, at a path that stays when the app moves
 * (translocation), and never rewritten while a machine that survived a relaunch still mounts it: a new content goes to a
 * new folder (its lima.yaml then differs: restarted when idle), the older ones are deleted at the next boot. A failed
 * copy falls back to the shipped folder.
 */
export function engineCopy(shipped: string, dataDir: string): string {
  try {
    const hash = createHash("sha256");
    for (const f of (readdirSync(shipped, { recursive: true }) as string[]).sort()) {
      const p = join(shipped, f);
      if (statSync(p).isFile()) hash.update(`${f}\0`).update(readFileSync(p));
    }
    const target = join(dataDir, `engine-${hash.digest("hex").slice(0, 12)}`);
    if (existsSync(target)) return target;
    const part = join(dataDir, `.engine-part-${process.pid}`);
    rmSync(part, { recursive: true, force: true });
    cpSync(shipped, part, { recursive: true });
    try {
      renameSync(part, target);
    } catch (e) {
      rmSync(part, { recursive: true, force: true });
      if (!existsSync(target)) throw e; // else another launch made the same copy first
    }
    return target;
  } catch (e) {
    console.error("[ressac] the engine folder could not be copied, the shipped one is used:", e);
    return shipped;
  }
}

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
  /** Read at each poll: a change applies to a machine already running. */
  idleMs?: number | (() => number);
  pollMs?: number;
  supported?: () => Promise<boolean>;
  /** Runs the quit stop script (`sh -c <script> <args>`) so that it outlives the host; tests replace it. */
  detach?: (args: string[], env: Record<string, string>) => void;
  /** Seconds the quit stop leaves the sessions and apps in the machine to stop cleanly. */
  quitGraceS?: number;
  image?: { version: string; url: string; sha256: string; bytes: number };
  /** The Mac's memory in bytes (os.totalmem() by default): it sizes the VM. */
  totalMemory?: number;
}) {
  const home = o.home ?? MACHINE_HOME;
  const run = o.run ?? createRunner(hostLocale);
  const image = o.image ?? VM_IMAGE;
  const idleOption = o.idleMs ?? 5 * 60_000; // short: the VM never gives back memory it touched until it stops
  const idleMs = typeof idleOption === "function" ? idleOption : () => idleOption;
  const pollMs = o.pollMs ?? 60_000;
  const memoryGiB = smallMac(o.totalMemory) ? 1.5 : 3;
  const dir = join(home, NAME);
  const socket = join(dir, "sock", "podman.sock");
  const { limactl, podman } = o;
  const tar = join(home, `${VOLUME_HOME}.tar`);
  const raw = join(home, `ressac-vm-${image.version}.raw`);
  const tooLong = Buffer.byteLength(socket) > SOCKET_MAX;
  /** Written by a removal, deleted by the user's « Installer »: until then nothing installs the machine on its own. */
  const removedMark = join(home, "removed");
  const absent = (): MachineStatus => (existsSync(removedMark) ? { kind: "absent", removed: true } : { kind: "absent" });
  const removedError = () => new Error(hostSay("host-machine-removed"));

  const lima = (args: string[], x: { delayMs?: number; input?: string } = {}) => run(limactl, args, { delayMs: 120_000, ...x, env: { LIMA_HOME: home } });
  const shell = (args: string[], x: { delayMs?: number; input?: string } = {}) => lima(["shell", "--workdir", "/", NAME, ...args], x);
  const pod = (args: string[], delayMs = 60_000) => run(podman, ["--url", `unix://${socket}`, ...args], { delayMs });
  const detail = (r: RunResult) => (r.stderr || r.stdout).trim().split("\n").at(-1) ?? "";
  const startFailed = (d: string) => new Error(hostSay("host-machine-start-failed", { detail: d }));
  /** Errors after which only a forced removal is left: the status offers it. */
  const forceable = (message: string) => Object.assign(new Error(message), { forceRemovable: true as const });
  const damaged = () => forceable(hostSay("host-machine-damaged"));

  let status: MachineStatus = tooLong ? { kind: "error", message: hostSay("host-machine-socket-too-long", { path: socket }) } : absent();
  const listeners = new Set<(s: MachineStatus) => void>();
  const set = (s: MachineStatus) => {
    status = s;
    for (const l of listeners) l(s);
  };

  // Every change of the machine runs one at a time: two wakes start once, a stop never cuts a start.
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    pending++;
    const p = chain.then(f).finally(() => pending--);
    chain = p.catch(() => {});
    return p;
  };

  let hv: Promise<boolean> | undefined;
  const supported = () => (hv ??= o.supported ? o.supported() : run("sysctl", ["-n", "kern.hv_support"]).then((r) => r.stdout.trim() === "1"));
  /** Throws why the machine cannot run on this Mac. */
  let closed = false;
  const token = randomUUID();
  /** This launch now owns the machine: an older launch's quit stop leaves it alone. */
  /** The folder holds the exported logins (OAuth credentials): the user's alone, an older 0755 one included. */
  const ownHome = async () => {
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
  };
  const claim = async (t: string = token) => {
    await ownHome();
    await writeFile(join(home, "launch"), t);
  };
  const detach = o.detach ?? detached;
  let claimed: Promise<void> | undefined;
  async function usable(): Promise<void> {
    if (closed) throw new Error(hostSay("host-machine-cancelled"));
    if (tooLong) throw new Error((status as { message: string }).message);
    if (await supported()) {
      if (claimed) return claimed.then(() => claim()); // again at each use: another Ressac's quit may have taken it
      return (claimed = claim().then(
        // Should the host die without its quit (crash, kill -9), this stops the machine; a quit or a newer launch takes the token from it.
        () => detach([QUIT_STOP, "ressac-vm-watch", limactl, NAME, "0", "0", token, String(process.pid)], { LIMA_HOME: home }),
        (e) => {
          claimed = undefined; // tried again at the next change
          throw e;
        },
      ));
    }
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
      MEMORY: `${memoryGiB}GiB`,
    };
    return (await readFile(o.template, "utf8")).replace(/\{\{(IMAGE|RESSAC_ROOT|ENGINE|CPUS|MEMORY)\}\}/g, (_, k: string) => values[k]!);
  }

  let downloads: AbortController | undefined;
  /** The decompressed image at `raw`: downloaded (or read from a file:// URL) and checked against its SHA-256. */
  async function fetchImage(): Promise<void> {
    if (existsSync(raw)) return;
    await ownHome();
    // An older version's download or image (cut short, or left by a failed create) is never read again.
    for (const f of await readdir(home)) if (f.startsWith("ressac-vm-") && !f.startsWith(`ressac-vm-${image.version}.raw`)) await rm(join(home, f), { force: true });
    const local = image.url.startsWith("file:");
    const zst = local ? fileURLToPath(image.url) : `${raw}.zst`;
    try {
      if (local) {
        if ((await sha256File(zst)) !== image.sha256) throw new HashMismatchError();
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
      await pruneEngines();
    }
    const guestVersion = async () => parts((await shell(["cat", "/etc/ressac-vm-version"])).stdout.trim());
    const want = parts(image.version);
    const owed = (g: ReturnType<typeof parts>) => g.branch === want.branch && g.setup === want.setup && (older(g.alpine, want.alpine) || older(g.podman, want.podman));
    for (let i = 0, healed = false; ; i++) {
      const r = await pod(["info"], 10_000);
      if (r.code === 0) break;
      if (i >= 30) {
        if (healed || !owed(await guestVersion())) throw startFailed(detail(r));
        // An upgrade cut short (a crash, a stop past its wait) can leave Podman broken: apk completes it, once, then Podman is asked again.
        healed = true;
        i = 0;
        await shell(["sudo", "sh"], { input: "apk fix --no-cache; apk upgrade --no-cache\n", delayMs: 10 * 60_000 });
        continue;
      }
      await sleep(500);
    }
    if (running) return;
    const guest = await guestVersion();
    // apk stays on the guest's Alpine branch and never runs guest-setup.sh: only a new machine brings those.
    if (guest.branch !== want.branch || guest.setup !== want.setup) {
      console.warn(`[ressac] the machine (${guest.alpine}, setup ${guest.setup}) differs from its image ${image.version}: removing it in Réglages brings the new one`);
    } else if (owed(guest)) {
      // A stop waits for it (stopInner, QUIT_STOP); one cut anyway (crash, past 5 min) is healed at the next boot.
      await shell(["sudo", "sh"], { input: UPGRADE });
    }
    await rm(raw, { force: true }); // the instance has its own disk now
    if (existsSync(tar)) {
      await pod(["volume", "create", "--ignore", VOLUME_HOME]);
      // A failed import keeps the export: the next start tries again.
      if ((await pod(["volume", "import", VOLUME_HOME, tar], 10 * 60_000)).code === 0) await rm(tar, { force: true });
    }
  }

  /** The packaged engine copies (`engine-<hash>`, engineCopy): once booted with this one, the others are mounted no more. */
  async function pruneEngines(): Promise<void> {
    const name = basename(o.engine);
    if (!name.startsWith("engine-")) return;
    const parent = dirname(o.engine);
    for (const f of await readdir(parent).catch(() => [])) if (f.startsWith("engine-") && f !== name) await rm(join(parent, f), { recursive: true, force: true }).catch(() => {});
  }

  /** An apk (the detached upgrade) runs in the guest. */
  const upgrading = async () => (await shell(["pgrep", "-x", "apk"], { delayMs: 10_000 })).code === 0;

  let timer: ReturnType<typeof setInterval> | undefined;
  let mode: WakeReason = "user";
  // Wall clock: a Mac's sleep counts as idle (a count of poll ticks would not, and the machine kept its memory past a wake).
  let idleSince = Date.now();
  let wakes = 0;
  /** `wakes` at the previous poll. */
  let polled = 0;
  let polling = false;
  function watch(reason: WakeReason): void {
    if (!timer || reason === "user") mode = reason; // a harvest on a machine running for the user keeps the idle rule
    idleSince = Date.now();
    wakes++;
    timer ??= setInterval(() => void poll(), pollMs);
    timer.unref?.();
  }
  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const seen = wakes;
      // A harvest that woke the machine since the previous poll may not have started its container yet: one poll of grace.
      const quiet = seen === polled;
      polled = seen;
      if ((await o.busy()) || (await upgrading())) idleSince = Date.now();
      else if (mode === "harvest" ? quiet : Date.now() - idleSince >= idleMs())
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
      for (let i = 0; i < 150 && (await upgrading()); i++) await sleep(2000); // apk is never cut: at most 5 min
      await shell(["sudo", "fstrim", "-a"], { delayMs: 60_000 }); // gives freed blocks back to the Mac's disk
      if ((await lima(["stop", NAME], { delayMs: 60_000 })).code !== 0) {
        const f = await lima(["stop", "--force", NAME]);
        if (f.code !== 0) throw startFailed(detail(f));
      }
    }
    unwatch();
    set({ kind: "stopped" });
  }

  /**
   * Up and answering. A Running machine this launch saw running (or in error) whose Podman is gone (stale after the Mac
   * slept) is force-stopped and booted again; asked twice, so one hiccup never cuts the sessions in it.
   */
  async function ensureUp(was: "Running" | "Stopped" | "damaged"): Promise<void> {
    if (was === "Running" && (status.kind === "running" || status.kind === "error")) {
      const answers = async () => (await pod(["info"], 10_000)).code === 0;
      if ((await answers()) || (await sleep(1000).then(answers))) return;
      await lima(["stop", "--force", NAME]);
      was = "Stopped";
    }
    await start(was === "Running");
  }

  async function boot(reason: WakeReason, was: "Running" | "Stopped"): Promise<void> {
    const booted = was === "Running" ? await readFile(join(dir, "lima.yaml"), "utf8").catch(() => null) : null;
    if (booted !== null && booted !== (await render())) {
      // Booted by another Ressac (a dev build next to the app) with its own folders mounted, not this one's.
      if (await o.busy()) throw new Error(hostSay("host-machine-in-use"));
      await stopInner();
      was = "Stopped";
    }
    await ensureUp(was);
    watch(reason);
    set({ kind: "running" });
  }

  async function installInner(reason: WakeReason): Promise<void> {
    await usable();
    const was = await instance();
    // « Réessayer » after a failed boot boots it again; an installed machine is otherwise left as it is.
    if (was === "Running" || was === "Stopped") return status.kind === "error" ? boot(reason, was) : undefined;
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
  const guard = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (status.kind !== "unsupported") set({ kind: "error", message: (e as Error).message, ...((e as { forceRemovable?: true }).forceRemovable && { forceRemovable: true as const }) });
      throw e;
    }
  };
  const guarded = <T>(f: () => Promise<T>): Promise<T> => serial(() => guard(f));
  /** A harvest never re-creates a removed machine nor retries a failing one: background work waits for the user. */
  const harvestable = () => status.kind !== "absent" && status.kind !== "error";
  /** A user's install (« Installer », « Réessayer ») clears the removal; an automatic one (AI on) refuses while it holds. */
  const install = (r: { auto?: boolean } = {}) =>
    serial(async () => {
      if (r.auto && existsSync(removedMark)) throw removedError();
      if (!r.auto) await rm(removedMark, { force: true });
      // AI on installs ahead of any use: the new machine stops once idle, as after a harvest (its first boot is owed anyway).
      return guard(() => installInner(r.auto ? "harvest" : "user"));
    });

  // The status at launch; a machine left running (crash) gets the idle rule.
  const known = tooLong
    ? Promise.resolve()
    : serial(async () => {
      if (!(await supported())) return set({ kind: "unsupported" });
      const was = await instance();
      if (was === "Running") watch("user");
      set(was === "damaged" ? { kind: "error", message: damaged().message, forceRemovable: true } : was === "Running" ? { kind: "running" } : was === "Stopped" ? { kind: "stopped" } : absent());
    }).catch(() => {
      // Lima did not answer: an installed machine must not vanish from the harvests (the wake tells the real state).
      if (status.kind === "absent" && !existsSync(removedMark) && existsSync(dir)) set({ kind: "stopped" });
    });

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
      serial(async () => {
        // Checked in turn (after the launch's status and any removal before it), outside `guard`: the status stays.
        if (existsSync(removedMark)) throw removedError();
        if (reason === "harvest" && !harvestable()) throw new Error(hostSay("kernel-err-machine-stopped"));
        return guard(async () => {
          await usable();
          const was = await instance();
          if (was === "absent" || was === "empty" || was === "damaged") return installInner(reason);
          await boot(reason, was);
        });
      }),
    /** False when a harvest's wake would be refused (the machine removed, or failing): the background work then waits. */
    harvestable: async () => (await known, harvestable()),
    status: () => status,
    onStatus(l: (s: MachineStatus) => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    install,
    stop: () => serial(stopInner),
    /** The workshop container's memory cap in bytes: the VM's size less 0.5 GiB for the guest (Alpine, Podman, a harvest). */
    memory: () => (memoryGiB - 0.5) * 2 ** 30,
    /**
     * macOS runs short of memory: the machine stops now, as the idle poll would, unless something uses it or a wake came
     * since the last poll (its session or harvest may not have started yet).
     */
    relieve: () =>
      serial(async () => {
        if (!timer || wakes !== polled || (await o.busy()) || (await upgrading())) return;
        await stopInner();
      }),
    /** AI off: the image download in flight stops (its part is kept for the next try); a machine booting or running stops once up. */
    cancel(): Promise<void> {
      downloads?.abort();
      return serial(async () => {
        if ((await instance()) === "Running") await stopInner();
      });
    },
    /**
     * Keeps the logins: exports them first (unless an export is still waiting to be imported), then deletes the instance.
     * A damaged instance is started for that; when it cannot be, or the export fails, the instance is kept. `force`
     * deletes without any export: the logins are lost (offered in Réglages › Atelier after a damaged instance or a failed export).
     */
    remove: (r: { force?: boolean } = {}) =>
      guarded(async () => {
        if (tooLong) return;
        unwatch();
        try {
          const was = await instance();
          if (!r.force && was !== "absent" && was !== "empty" && !existsSync(tar)) {
            // An instance that cannot start leaves only the forced removal.
            await ensureUp(was).catch((e) => {
              throw was === "damaged" ? damaged() : forceable((e as Error).message);
            });
            const exists = await pod(["volume", "exists", VOLUME_HOME]);
            // 1 is "no such volume"; any other failure (125, timeout) must not pass for it.
            if (exists.code !== 0 && exists.code !== 1) throw forceable(hostSay("host-machine-export-failed", { detail: detail(exists) }));
            if (exists.code === 0) {
              await ownHome();
              const e = await pod(["volume", "export", VOLUME_HOME, "--output", `${tar}.part`], 10 * 60_000);
              if (e.code !== 0) throw forceable(hostSay("host-machine-export-failed", { detail: detail(e) }));
              await chmod(`${tar}.part`, 0o600); // Podman writes it 0644: it holds the logins
              await rename(`${tar}.part`, tar);
            }
          }
          // Before the delete: one cut short (quit) must not have the next AI on install it again.
          await ownHome();
          await writeFile(removedMark, "");
          if (was !== "absent") {
            const d = await lima(["delete", "--force", NAME]);
            if (d.code !== 0) throw new Error(hostSay("host-machine-remove-failed", { detail: detail(d) }));
          }
        } catch (e) {
          const left = await instance().catch(() => null);
          if (left && left !== "absent") await rm(removedMark, { force: true }); // known to be still there: not removed
          // Kept, maybe running: the idle rule stops it again.
          if (left === "Running") watch("user");
          throw e;
        }
        set(absent());
      }),
    /**
     * At quit: nothing more starts, and a detached script stops the machine after a short grace, so the stop completes
     * even once Firefox has killed the host. A change in flight (a start) is waited for, then stopped.
     */
    async close() {
      closed = true;
      unwatch();
      downloads?.abort();
      if (tooLong || !(await supported())) return;
      const inFlight = pending > 0 || status.kind === "starting";
      // The stop duty is this quit's: a script of an older launch, and this launch's crash watcher, stand down.
      const quit = `${token}-quit`;
      await claim(quit).catch(() => {});
      detach([QUIT_STOP, "ressac-vm-stop", limactl, NAME, String(o.quitGraceS ?? 3), inFlight ? "1" : "0", quit], { LIMA_HOME: home });
    },
    async usage(): Promise<{ memoryMB: number; diskMB: number } | null> {
      if (tooLong || (await instance().catch(() => "absent")) === "absent") return null;
      const diskKB = Number((await run("du", ["-sk", dir])).stdout.split(/\s/)[0]) || 0;
      // The vz process that holds the instance's disk open is the machine (plus Lima's own small host agent).
      const pids = (await run("lsof", ["-t", join(dir, "disk")])).stdout.split("\n").filter((p) => /^\d+$/.test(p));
      // footprint, as Activity Monitor shows it: the RSS counts the VM's guest memory about twice.
      const out = pids.length ? (await run("footprint", pids)).stdout : "";
      const UNIT: Record<string, number> = { B: 1 / 1024 ** 2, KB: 1 / 1024, MB: 1, GB: 1024 };
      const memoryMB = [...out.matchAll(/\[\d+\]:.*Footprint: ([\d.]+) (B|KB|MB|GB)/g)].reduce((n, m) => n + Number(m[1]) * UNIT[m[2]!]!, 0);
      return { memoryMB: Math.round(memoryMB), diskMB: Math.round(diskKB / 1024) };
    },
  } satisfies ContainerEngine & Record<string, unknown>;
}

/**
 * e2e (RESSAC_TEST_MACHINE): a fixed status, `<kind>[:<percent>|damaged|<detail>]`; its actions only note themselves in
 * `log`, and answer after `delayMs` (RESSAC_TEST_MACHINE_DELAY_MS). `absent:auto` installs at AI start (running after
 * `delayMs`); a retry on an error fails with its message, as the real one does. A removal leaves `<log>.removed`, as the real one
 * leaves its mark: absent and removed from then on (later launches included) until « Installer », which shows a download.
 */
export function fakeMachine(spec: string, log: string, delayMs = 0): ReturnType<typeof createMachine> {
  const [kind, extra] = spec.split(":") as [MachineStatus["kind"], string | undefined];
  const removedMark = `${log}.removed`;
  let status = (
    existsSync(removedMark) ? { kind: "absent", removed: true }
    : kind === "downloading" ? { kind, percent: extra ? Number(extra) : null }
    : kind === "error" ? (extra === "damaged" ? { kind, message: hostSay("host-machine-damaged"), forceRemovable: true } : { kind, message: hostSay("host-machine-start-failed", { detail: extra ?? "test" }) })
    : { kind }
  ) as MachineStatus;
  const note = async (line: string) => {
    await appendFile(log, `${line}\n`);
    await sleep(delayMs);
  };
  return {
    kind: "machine",
    // A path that cannot exist: no e2e ever reaches a real podman.
    binary: () => "/nonexistent/ressac-fake-podman",
    args: () => [],
    hostAddress: () => HOST_ADDRESS,
    up: async () => false,
    wake: async () => {},
    harvestable: async () => status.kind !== "absent",
    status: () => status,
    onStatus: () => () => {},
    install: async (r = {}) => {
      if (existsSync(removedMark)) {
        if (r.auto) throw new Error(hostSay("host-machine-removed"));
        await rm(removedMark, { force: true });
        status = { kind: "downloading", percent: null };
      } else if (r.auto && extra !== "auto") return; // the fake never downloads on its own, unless asked
      await note("install");
      if (status.kind === "error") throw new Error(status.message);
      if (r.auto) status = { kind: "running" };
    },
    stop: async () => {},
    memory: () => 2.5 * 2 ** 30,
    relieve: () => note("relieve"),
    cancel: async () => {},
    remove: async (r = {}) => {
      await note(r.force ? "remove --force" : "remove");
      await writeFile(removedMark, "");
      status = { kind: "absent", removed: true };
    },
    close: async () => {},
    usage: async () => (status.kind === "running" || status.kind === "stopped" ? { memoryMB: status.kind === "running" ? 614 : 0, diskMB: 1843 } : null),
  };
}
