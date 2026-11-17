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
  /** True when no session or app runs in Docker's workshop; « untouched » when only sessions nobody typed in run there. */
  workshopIdle: () => Promise<boolean | "untouched">;
  /** After a hand-over that cut sessions nobody typed in: they start again, in the machine. */
  relaunchSessions: () => Promise<void>;
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
  /** Set while the hand-over waits for Docker's workshop to idle; called, it stops waiting (« Passer maintenant »). */
  let waiting: (() => void) | undefined;
  let now = false;
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
  const current = (): ContainerEngine => {
    const s = o.machine.status();
    // A machine the user removed waits for their « Installer »: Docker serves meanwhile, where there is one.
    return !o.docker.binary() || (mark !== null && s.kind !== "unsupported" && !(s.kind === "absent" && s.removed)) ? o.machine : docker;
  };

  return {
    current,
    /** True while the machine is ready but waits for the sessions in Docker's workshop to end before it takes over. */
    waiting: () => !!waiting,
    /** Takes over at once: the sessions in Docker's workshop are cut. Resolves when the hand-over is done (or failed). */
    switchNow: async (): Promise<void> => {
      if (!waiting) return;
      now = true;
      const s = settling;
      waiting();
      await s;
    },
    /**
     * Called once the machine is installed. A failure to stop Docker's workshop or wake the machine leaves Docker serving
     * (tried again at the next AI wake or launch). A failed copy still hands over, the copy owed (Docker's volume stays
     * as it was); a later copy only fills what the machine's logins volume lacks (copyLogins).
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
        let idle: boolean | "untouched" = false;
        try {
          while (!now && !(idle = await o.workshopIdle())) await new Promise<void>((r) => ((waiting = r), setTimeout(r, o.idlePollMs ?? 30_000).unref()));
        } finally {
          waiting = undefined;
          now = false;
        }
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
        // Their panels showed nothing yet: they restart in the machine unseen. (« Passer maintenant » relaunches on its own.)
        if (idle === "untouched") await o.relaunchSessions();
      })().finally(() => {
        settling = undefined;
        switching = undefined;
      })),
  };
}

const PENDING = "pending";

/**
 * Run in the machine's workshop image (GNU tar) on its logins volume at /v, Docker's tar on stdin. The stream lands in a
 * staging folder first, so a copy cut short (quit, AI off) leaves nothing half-written among the logins; then only the
 * files the volume lacks are added: a login made on the machine is never overwritten. The volume's root is node's first:
 * this container may be the one that creates the volume (root 755), and --skip-old-files never applies the archive's `./`.
 * shortcut: a cut during the second, local tar (well under a second) can still leave one file short; staged renames if it shows.
 */
export const LOGINS_EXTRACT = `chown node:node /v && S=/v/.ressac-incoming && rm -rf "$S" && mkdir "$S" && tar -C "$S" -xf - && tar -C "$S" -cf - . | tar -C /v --skip-old-files -xf - && rm -rf "$S"`;

/**
 * `docker run … tar -cf -` of the logins volume (read-only) piped into the machine's same volume (LOGINS_EXTRACT).
 * Copies nothing when Docker has no such volume. Both sides must succeed.
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
  const signal = AbortSignal.timeout(o.timeoutMs ?? 10 * 60_000);
  const from = spawn(o.docker, ["run", "--rm", "--pull", "never", "--network", "none", "-u", "root", "-v", `${VOLUME_HOME}:/v:ro`, IMAGE, "tar", "-C", "/v", "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"], signal });
  const to = spawn(o.podman, [...o.podmanArgs, "run", "--rm", "-i", "--pull", "never", "--network", "none", "-u", "root", "-v", `${VOLUME_HOME}:/v`, IMAGE, "sh", "-c", LOGINS_EXTRACT], { stdio: ["pipe", "ignore", "pipe"], signal });
  to.stdin.on("error", () => {}); // a podman that dies early: its exit code tells
  from.stdout.pipe(to.stdin);
  let err = "";
  for (const p of [from, to]) p.stderr.on("data", (d) => (err += d));
  const exit = (p: typeof from | typeof to) => new Promise<number | null>((ok) => p.on("close", ok).on("error", () => ok(-1)));
  const [a, b] = await Promise.all([exit(from), exit(to)]);
  if (a !== 0 || b !== 0) throw new Error(`logins copy failed (docker ${a}, podman ${b}): ${err.trim().split("\n").at(-1) ?? ""}`);
}
