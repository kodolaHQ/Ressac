import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IMAGE, VOLUME_HOME, type ContainerEngine } from "../../../packages/kernel/src/index.ts";
import type { MachineStatus } from "./machine.ts";

type Machine = ContainerEngine & { status(): MachineStatus };

/**
 * Which engine runs the workshop: Ressac's machine once it is installed and the logins came over from Docker, Docker
 * meanwhile (or for good when the machine cannot run here).
 */
export function createEngines(o: {
  machine: Machine;
  docker: ContainerEngine & { start(): Promise<void> };
  /** True when no session or app runs in Docker's workshop. */
  workshopIdle: () => Promise<boolean>;
  /** Stops Docker's workshop container (never removes it, its image or the logins volume): it holds the apps' ports. */
  stopDocker: () => Promise<void>;
  copyLogins: () => Promise<void>;
  /** Written once the logins are over (or there was no Docker to copy from). */
  marker: string;
  idlePollMs?: number;
}) {
  let settled = existsSync(o.marker);
  let settling: Promise<void> | undefined;
  const ready = () => ["running", "stopped"].includes(o.machine.status().kind);
  const done = async () => {
    await mkdir(dirname(o.marker), { recursive: true });
    await writeFile(o.marker, "");
  };

  return {
    current: (): ContainerEngine => (ready() && settled) || !o.docker.binary() ? o.machine : o.docker,
    /** Called once the machine is installed. A failure leaves no marker (tried again at the next launch); the machine serves anyway. */
    settle: (): Promise<void> =>
      (settling ??= (async () => {
        if (settled) return;
        try {
          if (!o.docker.binary()) return await done(); // never had Docker: nothing to copy
          if (!(await o.docker.up())) await o.docker.start().catch(() => {});
          if (!(await o.docker.up())) return;
          // shortcut: a session opened between the last idle check and the stop is cut; a lock on session open if it shows.
          while (!(await o.workshopIdle())) await new Promise((r) => setTimeout(r, o.idlePollMs ?? 30_000).unref());
          await o.stopDocker();
          await o.machine.wake("user");
          await o.copyLogins();
          await done();
        } finally {
          settled = true;
          settling = undefined;
        }
      })()),
  };
}

/** `docker run … tar -cf -` of the logins volume piped into the machine's same volume. Both sides must succeed. */
export async function copyLogins(o: { docker: string; podman: string; podmanArgs: string[]; timeoutMs?: number }): Promise<void> {
  const exists = await new Promise<number | null>((ok) => spawn(o.docker, ["volume", "inspect", VOLUME_HOME], { stdio: "ignore" }).on("close", ok).on("error", () => ok(-1)));
  if (exists !== 0) return; // no logins in Docker
  const signal = AbortSignal.timeout(o.timeoutMs ?? 10 * 60_000);
  const from = spawn(o.docker, ["run", "--rm", "--pull", "never", "--network", "none", "-u", "root", "-v", `${VOLUME_HOME}:/v`, IMAGE, "tar", "-C", "/v", "-cf", "-", "."], { stdio: ["ignore", "pipe", "pipe"], signal });
  const to = spawn(o.podman, [...o.podmanArgs, "run", "--rm", "-i", "--pull", "never", "--network", "none", "-u", "root", "-v", `${VOLUME_HOME}:/v`, IMAGE, "tar", "-C", "/v", "-xf", "-"], { stdio: ["pipe", "ignore", "pipe"], signal });
  to.stdin.on("error", () => {}); // a podman that dies early: its exit code tells
  from.stdout.pipe(to.stdin);
  let err = "";
  for (const p of [from, to]) p.stderr.on("data", (d) => (err += d));
  const exit = (p: typeof from | typeof to) => new Promise<number | null>((ok) => p.on("close", ok).on("error", () => ok(-1)));
  const [a, b] = await Promise.all([exit(from), exit(to)]);
  if (a !== 0 || b !== 0) throw new Error(`logins copy failed (docker ${a}, podman ${b}): ${err.trim().split("\n").at(-1) ?? ""}`);
}
