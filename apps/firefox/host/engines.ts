import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IMAGE, VOLUME_HOME, createRunner, type ContainerEngine, type Runner } from "../../../packages/kernel/src/index.ts";
import type { MachineStatus } from "./machine.ts";

type Machine = ContainerEngine & { status(): MachineStatus };

/**
 * Which engine runs the workshop: Ressac's machine once the logins came over from Docker (or could not), Docker before
 * that, and for good where the machine cannot run. Once the machine serves, its states (starting, error…) show: it no
 * longer falls back to Docker.
 */
export function createEngines(o: {
  machine: Machine;
  docker: ContainerEngine & { start(): Promise<void> };
  /** True when no session or app runs in Docker's workshop. */
  workshopIdle: () => Promise<boolean>;
  /** Stops Docker's workshop container (never removes it, its image or the logins volume): it holds the apps' ports. */
  stopDocker: () => Promise<void>;
  copyLogins: () => Promise<void>;
  /**
   * Written once the machine serves: empty once the logins came over (or Docker had none), `pending` while the copy is
   * owed (Docker silent, a copy that failed or was cut): tried again at a later launch, once Docker answers on its own.
   */
  marker: string;
  idlePollMs?: number;
}) {
  const read = () => {
    try {
      return readFileSync(o.marker, "utf8");
    } catch {
      return null;
    }
  };
  let mark = read();
  let settling: Promise<void> | undefined;
  /** From the idle check to the hand-over: Docker's workshop must not start again meanwhile. */
  let switching: Promise<void> | undefined;
  const handOver = async (copied: boolean) => {
    mark = copied ? "" : PENDING;
    await mkdir(dirname(o.marker), { recursive: true });
    await writeFile(o.marker, mark);
  };
  const docker: ContainerEngine = {
    ...o.docker,
    // A start asked during the switch waits for it, then goes to whichever engine serves.
    wake: async (reason) => {
      while (switching) await switching.catch(() => {});
      const e = current();
      return e === docker ? o.docker.wake(reason) : e.wake(reason);
    },
  };
  const current = (): ContainerEngine => (!o.docker.binary() || (mark !== null && o.machine.status().kind !== "unsupported") ? o.machine : docker);

  return {
    current,
    /**
     * Called once the machine is installed. A failure to stop Docker's workshop or wake the machine leaves Docker serving
     * (tried again at the next AI wake or launch). A failed copy still hands over, the copy owed (Docker's volume stays
     * as it was); a later copy never overwrites a whole logins volume on the machine (copyLogins).
     */
    settle: (): Promise<void> =>
      (settling ??= (async () => {
        if (mark === "") return;
        if (!o.docker.binary()) return handOver(true); // never had Docker: nothing to copy
        if (mark === PENDING) {
          if (!(await o.docker.up())) return; // never started for it: the user may have left Docker for good
          await o.machine.wake("user");
          await o.copyLogins();
          return handOver(true);
        }
        if (!(await o.docker.up())) await o.docker.start().catch(() => {});
        if (!(await o.docker.up())) return handOver(false); // Docker cannot serve either: the machine takes over, the copy waits
        while (!(await o.workshopIdle())) await new Promise((r) => setTimeout(r, o.idlePollMs ?? 30_000).unref());
        // shortcut: a session opened between the last idle check and here is cut by the stop; a lock on session open if it shows.
        switching = (async () => {
          await o.stopDocker();
          await o.machine.wake("user");
          let copied = false;
          try {
            await o.copyLogins();
            copied = true;
          } finally {
            await handOver(copied);
          }
        })();
        await switching;
      })().finally(() => {
        settling = undefined;
        switching = undefined;
      })),
  };
}

const PENDING = "pending";

/** In the machine's logins volume while a copy runs: a copy cut short (quit) is done again at the next launch. */
const COPYING = "/v/.ressac-copying";

/**
 * `docker run … tar -cf -` of the logins volume (read-only) piped into the machine's same volume. Copies nothing when
 * Docker has no such volume, or the machine already has a whole one (never overwritten). Both sides must succeed.
 */
export async function copyLogins(o: { docker: string; podman: string; podmanArgs: string[]; timeoutMs?: number; run?: Runner }): Promise<void> {
  const run = o.run ?? createRunner();
  const exec = (cmd: string, args: string[]) => run(cmd, args, { delayMs: 60_000 });
  const fail = (what: string, r: { code: number | null; stderr: string }) => new Error(`logins copy failed (${what} ${r.code}): ${r.stderr.trim().split("\n").at(-1) ?? ""}`);
  const source = await exec(o.docker, ["volume", "inspect", VOLUME_HOME]);
  if (source.code !== 0) {
    if (/no such volume/i.test(source.stderr)) return;
    throw fail("docker volume inspect", source);
  }
  const target = await exec(o.podman, [...o.podmanArgs, "volume", "exists", VOLUME_HOME]);
  if (target.code !== 0 && target.code !== 1) throw fail("podman volume exists", target); // 1 is "no such volume"
  if (target.code === 0) {
    const cut = await exec(o.podman, [...o.podmanArgs, "run", "--rm", "--pull", "never", "--network", "none", "-u", "root", "-v", `${VOLUME_HOME}:/v:ro`, IMAGE, "test", "-e", COPYING]);
    if (cut.code === 1) return;
    if (cut.code !== 0) throw fail("podman copy check", cut);
  }
  const signal = AbortSignal.timeout(o.timeoutMs ?? 10 * 60_000);
  const from = spawn(o.docker, ["run", "--rm", "--pull", "never", "--network", "none", "-u", "root", "-v", `${VOLUME_HOME}:/v:ro`, IMAGE, "tar", "-C", "/v", "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"], signal });
  const to = spawn(o.podman, [...o.podmanArgs, "run", "--rm", "-i", "--pull", "never", "--network", "none", "-u", "root", "-v", `${VOLUME_HOME}:/v`, IMAGE, "sh", "-c", `touch ${COPYING} && tar -C /v -xf - && rm ${COPYING}`], { stdio: ["pipe", "ignore", "pipe"], signal });
  to.stdin.on("error", () => {}); // a podman that dies early: its exit code tells
  from.stdout.pipe(to.stdin);
  let err = "";
  for (const p of [from, to]) p.stderr.on("data", (d) => (err += d));
  const exit = (p: typeof from | typeof to) => new Promise<number | null>((ok) => p.on("close", ok).on("error", () => ok(-1)));
  const [a, b] = await Promise.all([exit(from), exit(to)]);
  if (a !== 0 || b !== 0) throw new Error(`logins copy failed (docker ${a}, podman ${b}): ${err.trim().split("\n").at(-1) ?? ""}`);
}
