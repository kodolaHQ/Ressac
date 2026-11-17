import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainerEngine } from "../../../packages/kernel/src/index.ts";
import { copyLogins, createEngines } from "../host/engines";
import type { MachineStatus } from "../host/machine";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "engines-"));
  dirs.push(d);
  return d;
};

function world(o: { status?: MachineStatus["kind"]; docker?: boolean; dockerUp?: boolean; idle?: boolean[]; marker?: boolean; stopFails?: boolean; copyFails?: boolean } = {}) {
  const log: string[] = [];
  let status = { kind: o.status ?? "running" } as MachineStatus;
  let releaseCopy: () => void = () => {};
  const copyGate = { wait: false };
  const machine = {
    kind: "machine" as const,
    binary: () => "podman",
    args: () => [],
    hostAddress: () => "192.168.5.2",
    up: async () => true,
    wake: async (r: string) => void log.push(`machine wake ${r}`),
    status: () => status,
  };
  const docker: ContainerEngine & { start(): Promise<void> } = {
    kind: "docker",
    binary: () => (o.docker === false ? null : "docker"),
    args: () => [],
    hostAddress: () => "host-gateway",
    up: async () => o.docker !== false && o.dockerUp !== false,
    wake: async (r) => void log.push(`docker wake ${r}`),
    start: async () => void log.push("docker start"),
  };
  const idle = [...(o.idle ?? [true])];
  const marker = join(tmp(), "logins-copied");
  if (o.marker) writeFileSync(marker, "");
  const engines = createEngines({
    machine,
    docker,
    workshopIdle: async () => {
      const v = idle.length > 1 ? idle.shift()! : idle[0]!;
      log.push(`idle ${v}`);
      return v;
    },
    stopDocker: async () => {
      log.push("docker stop");
      if (o.stopFails) throw new Error("stop failed");
    },
    copyLogins: async () => {
      log.push("copy");
      if (copyGate.wait) await new Promise<void>((r) => (releaseCopy = r));
      if (o.copyFails) throw new Error("tar failed");
    },
    marker,
    idlePollMs: 1,
  });
  return { engines, machine, log, marker, copyGate, release: () => releaseCopy(), setStatus: (k: MachineStatus["kind"]) => (status = { kind: k } as MachineStatus) };
}
const kind = (w: ReturnType<typeof world>) => w.engines.current().kind;

describe("choosing the engine", () => {
  it("machine ready wins over Docker", async () => {
    for (const k of ["running", "stopped"] as const) expect(kind(world({ status: k, marker: true }))).toBe("machine");
  });

  it("machine downloading: Docker serves", () => {
    const w = world({ status: "downloading" });
    expect(kind(w)).toBe("docker");
    w.setStatus("running");
    expect(kind(w)).toBe("docker"); // ready, but the logins are not over yet
  });

  it("unsupported machine: Docker serves", () => {
    expect(kind(world({ status: "unsupported", marker: true }))).toBe("docker");
  });

  it("once settled, the machine serves whatever its state (its state shows)", () => {
    for (const k of ["starting", "downloading", "error", "absent"] as const) expect(kind(world({ status: k, marker: true }))).toBe("machine");
  });

  it("no Docker at all: the machine, so its states show", () => {
    expect(kind(world({ status: "downloading", docker: false }))).toBe("machine");
  });

  it("switch waits for idle", async () => {
    const w = world({ idle: [false, false, true] });
    await w.engines.settle();
    expect(w.log).toEqual(["idle false", "idle false", "idle true", "docker stop", "machine wake user", "copy"]);
    expect(existsSync(w.marker)).toBe(true);
    expect(kind(w)).toBe("machine");
  });

  it("logins copied once", async () => {
    const w = world({ marker: true });
    await w.engines.settle();
    expect(w.log).toEqual([]);
  });

  it("no Docker: no copy, machine directly", async () => {
    const w = world({ docker: false });
    await w.engines.settle();
    expect(w.log).toEqual([]);
    expect(existsSync(w.marker)).toBe(true);
  });

  it("Docker installed but not answering: started once; still silent, the machine takes over (no copy later)", async () => {
    const w = world({ dockerUp: false });
    await w.engines.settle();
    expect(w.log).toEqual(["docker start"]);
    expect(existsSync(w.marker)).toBe(true);
    expect(kind(w)).toBe("machine");
  });

  it("a failed Docker stop leaves Docker serving and no marker; the next settle tries again", async () => {
    const w = world({ stopFails: true });
    await expect(w.engines.settle()).rejects.toThrow("stop failed");
    expect(existsSync(w.marker)).toBe(false);
    expect(kind(w)).toBe("docker");
    expect(w.log).not.toContain("copy");
    await expect(w.engines.settle()).rejects.toThrow("stop failed");
    expect(w.log.filter((l) => l === "docker stop")).toHaveLength(2);
  });

  it("a failed copy still hands over: the marker keeps a later copy off the machine's logins", async () => {
    const w = world({ copyFails: true });
    await expect(w.engines.settle()).rejects.toThrow("tar failed");
    expect(existsSync(w.marker)).toBe(true);
    expect(kind(w)).toBe("machine");
  });

  it("a start asked during the switch waits for it, then goes to the machine", async () => {
    const w = world();
    w.copyGate.wait = true;
    const settled = w.engines.settle();
    await until(() => w.log.includes("copy"));
    expect(kind(w)).toBe("docker");
    let woken = false;
    const wake = w.engines.current().wake("user").then(() => (woken = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(woken).toBe(false);
    w.release();
    await settled;
    await wake;
    expect(w.log).not.toContain("docker wake user");
    expect(w.log.at(-1)).toBe("machine wake user");
  });
});

const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f()).toBe(true);
};

describe("copyLogins", () => {
  /** A fake CLI: logs its arguments, runs `body` (sh). */
  const tool = (dir: string, name: string, body: string) => {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/sh\necho "$*" >> ${join(dir, `${name}.log`)}\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };

  it("pipes the Docker volume's tar (read-only) into the machine's new volume", async () => {
    const d = tmp();
    const docker = tool(d, "docker", `case "$1" in run) printf 'LOGINS';; esac`);
    const podman = tool(d, "podman", `case "$3" in volume) exit 1;; esac; cat > ${join(d, "received")}`);
    await copyLogins({ docker, podman, podmanArgs: ["--url", "unix:///s"] });
    expect(readFileSync(join(d, "received"), "utf8")).toBe("LOGINS");
    expect(readFileSync(join(d, "docker.log"), "utf8")).toBe(
      "volume inspect webaios-home\nrun --rm --pull never --network none -u root -v webaios-home:/v:ro ressac-workshop:1 tar -C /v -cf - .\n",
    );
    expect(readFileSync(join(d, "podman.log"), "utf8")).toBe(
      "--url unix:///s volume exists webaios-home\n--url unix:///s run --rm -i --pull never --network none -u root -v webaios-home:/v ressac-workshop:1 tar -C /v -xf -\n",
    );
  });

  it("no Docker volume: nothing to copy", async () => {
    const d = tmp();
    const docker = tool(d, "docker", `[ "$1" = volume ] && { echo "Error: No such volume: webaios-home" >&2; exit 1; }`);
    const podman = tool(d, "podman", "");
    await copyLogins({ docker, podman, podmanArgs: [] });
    expect(existsSync(join(d, "podman.log"))).toBe(false);
  });

  it("Docker failing to answer is not an absent volume: rejects", async () => {
    const d = tmp();
    const docker = tool(d, "docker", `[ "$1" = volume ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }`);
    await expect(copyLogins({ docker, podman: tool(d, "podman", ""), podmanArgs: [] })).rejects.toThrow("Cannot connect");
  });

  it("the machine already has a logins volume: never overwritten", async () => {
    const d = tmp();
    const docker = tool(d, "docker", "");
    const podman = tool(d, "podman", "");
    await copyLogins({ docker, podman, podmanArgs: [] });
    expect(readFileSync(join(d, "podman.log"), "utf8")).toBe("volume exists webaios-home\n");
    expect(readFileSync(join(d, "docker.log"), "utf8")).toBe("volume inspect webaios-home\n");
  });

  it("either side failing rejects", async () => {
    for (const [dockerBody, podmanBody] of [
      [`case "$1" in run) exit 3;; esac`, `case "$1" in volume) exit 1;; esac; cat >/dev/null`],
      ["", `case "$1" in volume) exit 1;; esac; cat >/dev/null; exit 4`],
    ]) {
      const d = tmp();
      await expect(copyLogins({ docker: tool(d, "docker", dockerBody!), podman: tool(d, "podman", podmanBody!), podmanArgs: [] })).rejects.toThrow();
    }
  });
});
