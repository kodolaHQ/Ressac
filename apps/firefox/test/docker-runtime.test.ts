import { describe, expect, it } from "vitest";
import { DOCKER_NOT_STARTED, createDockerRuntime } from "../host/docker-runtime";

const ORB = "/Applications/OrbStack.app";
function machine(o: { running?: boolean; paths?: string[]; managed?: boolean; startsAfterOpen?: boolean }) {
  const state = { running: o.running ?? false, ran: [] as string[] };
  const runtime = createDockerRuntime({
    running: async () => state.running,
    managed: o.managed ?? true,
    exists: (p) => (o.paths ?? []).includes(p),
    run: async (cmd, args) => (state.ran.push([cmd, ...args].join(" ")), o.startsAfterOpen !== false && (state.running = true), 0),
    pollMs: 1,
    startDelayMs: 30,
  });
  return { runtime, state };
}

describe("the Docker runtime", () => {
  it("status: ready, stopped with the app's name, absent, unmanaged under tests", async () => {
    expect(await machine({ running: true }).runtime.status()).toEqual({ kind: "ready" });
    expect(await machine({ paths: [ORB] }).runtime.status()).toEqual({ kind: "stopped", app: "OrbStack" });
    expect(await machine({ paths: ["/Applications/Docker.app"] }).runtime.status()).toEqual({ kind: "stopped", app: "Docker Desktop" });
    expect(await machine({}).runtime.status()).toEqual({ kind: "absent" });
    expect(await machine({ running: true, managed: false }).runtime.status()).toEqual({ kind: "unmanaged" });
  });

  it("start opens the installed app and waits for the daemon; nothing when it already runs", async () => {
    const stopped = machine({ paths: [ORB] });
    await stopped.runtime.start();
    expect(stopped.state.ran).toEqual([`open -ga ${ORB}`]);
    const running = machine({ running: true, paths: [ORB] });
    await running.runtime.start();
    expect(running.state.ran).toEqual([]);
  });

  it("start fails when no app is installed, or when the daemon never answers", async () => {
    await expect(machine({}).runtime.start()).rejects.toThrow(DOCKER_NOT_STARTED());
    await expect(machine({ paths: [ORB], startsAfterOpen: false }).runtime.start()).rejects.toThrow(DOCKER_NOT_STARTED());
  });
});
