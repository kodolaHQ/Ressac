import { defaultRunner, type RunResult } from "../container/runner.js";
import type { Ctx } from "./json.js";

/** Runs `docker <args>`; injected by the tests, which never call the real Docker. */
export type DockerRunner = (args: string[]) => Promise<RunResult>;

export const defaultDocker: DockerRunner = (args) => defaultRunner("docker", args, { delayMs: 60_000 });

const NOT_FOUND = /no such (container|image|object)/i;

/**
 * The old workshop containers and image (the new ones are made at start). The `webaios-home` volume (the agent's
 * login and conversations) is never touched. Docker absent: nothing to clean; any other failure goes to the report.
 */
export async function migrateDocker(ctx: Ctx, docker: DockerRunner): Promise<void> {
  const steps: [string[], string[]][] = [
    [["container", "inspect", "webaios-atelier-firefox"], ["rm", "-f", "webaios-atelier-firefox"]],
    [["container", "inspect", "webaios-atelier"], ["rm", "-f", "webaios-atelier"]],
    [["image", "inspect", "webaios-atelier:1"], ["rmi", "webaios-atelier:1"]],
  ];
  for (const [probe, remove] of steps) {
    const p = await docker(probe);
    if (p.code === 127) return;
    if (p.code !== 0) {
      if (!NOT_FOUND.test(p.stderr)) ctx.dockerErrors.push(`docker ${probe.join(" ")} : ${p.stderr.trim().slice(0, 200)}`);
      continue;
    }
    const r = await docker(remove);
    if (r.code !== 0) ctx.dockerErrors.push(`docker ${remove.join(" ")} : ${r.stderr.trim().slice(0, 200)}`);
  }
}
