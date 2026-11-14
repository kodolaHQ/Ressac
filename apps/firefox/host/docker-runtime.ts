import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { DockerStatus } from "../shared/settings.ts";
import { hostSay } from "./locale.ts";

/** The container apps Ressac knows how to start, in order of preference. */
const APPS = [
  { name: "OrbStack", path: "/Applications/OrbStack.app" },
  { name: "Docker Desktop", path: "/Applications/Docker.app" },
];
export const DOCKER_NOT_STARTED = () => hostSay("host-docker-not-started");

export interface DockerRuntimeOptions {
  /** True when the docker daemon answers. */
  running: () => Promise<boolean>;
  /** False under tests: Ressac then starts nothing. */
  managed: boolean;
  exists?: (path: string) => boolean;
  run?: (cmd: string, args: string[]) => Promise<number>;
  startDelayMs?: number;
  pollMs?: number;
}

/** Tells whether Docker runs, is installed but stopped, or is missing, and starts the installed app. Never stops it. */
export function createDockerRuntime(o: DockerRuntimeOptions) {
  const exists = o.exists ?? existsSync;
  const run = o.run ?? ((cmd, args) => new Promise<number>((ok) => execFile(cmd, args, (e) => ok(e ? 1 : 0))));
  let starting: Promise<void> | undefined;
  const installed = () => APPS.find((a) => exists(a.path));

  async function status(): Promise<DockerStatus> {
    if (!o.managed) return { kind: "unmanaged" };
    if (await o.running()) return { kind: "ready" };
    const app = installed();
    return app ? { kind: "stopped", app: app.name } : { kind: "absent" };
  }

  /** Opens the installed app in the background and waits for the daemon (its virtual machine takes a few seconds). */
  function start(): Promise<void> {
    starting ??= (async () => {
      if (!o.managed || (await o.running())) return;
      const app = installed();
      if (!app) throw new Error(DOCKER_NOT_STARTED());
      await run("open", ["-ga", app.path]);
      for (const end = Date.now() + (o.startDelayMs ?? 60_000); Date.now() < end; ) {
        if (await o.running()) return;
        await new Promise((r) => setTimeout(r, o.pollMs ?? 1000));
      }
      throw new Error(DOCKER_NOT_STARTED());
    })().finally(() => (starting = undefined));
    return starting;
  }

  return { status, start };
}

export type DockerRuntime = ReturnType<typeof createDockerRuntime>;
