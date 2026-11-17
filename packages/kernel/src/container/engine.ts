import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRunner, type Runner } from "./runner.js";

export type WakeReason = "user" | "harvest";

/** What runs the workshop's container commands: Docker, or the Podman of the machine Ressac ships. */
export interface ContainerEngine {
  readonly kind: "machine" | "docker";
  /** Absolute CLI path (podman or docker), null when not found. */
  binary(): string | null;
  /** Put before every argument list: `["--url", "unix://…"]` for the machine, `[]` for docker. */
  args(): string[];
  /** Value for `--add-host host.docker.internal:<it>`. */
  hostAddress(): string;
  /** True when commands can run now; never starts anything. */
  up(): Promise<boolean>;
  /** Starts what is needed (machine boot, Docker app); throws a localized Error when it cannot. */
  wake(reason: WakeReason): Promise<void>;
  /** False when `wake("harvest")` would be refused (Ressac's machine removed or failing); absent means true. */
  harvestable?(): Promise<boolean>;
}

/** Looks for the docker CLI in the PATH then at known locations (Finder does not have the shell's PATH). */
export function findDocker(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const candidates = [
    ...(env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "docker")),
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    ...(env.HOME ? [join(env.HOME, ".orbstack", "bin", "docker"), join(env.HOME, ".docker", "bin", "docker")] : []),
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  return candidates.find((c) => exists(c)) ?? null;
}

/** `docker info` must not block if Docker Desktop is stuck at startup. */
const INFO_DELAY_MS = 30_000;

/** `find` runs again while nothing is found: Docker installed after the app started is found without a restart. */
export function dockerEngine(o: { find?: () => string | null; run?: Runner } = {}): ContainerEngine {
  let found: string | null = null;
  const binary = () => (found ??= (o.find ?? findDocker)());
  const run = o.run ?? createRunner();
  return {
    kind: "docker",
    binary,
    args: () => [],
    hostAddress: () => "host-gateway",
    up: async () => {
      const b = binary();
      return b !== null && (await run(b, ["info"], { delayMs: INFO_DELAY_MS })).code === 0;
    },
    wake: async () => {},
  };
}
