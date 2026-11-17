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

function world(o: { status?: MachineStatus["kind"]; docker?: boolean; dockerUp?: boolean; idle?: boolean[]; marker?: boolean } = {}) {
  const log: string[] = [];
  let status = { kind: o.status ?? "running" } as MachineStatus;
  const machine = {
    kind: "machine" as const,
    binary: () => "podman",
    args: () => [],
    hostAddress: () => "192.168.5.2",
    up: async () => true,
    wake: async () => void log.push("machine wake"),
    status: () => status,
  };
  const docker: ContainerEngine & { start(): Promise<void> } = {
    kind: "docker",
    binary: () => (o.docker === false ? null : "docker"),
    args: () => [],
    hostAddress: () => "host-gateway",
    up: async () => o.docker !== false && o.dockerUp !== false,
    wake: async () => {},
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
    stopDocker: async () => void log.push("docker stop"),
    copyLogins: async () => void log.push("copy"),
    marker,
    idlePollMs: 1,
  });
  return { engines, machine, docker, log, marker, setStatus: (k: MachineStatus["kind"]) => (status = { kind: k } as MachineStatus) };
}

describe("choosing the engine", () => {
  it("machine ready wins over Docker", async () => {
    for (const k of ["running", "stopped"] as const) {
      const w = world({ status: k, marker: true });
      expect(w.engines.current()).toBe(w.machine);
    }
  });

  it("machine downloading: Docker serves", () => {
    const w = world({ status: "downloading", marker: true });
    expect(w.engines.current()).toBe(w.docker);
    w.setStatus("running");
    expect(w.engines.current()).toBe(w.machine);
  });

  it("unsupported machine: Docker serves", () => {
    for (const k of ["unsupported", "error", "absent", "starting"] as const) {
      const w = world({ status: k, marker: true });
      expect(w.engines.current()).toBe(w.docker);
    }
  });

  it("neither ready: the machine, so its states show", () => {
    const w = world({ status: "downloading", docker: false });
    expect(w.engines.current()).toBe(w.machine);
  });

  it("switch waits for idle", async () => {
    const w = world({ idle: [false, false, true] });
    expect(w.engines.current()).toBe(w.docker); // ready, but the logins are not over yet
    await w.engines.settle();
    expect(w.log).toEqual(["idle false", "idle false", "idle true", "docker stop", "machine wake", "copy"]);
    expect(existsSync(w.marker)).toBe(true);
    expect(w.engines.current()).toBe(w.machine);
  });

  it("logins copied once", async () => {
    const w = world({ marker: true });
    expect(w.engines.current()).toBe(w.machine);
    await w.engines.settle();
    expect(w.log).toEqual([]);
  });

  it("no Docker: no copy, machine directly", async () => {
    const w = world({ docker: false });
    expect(w.engines.current()).toBe(w.machine);
    await w.engines.settle();
    expect(w.log).toEqual([]);
    expect(existsSync(w.marker)).toBe(true);
  });

  it("Docker installed but not answering: started for the copy; still silent, the machine serves without a marker", async () => {
    const w = world({ dockerUp: false });
    await w.engines.settle();
    expect(w.log).toEqual(["docker start"]);
    expect(existsSync(w.marker)).toBe(false); // tried again at the next launch
    expect(w.engines.current()).toBe(w.machine);
  });

  it("a failed copy writes no marker, and the machine serves", async () => {
    const w = world();
    const engines = createEngines({
      machine: w.machine,
      docker: w.docker,
      workshopIdle: async () => true,
      stopDocker: async () => {},
      copyLogins: async () => {
        throw new Error("tar failed");
      },
      marker: w.marker,
    });
    await expect(engines.settle()).rejects.toThrow("tar failed");
    expect(existsSync(w.marker)).toBe(false);
    expect(engines.current()).toBe(w.machine);
  });
});

describe("copyLogins", () => {
  /** A fake CLI: logs its arguments, runs `body` (sh). */
  const tool = (dir: string, name: string, body: string) => {
    const f = join(dir, name);
    writeFileSync(f, `#!/bin/sh\necho "$*" >> ${join(dir, `${name}.log`)}\n${body}\n`);
    chmodSync(f, 0o755);
    return f;
  };

  it("pipes the Docker volume's tar into the machine's volume", async () => {
    const d = tmp();
    const docker = tool(d, "docker", `case "$1" in run) printf 'LOGINS';; esac`);
    const podman = tool(d, "podman", `cat > ${join(d, "received")}`);
    await copyLogins({ docker, podman, podmanArgs: ["--url", "unix:///s"] });
    expect(readFileSync(join(d, "received"), "utf8")).toBe("LOGINS");
    expect(readFileSync(join(d, "docker.log"), "utf8")).toBe(
      "volume inspect webaios-home\nrun --rm --pull never --network none -u root -v webaios-home:/v ressac-workshop:1 tar -C /v -cf - .\n",
    );
    expect(readFileSync(join(d, "podman.log"), "utf8")).toBe("--url unix:///s run --rm -i --pull never --network none -u root -v webaios-home:/v ressac-workshop:1 tar -C /v -xf -\n");
  });

  it("no Docker volume: nothing to copy", async () => {
    const d = tmp();
    const docker = tool(d, "docker", `[ "$1" = volume ] && exit 1`);
    const podman = tool(d, "podman", "");
    await copyLogins({ docker, podman, podmanArgs: [] });
    expect(existsSync(join(d, "podman.log"))).toBe(false);
  });

  it("either side failing rejects", async () => {
    for (const [dockerBody, podmanBody] of [
      [`case "$1" in run) exit 3;; esac`, "cat >/dev/null"],
      ["", "cat >/dev/null; exit 4"],
    ]) {
      const d = tmp();
      await expect(copyLogins({ docker: tool(d, "docker", dockerBody!), podman: tool(d, "podman", podmanBody!), podmanArgs: [] })).rejects.toThrow();
    }
  });
});
