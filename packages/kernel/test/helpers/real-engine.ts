import { dockerEngine, type ContainerEngine } from "../../src/container/engine.js";

/**
 * The engine of the hand-run integration tests: Docker by default; with RESSAC_REAL_ENGINE=machine, the Podman of an
 * already running Ressac machine (RESSAC_PODMAN: the client, RESSAC_PODMAN_URL: `unix://<instance>/sock/podman.sock`),
 * as apps/firefox/scripts/vm/security-check.sh starts it.
 */
export function realEngine(): ContainerEngine {
  if (process.env.RESSAC_REAL_ENGINE !== "machine") return dockerEngine();
  const podman = process.env.RESSAC_PODMAN;
  const url = process.env.RESSAC_PODMAN_URL;
  if (!podman || !url) throw new Error("RESSAC_REAL_ENGINE=machine needs RESSAC_PODMAN and RESSAC_PODMAN_URL");
  return { kind: "machine", binary: () => podman, args: () => ["--url", url], hostAddress: () => "192.168.5.2", up: async () => true, wake: async () => {} };
}

/** `[cli, ...args]` for that engine. */
export const engineCli = (e: ContainerEngine, args: string[]): [string, string[]] => [e.binary()!, [...e.args(), ...args]];
