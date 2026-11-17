import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IMAGE, VOLUME_HOME, type ContainerEngine } from "../../../packages/kernel/src/index.ts";
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
  /** Written once the machine serves: its logins are never overwritten by a later copy. */
  marker: string;
  idlePollMs?: number;
}) {
  let settled = existsSync(o.marker);
  let settling: Promise<void> | undefined;
  /** From the idle check to the hand-over: Docker's workshop must not start again meanwhile. */
  let switching: Promise<void> | undefined;
  const handOver = async () => {
    await mkdir(dirname(o.marker), { recursive: true });
    await writeFile(o.marker, "");
    settled = true;
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
  const current = (): ContainerEngine => (!o.docker.binary() || (settled && o.machine.status().kind !== "unsupported") ? o.machine : docker);

  return {
    current,
    /**
     * Called once the machine is installed. A failure to stop Docker's workshop or wake the machine leaves Docker serving
     * (tried again at the next AI wake or launch); a failed copy still hands over (Docker's volume stays as it was).
     */
    settle: (): Promise<void> =>
      (settling ??= (async () => {
        if (settled) return;
        if (!o.docker.binary()) return handOver(); // never had Docker: nothing to copy
        if (!(await o.docker.up())) await o.docker.start().catch(() => {});
        if (!(await o.docker.up())) return handOver(); // Docker cannot serve either: the logins are signed in again
        while (!(await o.workshopIdle())) await new Promise((r) => setTimeout(r, o.idlePollMs ?? 30_000).unref());
        // shortcut: a session opened between the last idle check and here is cut by the stop; a lock on session open if it shows.
        switching = (async () => {
          await o.stopDocker();
          await o.machine.wake("user");
          try {
            await o.copyLogins();
          } finally {
            await handOver();
          }
        })();
        await switching;
      })().finally(() => {
        settling = undefined;
        switching = undefined;
      })),
  };
}

const exec = (cmd: string, args: string[]) =>
  new Promise<{ code: number | null; stderr: string }>((ok) => {
    let stderr = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => ok({ code, stderr })).on("error", (e) => ok({ code: -1, stderr: e.message }));
  });

/**
 * `docker run … tar -cf -` of the logins volume (read-only) piped into the machine's same volume. Copies nothing when
 * Docker has no such volume, or the machine already has one (never overwritten). Both sides must succeed.
 */
export async function copyLogins(o: { docker: string; podman: string; podmanArgs: string[]; timeoutMs?: number }): Promise<void> {
  const fail = (what: string, r: { code: number | null; stderr: string }) => new Error(`logins copy failed (${what} ${r.code}): ${r.stderr.trim().split("\n").at(-1) ?? ""}`);
  const source = await exec(o.docker, ["volume", "inspect", VOLUME_HOME]);
  if (source.code !== 0) {
    if (/no such volume/i.test(source.stderr)) return;
    throw fail("docker volume inspect", source);
  }
  const target = await exec(o.podman, [...o.podmanArgs, "volume", "exists", VOLUME_HOME]);
  if (target.code === 0) return;
  if (target.code !== 1) throw fail("podman volume exists", target); // 1 is "no such volume"
  const signal = AbortSignal.timeout(o.timeoutMs ?? 10 * 60_000);
  const from = spawn(o.docker, ["run", "--rm", "--pull", "never", "--network", "none", "-u", "root", "-v", `${VOLUME_HOME}:/v:ro`, IMAGE, "tar", "-C", "/v", "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"], signal });
  const to = spawn(o.podman, [...o.podmanArgs, "run", "--rm", "-i", "--pull", "never", "--network", "none", "-u", "root", "-v", `${VOLUME_HOME}:/v`, IMAGE, "tar", "-C", "/v", "-xf", "-"], { stdio: ["pipe", "ignore", "pipe"], signal });
  to.stdin.on("error", () => {}); // a podman that dies early: its exit code tells
  from.stdout.pipe(to.stdin);
  let err = "";
  for (const p of [from, to]) p.stderr.on("data", (d) => (err += d));
  const exit = (p: typeof from | typeof to) => new Promise<number | null>((ok) => p.on("close", ok).on("error", () => ok(-1)));
  const [a, b] = await Promise.all([exit(from), exit(to)]);
  if (a !== 0 || b !== 0) throw new Error(`logins copy failed (docker ${a}, podman ${b}): ${err.trim().split("\n").at(-1) ?? ""}`);
}
