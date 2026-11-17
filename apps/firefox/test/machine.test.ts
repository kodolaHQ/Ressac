import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runner } from "../../../packages/kernel/src/index.ts";
import { VM_IMAGE, createMachine, type MachineStatus } from "../host/machine";

const TEMPLATE = readFileSync(join(__dirname, "../scripts/vm/lima.yaml"), "utf8");
const dirs: string[] = [];
const machines: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const m of machines.splice(0)) await m.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Call {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

/** A fake world: one Lima instance, a Podman that answers when it runs, the guest's version file and the logins volume. */
function world(o: { instance?: { status: string; disk?: boolean } | null; guestVersion?: string; volume?: boolean; volumeExistsCode?: number; failStops?: number; home?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "m-"));
  dirs.push(root);
  const home = o.home ?? join(root, "h");
  const resources = join(root, "res");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, "lima.yaml"), TEMPLATE);
  const dir = join(home, "ressac");
  const s = { instance: o.instance === undefined ? null : o.instance, guestVersion: o.guestVersion ?? VM_IMAGE.version, volume: o.volume ?? false, calls: [] as Call[], starts: 0, failStops: o.failStops ?? 0, imageSeen: null as Buffer | null };
  if (s.instance) {
    mkdirSync(dir, { recursive: true });
    if (s.instance.disk !== false) writeFileSync(join(dir, "disk"), "");
  }
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const run: Runner = async (cmd, args, opts = {}) => {
    s.calls.push({ cmd, args, env: opts.env });
    const line = args.join(" ");
    if (cmd.endsWith("limactl")) {
      if (line === "list --json") return ok(s.instance ? JSON.stringify({ name: "ressac", status: s.instance.status, dir }) + "\n" : "");
      if (args[0] === "create") {
        mkdirSync(dir, { recursive: true });
        const yaml = readFileSync(args.at(-1) as string, "utf8");
        writeFileSync(join(dir, "lima.yaml"), yaml);
        s.imageSeen = readFileSync(/location: "([^"]+\.raw)"/.exec(yaml)![1] as string);
        s.instance = { status: "Stopped" };
        return ok();
      }
      if (args[0] === "start") {
        await new Promise((r) => setTimeout(r, 5));
        s.starts++;
        writeFileSync(join(dir, "disk"), "");
        s.instance!.status = "Running";
        return ok();
      }
      if (args[0] === "stop") {
        if (s.failStops > 0) return s.failStops--, { code: 1, stdout: "", stderr: "stop failed" };
        return (s.instance!.status = "Stopped"), ok();
      }
      if (line === "delete --force ressac") return rmSync(dir, { recursive: true, force: true }), (s.instance = null), ok();
      if (line.endsWith("cat /etc/ressac-vm-version")) return ok(s.guestVersion + "\n");
      if (line.endsWith("sudo tee /etc/ressac-vm-version")) return (s.guestVersion = String(opts.input).trim()), ok();
      return ok();
    }
    if (cmd.endsWith("podman")) {
      const running = s.instance?.status === "Running";
      if (args.includes("info")) return { code: running ? 0 : 125, stdout: "", stderr: "" };
      if (args.includes("exists")) return { code: o.volumeExistsCode ?? (s.volume ? 0 : 1), stdout: "", stderr: "socket hiccup" };
      if (args.includes("export")) return writeFileSync(args[args.indexOf("--output") + 1] as string, "logins"), ok();
      return ok();
    }
    return ok();
  };
  return { s, home, resources, root, run, dir, ressacRoot: join(root, "Ressac") };
}

function machine(w: ReturnType<typeof world>, o: Partial<Parameters<typeof createMachine>[0]> = {}) {
  const m = createMachine({ home: w.home, limactl: join(w.resources, "bin", "limactl"), podman: join(w.resources, "podman"), template: join(w.resources, "lima.yaml"), engine: join(w.resources, "docker", "engine"), ressacRoot: w.ressacRoot, run: w.run, busy: async () => false, supported: async () => true, pollMs: 5, ...o });
  machines.push(m);
  return m;
}

const limactl = (w: ReturnType<typeof world>) => w.s.calls.filter((c) => c.cmd.endsWith("limactl")).map((c) => c.args.join(" "));
const stops = (w: ReturnType<typeof world>) => limactl(w).filter((l) => l.startsWith("stop")).length;

/** A local image (file:// URL), zstd-compressed, with a run of zeros so the sparse write has something to skip. */
function localImage(root: string) {
  const raw = Buffer.concat([Buffer.from("boot"), Buffer.alloc(1 << 20), Buffer.from("end")]);
  const zst = zstdCompressSync(raw);
  const file = join(root, "image.raw.zst");
  writeFileSync(file, zst);
  return { raw, image: { version: VM_IMAGE.version, url: pathToFileURL(file).href, sha256: createHash("sha256").update(zst).digest("hex"), bytes: zst.length } };
}

describe("the workshop machine", () => {
  it("wake from stopped renders lima.yaml with the current paths, starts, and reports running", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const m = machine(w);
    const seen: MachineStatus["kind"][] = [];
    m.onStatus((s) => seen.push(s.kind));
    await m.wake("user");
    const yaml = readFileSync(join(w.dir, "lima.yaml"), "utf8");
    expect(yaml).toContain(`location: "${w.ressacRoot}"`);
    expect(yaml).toContain(`location: "${join(w.resources, "docker", "engine")}"`);
    expect(yaml).not.toMatch(/location: "?~/);
    expect(yaml).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(seen).toEqual(expect.arrayContaining(["stopped", "starting", "running"]));
    expect(seen.indexOf("starting")).toBeLessThan(seen.indexOf("running"));
    expect(m.status().kind).toBe("running");
    expect(await m.up()).toBe(true);
    expect(m.binary()).toBe(join(w.resources, "podman"));
    expect(m.args()).toEqual(["--url", `unix://${w.home}/ressac/sock/podman.sock`]);
    expect(m.hostAddress()).toBe("192.168.5.2");
  });

  it("every limactl call carries Ressac's own LIMA_HOME", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const m = machine(w);
    await m.wake("user");
    await m.stop();
    const calls = w.s.calls.filter((c) => c.cmd.endsWith("limactl"));
    expect(calls.length).toBeGreaterThan(2);
    for (const c of calls) expect(c.env?.LIMA_HOME).toBe(w.home);
  });

  it("a path that could inject YAML is refused, nothing starts", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const m = machine(w, { ressacRoot: '/Users/x/Ressac"\n- location: "~' });
    await expect(m.wake("user")).rejects.toThrow();
    expect(limactl(w).some((l) => l.startsWith("start"))).toBe(false);
  });

  it("a machine woken for a harvest stops as soon as nothing is busy", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const m = machine(w);
    await m.wake("harvest");
    await vi.waitFor(() => expect(stops(w)).toBe(1));
    expect(m.status().kind).toBe("stopped");
    expect(limactl(w)).toContain("shell --workdir / ressac sudo fstrim -a");
  });

  it("a machine woken by the user stops after idleMs of not busy, and a busy poll resets the count", async () => {
    const w = world({ instance: { status: "Stopped" } });
    let busy = true;
    const m = machine(w, { busy: async () => busy, idleMs: 30 });
    await m.wake("user");
    await new Promise((r) => setTimeout(r, 60));
    expect(stops(w)).toBe(0);
    busy = false;
    await vi.waitFor(() => expect(stops(w)).toBe(1));
  });

  it("a harvest wake on a machine already running for the user keeps the 15 min rule", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const m = machine(w);
    await m.wake("user");
    await m.wake("harvest");
    await new Promise((r) => setTimeout(r, 40));
    expect(stops(w)).toBe(0);
  });

  it("interrupted create is recreated", async () => {
    const { image } = localImage(mkdtempSync(join(tmpdir(), "i-")));
    for (const instance of [{ status: "Broken", disk: false }, { status: "Stopped", disk: false }]) {
      const w = world({ instance });
      const m = machine(w, { image });
      await m.install();
      const l = limactl(w);
      expect(l.indexOf("delete --force ressac")).toBeGreaterThan(-1);
      expect(l.indexOf("delete --force ressac")).toBeLessThan(l.findIndex((x) => x.startsWith("create")));
      expect(m.status().kind).toBe("running");
    }
  });

  it("install decompresses a verified local image sparsely, creates, and is idempotent", async () => {
    const w = world();
    const { image, raw } = localImage(w.root);
    const m = machine(w, { image });
    await m.install();
    expect(w.s.imageSeen?.equals(raw)).toBe(true);
    const create = limactl(w).find((l) => l.startsWith("create"))!;
    expect(create).toMatch(/^create --tty=false --name ressac /);
    expect(w.s.instance?.status).toBe("Running");
    const created = w.s.calls.length;
    await m.install();
    expect(limactl(w).filter((l) => l.startsWith("create"))).toHaveLength(1);
    expect(w.s.calls.slice(created).some((c) => c.args[0] === "create")).toBe(false);
    // The source file:// image is never deleted.
    expect(existsSync(new URL(image.url))).toBe(true);
  });

  it("install refuses an image whose SHA-256 does not match", async () => {
    const w = world();
    const { image } = localImage(w.root);
    const m = machine(w, { image: { ...image, sha256: "0".repeat(64) } });
    await expect(m.install()).rejects.toThrow();
    expect(limactl(w).some((l) => l.startsWith("create"))).toBe(false);
    expect(m.status().kind).toBe("error");
  });

  it("a damaged instance (disk present, neither Running nor Stopped) is never deleted unasked", async () => {
    const w = world({ instance: { status: "Broken" } });
    const m = machine(w);
    await expect(m.wake("user")).rejects.toThrow();
    await expect(m.install()).rejects.toThrow();
    expect(m.status().kind).toBe("error");
    expect(limactl(w).some((l) => l.startsWith("delete") || l.startsWith("create"))).toBe(false);
  });

  it("remove keeps the machine when Podman cannot say whether the logins volume exists", async () => {
    const w = world({ instance: { status: "Stopped" }, volumeExistsCode: 125 });
    const m = machine(w);
    await expect(m.remove()).rejects.toThrow();
    expect(limactl(w).some((l) => l.startsWith("delete"))).toBe(false);
    expect(m.status().kind).toBe("error");
  });

  it("a failed stop keeps the poll armed and the next poll tries again", async () => {
    const w = world({ instance: { status: "Stopped" }, failStops: 2 });
    const m = machine(w);
    await m.wake("harvest");
    await vi.waitFor(() => expect(m.status().kind).toBe("stopped"));
    expect(limactl(w).filter((l) => l.startsWith("stop")).length).toBeGreaterThanOrEqual(3);
  });

  it("socket path too long, counted in bytes", async () => {
    expect(machine(world({ home: "/tmp/" + "é".repeat(45) })).status().kind).toBe("error");
    const w = world({ home: "/tmp/" + "x".repeat(90) });
    const m = machine(w);
    const s = m.status();
    expect(s.kind).toBe("error");
    expect((s as { message: string }).message).toMatch(/\S/);
    expect(await m.up()).toBe(false);
    await expect(m.wake("user")).rejects.toThrow();
    expect(w.s.calls).toEqual([]);
  });

  it("unsupported", async () => {
    const w = world();
    const m = machine(w, { supported: async () => false });
    await expect(m.install()).rejects.toThrow();
    expect(m.status().kind).toBe("unsupported");
    expect(await m.up()).toBe(false);
    expect(w.s.calls).toEqual([]);
  });

  it("version mismatch upgrades in place", async () => {
    const w = world({ instance: { status: "Stopped" }, guestVersion: "3.24.0-5.8.0-000000000000" });
    const m = machine(w);
    await m.wake("user");
    await m.stop();
    await m.wake("user");
    expect(limactl(w).filter((l) => l === "shell --workdir / ressac sudo apk upgrade --no-cache")).toHaveLength(1);
    expect(w.s.guestVersion).toBe(VM_IMAGE.version);
  });

  it("remove exports the logins volume first, and the next install imports it after create", async () => {
    const w = world({ instance: { status: "Stopped" }, volume: true });
    const { image } = localImage(w.root);
    const m = machine(w, { image });
    await m.remove();
    const all = w.s.calls.map((c) => c.args.join(" "));
    const tar = join(w.home, "webaios-home.tar");
    const exported = all.findIndex((l) => l.includes(`volume export webaios-home --output ${tar}`));
    expect(exported).toBeGreaterThan(-1);
    expect(exported).toBeLessThan(all.indexOf("delete --force ressac"));
    expect(existsSync(tar)).toBe(true);
    expect(m.status().kind).toBe("absent");
    const before = w.s.calls.length;
    await m.install();
    const after = w.s.calls.slice(before).map((c) => c.args.join(" "));
    const imported = after.findIndex((l) => l.includes(`volume import webaios-home ${tar}`));
    expect(imported).toBeGreaterThan(after.findIndex((l) => l.startsWith("create")));
    expect(existsSync(tar)).toBe(false);
  });

  it("two wakes at once start once", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const m = machine(w);
    await Promise.all([m.wake("user"), m.wake("user")]);
    expect(w.s.starts).toBe(1);
  });

  it("usage: memory of the processes holding the disk, real disk of the instance; null when absent", async () => {
    const w = world({ instance: { status: "Running" } });
    const run: Runner = async (cmd, args, opts) => {
      if (cmd === "du") return { code: 0, stdout: `1843200\t${w.dir}\n`, stderr: "" };
      if (cmd === "lsof") return { code: 0, stdout: "11\n22\n", stderr: "" };
      if (cmd === "ps") return { code: 0, stdout: " 614400\n 10240\n", stderr: "" };
      return w.run(cmd, args, opts);
    };
    const m = machine(w, { run });
    expect(await m.usage()).toEqual({ memoryMB: 610, diskMB: 1800 });
    expect(await machine(world()).usage()).toBeNull();
  });

  it("close stops a running machine and its poll", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const m = machine(w, { idleMs: 10_000 });
    await m.wake("user");
    await m.close();
    expect(stops(w)).toBe(1);
    const n = w.s.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(w.s.calls.length).toBe(n);
  });
});

describe("vmImage", () => {
  it("the pinned image unless RESSAC_VM_IMAGE_URL and RESSAC_VM_IMAGE_SHA256 are both set", async () => {
    const { vmImage } = await import("../host/machine");
    expect(vmImage({})).toBe(VM_IMAGE);
    expect(vmImage({ RESSAC_VM_IMAGE_URL: "file:///x.raw.zst" })).toBe(VM_IMAGE);
    expect(vmImage({ RESSAC_VM_IMAGE_URL: "file:///b/ressac-vm-3.24.4-5.8.10-abc.raw.zst", RESSAC_VM_IMAGE_SHA256: "ff" })).toEqual({
      version: "3.24.4-5.8.10-abc",
      url: "file:///b/ressac-vm-3.24.4-5.8.10-abc.raw.zst",
      sha256: "ff",
      bytes: 4 * 2 ** 30,
    });
    expect(vmImage({ RESSAC_VM_IMAGE_URL: "https://h/other.zst", RESSAC_VM_IMAGE_SHA256: "ee", RESSAC_VM_IMAGE_VERSION: "v9", RESSAC_VM_IMAGE_BYTES: "12" })).toEqual({
      version: "v9",
      url: "https://h/other.zst",
      sha256: "ee",
      bytes: 12,
    });
  });
});
