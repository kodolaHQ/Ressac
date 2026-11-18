import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runner } from "../../../packages/kernel/src/index.ts";
import { QUIT_STOP, UPGRADE, VM_IMAGE, createMachine, engineCopy, type MachineStatus } from "../host/machine";

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
  input?: string;
}

/** A fake world: one Lima instance, a Podman that answers when it runs, the guest's version file and the logins volume. */
function world(o: { instance?: { status: string; disk?: boolean } | null; guestVersion?: string; upgradedTo?: string; volume?: boolean; volumeExistsCode?: number; failStops?: number; home?: string; brokenPodman?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "m-"));
  dirs.push(root);
  const home = o.home ?? join(root, "h");
  const resources = join(root, "res");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(resources, "lima.yaml"), TEMPLATE);
  const dir = join(home, "ressac");
  const s = { instance: o.instance === undefined ? null : o.instance, guestVersion: o.guestVersion ?? VM_IMAGE.version, volume: o.volume ?? false, calls: [] as Call[], starts: 0, apk: 0, healed: false, failStops: o.failStops ?? 0, imageSeen: null as Buffer | null };
  if (s.instance) {
    mkdirSync(dir, { recursive: true });
    if (s.instance.disk !== false) writeFileSync(join(dir, "disk"), "");
  }
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const run: Runner = async (cmd, args, opts = {}) => {
    s.calls.push({ cmd, args, env: opts.env, input: opts.input });
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
      if (line.endsWith("pgrep -x apk")) return s.apk > 0 ? (s.apk--, ok("1")) : { code: 1, stdout: "", stderr: "" };
      if (line.endsWith("ressac sudo sh") && String(opts.input).includes("apk fix")) return (s.healed = true), ok();
      if (line.endsWith("sudo tee /etc/ressac-vm-version")) return (s.guestVersion = String(opts.input).trim()), ok();
      // The detached upgrade job: what apk delivered (alpine-release, podman), the setup hash kept.
      if (line.endsWith("ressac sudo sh") && String(opts.input).includes("apk upgrade")) return (s.guestVersion = o.upgradedTo ?? VM_IMAGE.version), ok();
      return ok();
    }
    if (cmd.endsWith("podman")) {
      const running = s.instance?.status === "Running";
      if (args.includes("info")) return { code: running && (!o.brokenPodman || s.healed) ? 0 : 125, stdout: "", stderr: "" };
      if (args.includes("exists")) return { code: o.volumeExistsCode ?? (s.volume ? 0 : 1), stdout: "", stderr: "socket hiccup" };
      if (args.includes("export")) return writeFileSync(args[args.indexOf("--output") + 1] as string, "logins"), ok();
      return ok();
    }
    return ok();
  };
  return { s, home, resources, root, run, dir, ressacRoot: join(root, "Ressac") };
}

function machine(w: ReturnType<typeof world>, o: Partial<Parameters<typeof createMachine>[0]> = {}) {
  const m = createMachine({ home: w.home, limactl: join(w.resources, "bin", "limactl"), podman: join(w.resources, "podman"), template: join(w.resources, "lima.yaml"), engine: join(w.resources, "docker", "engine"), ressacRoot: w.ressacRoot, run: w.run, busy: async () => false, supported: async () => true, pollMs: 5, detach: () => {}, ...o });
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

  it("the idle delay is read at each poll: a change applies to a machine already running", async () => {
    const w = world({ instance: { status: "Stopped" } });
    let delay = 60_000;
    const m = machine(w, { idleMs: () => delay });
    await m.wake("user");
    await new Promise((r) => setTimeout(r, 40));
    expect(stops(w)).toBe(0);
    delay = 30;
    await vi.waitFor(() => expect(stops(w)).toBe(1));
  });

  it("a harvest wake on a machine already running for the user keeps the idle rule", async () => {
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

  it("a damaged instance that cannot start: remove keeps it, remove({ force: true }) deletes it without start nor export", async () => {
    const w = world({ instance: { status: "Broken" }, volume: true });
    const run: Runner = (cmd, args, o) => (args[0] === "start" ? Promise.resolve({ code: 1, stdout: "", stderr: "vz: boom" }) : w.run(cmd, args, o));
    const m = machine(w, { run });
    await vi.waitFor(() => expect(m.status()).toMatchObject({ kind: "error", forceRemovable: true }));
    await expect(m.remove()).rejects.toThrow();
    expect(m.status()).toMatchObject({ kind: "error", forceRemovable: true });
    expect(limactl(w).some((l) => l.startsWith("delete"))).toBe(false);
    await m.remove({ force: true });
    expect(limactl(w)).toContain("delete --force ressac");
    expect(w.s.calls.some((c) => c.args.includes("export"))).toBe(false);
    expect(m.status().kind).toBe("absent");
  });

  it("remove keeps the machine when Podman cannot say whether the logins volume exists", async () => {
    const w = world({ instance: { status: "Stopped" }, volumeExistsCode: 125 });
    const m = machine(w);
    await expect(m.remove()).rejects.toThrow();
    expect(limactl(w).some((l) => l.startsWith("delete"))).toBe(false);
    // A failed export offers the forced removal too, never a dead end.
    expect(m.status()).toMatchObject({ kind: "error", forceRemovable: true });
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

  it("an older guest on the image's Alpine branch and setup is upgraded detached in the guest: the boot never waits for apk nor cuts it", async () => {
    const w = world({ instance: { status: "Stopped" }, guestVersion: "3.24.0-5.8.0-20062535e787", upgradedTo: "3.24.3-5.8.10-20062535e787" });
    const delays: (number | undefined)[] = [];
    const run: Runner = (cmd, args, o) => (String(o?.input ?? "").includes("apk upgrade") && delays.push(o?.delayMs), w.run(cmd, args, o));
    const m = machine(w, { run });
    await m.wake("user");
    expect(limactl(w).some((l) => l.includes("apk"))).toBe(false); // never a blocking apk over the shell
    const job = w.s.calls.filter((c) => c.args.join(" ") === "shell --workdir / ressac sudo sh" && String(c.input ?? "").includes("apk upgrade"));
    expect(job).toHaveLength(1);
    expect(delays).toEqual([120_000]); // any shell call's default: it only launches the job
    expect(w.s.guestVersion).toBe("3.24.3-5.8.10-20062535e787"); // the mark as apk left it
    await m.stop();
    await m.wake("user");
    expect(delays).toHaveLength(2); // still short of the image: launched again at the next boot
  });

  it("a guest on another Alpine branch, another setup, or newer than the image is not upgraded: it boots as it is", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const guestVersion of ["3.23.9-5.8.10-20062535e787", "3.24.4-5.8.10-000000000000", "3.24.9-5.9.0-20062535e787"]) {
        const w = world({ instance: { status: "Stopped" }, guestVersion });
        const m = machine(w);
        await m.wake("user");
        expect(limactl(w).some((l) => l.includes("apk upgrade"))).toBe(false);
        expect(w.s.guestVersion).toBe(guestVersion);
        expect(m.status().kind).toBe("running");
      }
      expect(warn).toHaveBeenCalledTimes(2); // the branch and the setup: only a new machine brings them
    } finally {
      warn.mockRestore();
    }
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

  it("a stale machine (Running, Podman gone after a Mac sleep) is force-stopped and started again", async () => {
    const w = world({ instance: { status: "Running" } });
    let stale = true;
    const run: Runner = async (cmd, args, o) => {
      if (cmd.endsWith("podman") && args.includes("info") && stale) return { code: 125, stdout: "", stderr: "connection refused" };
      if (args.join(" ") === "stop --force ressac") stale = false;
      return w.run(cmd, args, o);
    };
    const m = machine(w, { run, idleMs: 60_000 });
    await vi.waitFor(() => expect(m.status().kind).toBe("running"));
    await m.wake("user");
    const l = limactl(w);
    expect(l.indexOf("stop --force ressac")).toBeGreaterThan(-1);
    expect(l.indexOf("stop --force ressac")).toBeLessThan(l.findIndex((x) => x.startsWith("start")));
    expect(w.s.starts).toBe(1);
    expect(m.status().kind).toBe("running");
    // A healthy running machine is not restarted.
    await m.wake("user");
    expect(w.s.starts).toBe(1);
  });

  it("a Stopped instance that cannot boot: remove fails but offers the forced removal", async () => {
    const w = world({ instance: { status: "Stopped" }, volume: true });
    const run: Runner = (cmd, args, o) => (args[0] === "start" ? Promise.resolve({ code: 1, stdout: "", stderr: "vz: boom" }) : w.run(cmd, args, o));
    const m = machine(w, { run });
    await expect(m.remove()).rejects.toThrow();
    expect(m.status()).toMatchObject({ kind: "error", forceRemovable: true });
    expect(limactl(w).some((l) => l.startsWith("delete"))).toBe(false);
  });

  it("the machine folder is the user's alone, and so is the exported logins tar", async () => {
    const w = world({ instance: { status: "Stopped" }, volume: true });
    mkdirSync(w.home, { recursive: true, mode: 0o755 });
    chmodSync(w.home, 0o755);
    const m = machine(w);
    await m.remove();
    expect(statSync(w.home).mode & 0o777).toBe(0o700);
    expect(statSync(join(w.home, "webaios-home.tar")).mode & 0o777).toBe(0o600);
  });

  it("a harvest that woke the machine just before a poll gets one poll of grace", async () => {
    const w = world({ instance: { status: "Stopped" } });
    let polls = 0;
    const m = machine(w, { pollMs: 300, busy: async () => (polls++, false) });
    await m.wake("harvest");
    await m.wake("harvest"); // a second harvest, its podman run not started yet
    await vi.waitFor(() => expect(polls).toBe(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(stops(w)).toBe(0);
    await vi.waitFor(() => expect(stops(w)).toBe(1));
  });

  it("a small Mac is 8 GiB or less, unless a test forces it; memory is calm at pressure level 1 only", async () => {
    const { isSmallMac } = await import("../shared/settings");
    expect([isSmallMac(8 * 2 ** 30), isSmallMac(8 * 2 ** 30 + 1), isSmallMac(16 * 2 ** 30, "1"), isSmallMac(4 * 2 ** 30, "0"), isSmallMac(4 * 2 ** 30, "")]).toEqual([true, false, true, false, true]);
    const { memoryCalm } = await import("../host/machine");
    const file = join(mkdtempSync(join(tmpdir(), "ressac-pressure-")), "level");
    for (const [level, calm] of [["1", true], ["2\n", false], ["4", false]] as const) {
      writeFileSync(file, level);
      expect(await memoryCalm({ RESSAC_TEST_PRESSURE_FILE: file })).toBe(calm);
    }
    expect(await memoryCalm({ RESSAC_TEST_PRESSURE_FILE: file + ".missing" })).toBe(true);
    // Under pressure, only « Économiser la mémoire » holds the harvests back.
    const { memoryAllows } = await import("../host/machine");
    expect([await memoryAllows(true, { RESSAC_TEST_PRESSURE_FILE: file }), await memoryAllows(false, { RESSAC_TEST_PRESSURE_FILE: file })]).toEqual([false, true]);
  });

  it("the VM's memory follows the Mac: 1.5 GiB at 8 GiB or less, 3 GiB above; the workshop container keeps 0.5 GiB for the guest", async () => {
    const { smallMac } = await import("../host/machine");
    expect(smallMac(8 * 2 ** 30)).toBe(true);
    expect(smallMac(16 * 2 ** 30)).toBe(false);
    for (const [total, vm, container] of [[8 * 2 ** 30, "1.5GiB", 2 ** 30], [16 * 2 ** 30, "3GiB", 2.5 * 2 ** 30]] as const) {
      const w = world({ instance: { status: "Stopped" } });
      const m = machine(w, { totalMemory: total });
      await m.wake("user");
      expect(readFileSync(join(w.dir, "lima.yaml"), "utf8")).toContain(`\nmemory: ${vm}\n`);
      expect(m.memory()).toBe(container);
    }
  });

  it("an automatic install (AI on) does not keep the new machine running: it stops as soon as nothing is busy", async () => {
    const w = world();
    const { image } = localImage(w.root);
    const m = machine(w, { image, idleMs: 60_000 });
    await m.install({ auto: true });
    await vi.waitFor(() => expect(stops(w)).toBe(1));
    // The user's « Installer » keeps the idle rule.
    const u = world();
    const mu = machine(u, { image: localImage(u.root).image, idleMs: 60_000 });
    await mu.install();
    await new Promise((r) => setTimeout(r, 40));
    expect(stops(u)).toBe(0);
  });

  it("memory pressure stops a running machine nothing uses, never a busy one nor one just woken", async () => {
    const w = world({ instance: { status: "Stopped" } });
    let busy = true;
    const m = machine(w, { busy: async () => busy, idleMs: 60_000, pollMs: 60_000 });
    await m.wake("user");
    await m.relieve();
    expect(stops(w)).toBe(0); // just woken: its session may not have started yet
    const idle = world({ instance: { status: "Stopped" } });
    await machine(idle, { idleMs: 60_000, pollMs: 60_000 }).relieve(); // never woken: nothing to stop, nothing started
    expect(limactl(idle).filter((l) => l.startsWith("st"))).toEqual([]);
    // After a poll saw the wake: a busy machine stays, an unused one stops.
    const w2 = world({ instance: { status: "Stopped" } });
    let polls = 0;
    const m2 = machine(w2, { busy: async () => (polls++, busy), idleMs: 60_000, pollMs: 5 });
    await m2.wake("user");
    await vi.waitFor(() => expect(polls).toBeGreaterThan(0));
    await m2.relieve();
    expect(stops(w2)).toBe(0);
    busy = false;
    await m2.relieve();
    expect(stops(w2)).toBe(1);
    expect(m2.status().kind).toBe("stopped");
  });

  it("a failed removal leaves the machine running under the idle rule", async () => {
    const w = world({ instance: { status: "Stopped" }, volumeExistsCode: 125 });
    const m = machine(w, { idleMs: 10 });
    await expect(m.remove()).rejects.toThrow();
    await vi.waitFor(() => expect(stops(w)).toBe(1));
  });

  it("cancel (AI off) aborts the image download in flight: nothing is created", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_q, res) => {
      res.writeHead(200, { "content-length": "1000000" });
      res.write(Buffer.alloc(1000)); // then hangs
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const w = world();
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/ressac-vm-x.raw.zst`;
      const m = machine(w, { image: { version: "x", url, sha256: "0".repeat(64), bytes: 1_000_000 } });
      const installing = m.install();
      await vi.waitFor(() => expect(m.status().kind).toBe("downloading"));
      await m.cancel();
      await expect(installing).rejects.toThrow();
      expect(limactl(w).some((l) => l.startsWith("create"))).toBe(false);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("cancel (AI off) during a boot stops the machine once it is up; a machine never created stays absent", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const m = machine(w, { idleMs: 60_000 });
    const waking = m.wake("user");
    await m.cancel();
    await waking;
    expect(stops(w)).toBe(1);
    expect(m.status().kind).toBe("stopped");
    const none = machine(world());
    await vi.waitFor(() => expect(none.status().kind).toBe("absent"));
    await none.cancel();
    expect(none.status().kind).toBe("absent");
  });

  it("two wakes at once start once", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const m = machine(w);
    await Promise.all([m.wake("user"), m.wake("user")]);
    expect(w.s.starts).toBe(1);
  });

  it("usage: footprint (Activity Monitor's figure, not the RSS that counts the VM's memory twice) of the processes holding the disk, real disk of the instance; null when absent", async () => {
    const w = world({ instance: { status: "Running" } });
    let asked: string[] = [];
    const run: Runner = async (cmd, args, opts) => {
      if (cmd === "du") return { code: 0, stdout: `1843200\t${w.dir}\n`, stderr: "" };
      if (cmd === "lsof") return { code: 0, stdout: "11\n22\n", stderr: "" };
      if (cmd === "footprint") {
        asked = args;
        const stdout = "com.apple.Virtualization.VirtualMachine [11]: 64-bit    Footprint: 2.5 GB (16384 bytes per page)\nlimactl [22]: 64-bit    Footprint: 115 MB (16384 bytes per page)\nSummary Footprint: 2675 MB\n";
        return { code: 0, stdout, stderr: "" };
      }
      return w.run(cmd, args, opts);
    };
    const m = machine(w, { run });
    expect(await m.usage()).toEqual({ memoryMB: 2675, diskMB: 1800 });
    expect(asked).toEqual(["11", "22"]);
    expect(await machine(world()).usage()).toBeNull();
  });

  it("close hands the stop to a detached script, ends the poll and refuses any later start", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const detach = vi.fn();
    const m = machine(w, { idleMs: 10_000, detach });
    await m.wake("user");
    await m.close();
    expect(detach).toHaveBeenCalledWith([QUIT_STOP, "ressac-vm-stop", join(w.resources, "bin", "limactl"), "ressac", "3", "0", expect.any(String)], { LIMA_HOME: w.home });
    const n = w.s.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(w.s.calls.length).toBe(n);
    await expect(m.wake("user")).rejects.toThrow();
    expect(stops(w)).toBe(0);
  });

  it("close during a start: the script waits for it", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const detach = vi.fn();
    const m = machine(w, { detach });
    const waking = m.wake("user").catch(() => {});
    await m.close();
    expect(detach.mock.calls.at(-1)![0][1]).toBe("ressac-vm-stop");
    expect(detach.mock.calls.at(-1)![0].at(-2)).toBe("1");
    await waking;
  });

  it("the quit script stops a running instance, forced when the plain stop fails, and leaves a stopped one", async () => {
    for (const [state, plain, expected] of [["Running", 0, "stop ressac\n"], ["Running", 1, "stop ressac\nstop --force ressac\n"], ["Stopped", 0, ""]] as const) {
      const d = mkdtempSync(join(tmpdir(), "q-"));
      dirs.push(d);
      const l = join(d, "limactl");
      writeFileSync(l, `#!/bin/sh\n[ "$1" = list ] && { echo ${state}; exit 0; }\n[ "$1" = shell ] && exit 1\necho "$*" >> ${join(d, "log")}\n[ "$2" = --force ] || exit ${plain}\n`);
      chmodSync(l, 0o755);
      writeFileSync(join(d, "launch"), "t1");
      execFileSync("/bin/sh", ["-c", QUIT_STOP, "x", l, "ressac", "0", "0", "t1"], { env: { ...process.env, LIMA_HOME: d } });
      expect(existsSync(join(d, "log")) ? readFileSync(join(d, "log"), "utf8") : "").toBe(expected);
    }
  });

  it("the quit script leaves alone a machine a newer launch took over, even while it waits", async () => {
    for (const wait of ["0", "1"]) {
      const d = mkdtempSync(join(tmpdir(), "q-"));
      dirs.push(d);
      const l = join(d, "limactl");
      writeFileSync(l, `#!/bin/sh\n[ "$1" = list ] && { echo Running; exit 0; }\n[ "$1" = shell ] && exit 1\necho "$*" >> ${join(d, "log")}\n`);
      chmodSync(l, 0o755);
      writeFileSync(join(d, "launch"), "t2");
      execFileSync("/bin/sh", ["-c", QUIT_STOP, "x", l, "ressac", "0", wait, "t1"], { env: { ...process.env, LIMA_HOME: d } });
      expect(existsSync(join(d, "log"))).toBe(false);
    }
  });

  it("each launch that uses or closes the machine writes its own token, and hands it to the quit script", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const detach = vi.fn();
    const m = machine(w, { detach });
    await m.wake("user");
    const token = readFileSync(join(w.home, "launch"), "utf8");
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    const other = machine(w, { detach: () => {} });
    await other.wake("user");
    expect(readFileSync(join(w.home, "launch"), "utf8")).not.toBe(token);
    await m.close(); // a close takes the duty back with its quit token: its own crash watcher stands down
    expect(readFileSync(join(w.home, "launch"), "utf8")).toBe(`${token}-quit`);
    expect(detach.mock.calls.at(-1)![0].at(-1)).toBe(`${token}-quit`);
  });

  it("the first use leaves a watcher that stops the machine should the host die without quitting", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const detach = vi.fn();
    const m = machine(w, { detach });
    await m.wake("user");
    await m.wake("user");
    const token = readFileSync(join(w.home, "launch"), "utf8");
    expect(detach.mock.calls).toEqual([[[QUIT_STOP, "ressac-vm-watch", join(w.resources, "bin", "limactl"), "ressac", "0", "0", token, String(process.pid)], { LIMA_HOME: w.home }]]);
  });

  it("the watcher waits for the host's end, then stops the machine unless a newer launch or a quit took it", async () => {
    for (const [launch, expected] of [["t1", "stop ressac\n"], ["t1-quit", ""], ["t2", ""]] as const) {
      const d = mkdtempSync(join(tmpdir(), "q-"));
      dirs.push(d);
      const l = join(d, "limactl");
      writeFileSync(l, `#!/bin/sh\n[ "$1" = list ] && { echo Running; exit 0; }\n[ "$1" = shell ] && exit 1\necho "$*" >> ${join(d, "log")}\n`);
      chmodSync(l, 0o755);
      writeFileSync(join(d, "launch"), launch);
      const host = spawn("sleep", ["0.5"]);
      const began = Date.now();
      // Async: a sync run would block the reaping of `host`, whose zombie answers kill -0.
      await promisify(execFile)("/bin/sh", ["-c", QUIT_STOP.replace("sleep 10", "sleep 0.1"), "x", l, "ressac", "0", "0", "t1", String(host.pid)], { env: { ...process.env, LIMA_HOME: d } });
      expect(Date.now() - began).toBeGreaterThanOrEqual(400);
      expect(existsSync(join(d, "log")) ? readFileSync(join(d, "log"), "utf8") : "").toBe(expected);
    }
  });

  it("a harvest never re-creates a removed machine nor boots a failing one; harvestable says so", async () => {
    const gone = world();
    const removed = machine(gone);
    expect(await removed.harvestable()).toBe(false);
    await expect(removed.wake("harvest")).rejects.toThrow();
    expect(limactl(gone).some((l) => l.startsWith("create") || l.startsWith("start"))).toBe(false);
    expect(removed.status().kind).toBe("absent");

    const w = world({ instance: { status: "Stopped" } });
    let fails = true;
    const run: Runner = (cmd, args, o) => (args[0] === "start" && fails ? Promise.resolve({ code: 1, stdout: "", stderr: "vz: boom" }) : w.run(cmd, args, o));
    const m = machine(w, { run });
    expect(await m.harvestable()).toBe(true);
    await expect(m.wake("user")).rejects.toThrow("vz: boom");
    const message = (m.status() as { message: string }).message;
    fails = false;
    expect(await m.harvestable()).toBe(false);
    await expect(m.wake("harvest")).rejects.toThrow();
    expect(w.s.starts).toBe(0);
    expect(m.status()).toMatchObject({ kind: "error", message });
  });

  it("« Réessayer » (install) boots again a stopped machine whose boot failed; a plain stopped one stays stopped", async () => {
    const w = world({ instance: { status: "Stopped" } });
    let fails = true;
    const run: Runner = (cmd, args, o) => (args[0] === "start" && fails ? Promise.resolve({ code: 1, stdout: "", stderr: "vz: boom" }) : w.run(cmd, args, o));
    const m = machine(w, { run, idleMs: 60_000 });
    await m.install();
    expect(w.s.starts).toBe(0);
    await expect(m.wake("user")).rejects.toThrow();
    fails = false;
    await m.install();
    expect(w.s.starts).toBe(1);
    expect(m.status().kind).toBe("running");
  });

  it("remove restarts a stale machine (Podman gone after a Mac sleep) to save the logins, without a 5 min wait", async () => {
    const w = world({ instance: { status: "Running" }, volume: true });
    let stale = true;
    const run: Runner = async (cmd, args, o) => {
      if (cmd.endsWith("podman") && args.includes("info") && stale) return { code: 125, stdout: "", stderr: "connection refused" };
      if (args.join(" ") === "stop --force ressac") stale = false;
      return w.run(cmd, args, o);
    };
    const m = machine(w, { run });
    await vi.waitFor(() => expect(m.status().kind).toBe("running"));
    await m.remove();
    expect(w.s.calls.filter((c) => c.args.includes("info")).length).toBeLessThan(5);
    expect(w.s.calls.some((c) => c.args.includes("export"))).toBe(true);
    expect(m.status().kind).toBe("absent");
  });

  it("a removal cut by a failed delete or a failed listing keeps the machine under the idle rule", async () => {
    for (const fail of ["delete --force ressac", "list --json"]) {
      const w = world({ instance: { status: "Running" } });
      let listed = 0;
      const run: Runner = (cmd, args, o) => {
        const line = args.join(" ");
        // The listing fails once, during the removal (the launch probe is the first).
        const failing = line === fail && (fail !== "list --json" || ++listed === 2);
        return failing ? Promise.resolve({ code: 1, stdout: "", stderr: "lima: boom" }) : w.run(cmd, args, o);
      };
      let busy = true; // until the removal: the launch's own idle rule must not stop it first
      const m = machine(w, { run, idleMs: 10, busy: async () => busy });
      await vi.waitFor(() => expect(m.status().kind).toBe("running"));
      await expect(m.remove({ force: true })).rejects.toThrow();
      expect(m.status().kind).toBe("error");
      busy = false;
      await vi.waitFor(() => expect(stops(w)).toBe(1));
    }
  });

  it("a running machine booted with other mounts (another Ressac) is restarted when idle, refused when busy", async () => {
    for (const busy of [false, true]) {
      const w = world({ instance: { status: "Running" } });
      writeFileSync(join(w.dir, "lima.yaml"), TEMPLATE.replace("{{RESSAC_ROOT}}", "/elsewhere/Ressac"));
      const m = machine(w, { busy: async () => busy, idleMs: 60_000 });
      await vi.waitFor(() => expect(m.status().kind).toBe("running"));
      if (busy) {
        await expect(m.wake("user")).rejects.toThrow(/autre configuration|another configuration/);
        expect(stops(w)).toBe(0);
        continue;
      }
      await m.wake("user");
      expect(stops(w)).toBe(1);
      expect(w.s.starts).toBe(1);
      expect(readFileSync(join(w.dir, "lima.yaml"), "utf8")).toContain(`location: "${w.ressacRoot}"`);
      await m.wake("user"); // now its own mounts: left running
      expect(w.s.starts).toBe(1);
    }
  });

  it("a new image version deletes the files of the older ones, never the logins", async () => {
    const w = world();
    mkdirSync(w.home, { recursive: true });
    for (const f of ["ressac-vm-old.raw", "ressac-vm-old.raw.zst.part", "ressac-vm-old.raw.part", "webaios-home.tar"]) writeFileSync(join(w.home, f), "x");
    const { image } = localImage(w.root);
    await machine(w, { image }).install();
    for (const f of ["ressac-vm-old.raw", "ressac-vm-old.raw.zst.part", "ressac-vm-old.raw.part"]) expect(existsSync(join(w.home, f))).toBe(false);
    expect(w.s.calls.some((c) => c.args.includes("import"))).toBe(true); // the saved logins were kept for their import
  });
  it("a removed machine stays removed: no new launch installs it unasked, nor any wake; « Installer » clears that and installs", async () => {
    const w = world({ instance: { status: "Stopped" }, volume: true });
    const { image } = localImage(w.root);
    await machine(w, { image }).remove();
    const m = machine(w, { image }); // the next launch
    expect(m.status()).toEqual({ kind: "absent", removed: true });
    await expect(m.install({ auto: true })).rejects.toThrow(/Réglages|Settings/);
    for (const reason of ["user", "harvest"] as const) await expect(m.wake(reason)).rejects.toThrow(/Réglages|Settings/);
    expect(await m.harvestable()).toBe(false);
    expect(limactl(w).filter((l) => l.startsWith("create"))).toHaveLength(0);
    expect(m.status()).toEqual({ kind: "absent", removed: true });
    await m.install(); // the click
    expect(limactl(w).filter((l) => l.startsWith("create"))).toHaveLength(1);
    expect(m.status().kind).toBe("running");
    expect(machine(w, { image }).status()).toEqual({ kind: "absent" }); // the mark is gone (a launch's first status before its probe)
  });

  it("a forced removal leaves the machine removed too", async () => {
    const w = world({ instance: { status: "Stopped" } });
    await machine(w).remove({ force: true });
    expect(machine(w).status()).toEqual({ kind: "absent", removed: true });
  });

  it("a failed launch probe counts the machine as stopped (harvestable), never absent; a removed one stays removed", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const run: Runner = (cmd, args, o) => (args.join(" ") === "list --json" ? Promise.resolve({ code: 1, stdout: "", stderr: "lima: boom" }) : w.run(cmd, args, o));
    const m = machine(w, { run });
    expect(await m.harvestable()).toBe(true);
    expect(m.status().kind).toBe("stopped");
    await machine(w).remove({ force: true });
    const r = machine(w, { run });
    expect(await r.harvestable()).toBe(false);
    expect(r.status()).toEqual({ kind: "absent", removed: true });
  });

  it("every wake writes this launch's token again: another Ressac's quit never disarms its crash watcher", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const detach = vi.fn();
    const m = machine(w, { detach });
    await m.wake("user");
    const token = readFileSync(join(w.home, "launch"), "utf8");
    await machine(w).close(); // another Ressac quits
    expect(readFileSync(join(w.home, "launch"), "utf8")).not.toBe(token);
    await m.wake("user");
    expect(readFileSync(join(w.home, "launch"), "utf8")).toBe(token);
    expect(detach.mock.calls.filter((c) => c[0][1] === "ressac-vm-watch")).toHaveLength(1);
  });

  it("remove of a machine in error that Lima lists Running restarts a stale Podman before the export", async () => {
    const w = world({ instance: { status: "Stopped" }, volume: true });
    let fails = true;
    let stale = false;
    const run: Runner = async (cmd, args, o) => {
      if (args[0] === "start" && fails) return { code: 1, stdout: "", stderr: "vz: boom" };
      if (cmd.endsWith("podman") && args.includes("info") && stale) return { code: 125, stdout: "", stderr: "connection refused" };
      if (args.join(" ") === "stop --force ressac") stale = false;
      return w.run(cmd, args, o);
    };
    const m = machine(w, { run });
    await expect(m.wake("user")).rejects.toThrow();
    expect(m.status().kind).toBe("error");
    fails = false;
    w.s.instance!.status = "Running"; // up after all (a late boot), its Podman gone
    stale = true;
    await m.remove();
    expect(limactl(w)).toContain("stop --force ressac");
    expect(w.s.calls.filter((c) => c.args.includes("info")).length).toBeLessThan(10);
    expect(w.s.calls.some((c) => c.args.includes("export"))).toBe(true);
  });

  it("a stop waits for a running apk (bounded), and a running apk counts as busy for the idle poll", async () => {
    const w = world({ instance: { status: "Stopped" } });
    const m = machine(w, { idleMs: 10 });
    await m.wake("harvest");
    w.s.apk = 3; // two polls see it busy; then the stop itself waits for it once more
    await vi.waitFor(() => expect(stops(w)).toBe(1), { timeout: 10_000 });
    const l = limactl(w);
    expect(w.s.apk).toBe(0);
    expect(l.lastIndexOf("shell --workdir / ressac pgrep -x apk")).toBeLessThan(l.findIndex((x) => x.startsWith("stop")));
  });

  it("the quit script waits for a running apk before its stop", async () => {
    const d = mkdtempSync(join(tmpdir(), "q-"));
    dirs.push(d);
    const l = join(d, "limactl");
    // apk runs for the first two probes.
    writeFileSync(l, `#!/bin/sh\n[ "$1" = list ] && { echo Running; exit 0; }\nif [ "$1" = shell ]; then echo p >> ${join(d, "probes")}; [ $(wc -l < ${join(d, "probes")}) -le 2 ]; exit $?; fi\necho "$*" >> ${join(d, "log")}\n`);
    chmodSync(l, 0o755);
    writeFileSync(join(d, "launch"), "t1");
    execFileSync("/bin/sh", ["-c", QUIT_STOP.replace("sleep 2", "sleep 0.05"), "x", l, "ressac", "0", "0", "t1"], { env: { ...process.env, LIMA_HOME: d } });
    expect(readFileSync(join(d, "probes"), "utf8").split("\n").filter(Boolean)).toHaveLength(3);
    expect(readFileSync(join(d, "log"), "utf8")).toBe("stop ressac\n");
  });

  it("a Podman that never answers after a cut upgrade is healed once by apk, then the boot goes on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const w = world({ instance: { status: "Stopped" }, guestVersion: "3.24.0-5.8.0-20062535e787", brokenPodman: true });
      let done = false;
      const p = machine(w).wake("user").finally(() => (done = true));
      while (!done) await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(w.s.healed).toBe(true);
      // Not owed (a guest on the image): no heal, the boot fails as before.
      const ok = world({ instance: { status: "Stopped" }, brokenPodman: true });
      done = false;
      const q = machine(ok).wake("user").catch((e) => e).finally(() => (done = true));
      while (!done) await vi.advanceTimersByTimeAsync(1000);
      expect(await q).toBeInstanceOf(Error);
      expect(ok.s.healed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed launch probe with no instance folder stays absent (no download from a harvest)", async () => {
    const w = world();
    const run: Runner = (cmd, args, o) => (args.join(" ") === "list --json" ? Promise.resolve({ code: 1, stdout: "", stderr: "lima: boom" }) : w.run(cmd, args, o));
    const m = machine(w, { run });
    expect(await m.harvestable()).toBe(false);
    expect(m.status().kind).toBe("absent");
  });

  it("the removed mark is written before the delete: a delete cut short never reinstalls at the next AI on; a failed one leaves no mark", async () => {
    const w = world({ instance: { status: "Stopped" } });
    let marked: boolean | undefined;
    const run: Runner = (cmd, args, o) => (args[0] === "delete" && (marked = existsSync(join(w.home, "removed"))), w.run(cmd, args, o));
    await machine(w, { run }).remove({ force: true });
    expect(marked).toBe(true);
    const f = world({ instance: { status: "Stopped" } });
    const failing: Runner = (cmd, args, o) => (args[0] === "delete" ? Promise.resolve({ code: 1, stdout: "", stderr: "boom" }) : f.run(cmd, args, o));
    await expect(machine(f, { run: failing }).remove({ force: true })).rejects.toThrow();
    expect(existsSync(join(f.home, "removed"))).toBe(false);
    // Delete and listing both fail: maybe deleted, so the mark stays and nothing reinstalls on its own.
    const u = world({ instance: { status: "Stopped" } });
    let deleted = false;
    const blind: Runner = (cmd, args, o) =>
      args[0] === "delete" ? ((deleted = true), Promise.resolve({ code: 1, stdout: "", stderr: "boom" }))
      : deleted && args[0] === "list" ? Promise.resolve({ code: 1, stdout: "", stderr: "boom" })
      : u.run(cmd, args, o);
    await expect(machine(u, { run: blind }).remove({ force: true })).rejects.toThrow();
    expect(existsSync(join(u.home, "removed"))).toBe(true);
  });

  it("a fresh boot deletes the older versioned engine folders; a machine already running keeps them mounted", async () => {
    for (const status of ["Stopped", "Running"]) {
      const w = world({ instance: { status } });
      const data = join(w.root, "data");
      for (const f of ["engine-old", "engine-new", "other"]) mkdirSync(join(data, f), { recursive: true });
      const m = machine(w, { engine: join(data, "engine-new"), idleMs: 60_000 });
      if (status === "Running") await vi.waitFor(() => expect(m.status().kind).toBe("running"));
      await m.wake("user");
      expect(existsSync(join(data, "engine-old"))).toBe(w.s.starts === 0);
      expect(existsSync(join(data, "engine-new"))).toBe(true);
      expect(existsSync(join(data, "other"))).toBe(true);
    }
  });
});

describe("the guest upgrade job", () => {
  it("returns at once, apk runs detached, the mark is rewritten only once apk is done; a second launch while apk runs starts none", async () => {
    const d = mkdtempSync(join(tmpdir(), "u-"));
    dirs.push(d);
    const bin = join(d, "bin");
    mkdirSync(bin);
    const tool = (name: string, body: string) => (writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`), chmodSync(join(bin, name), 0o755));
    tool("apk", `echo "$*" >> ${d}/apk.log; touch ${d}/apk.running; while [ ! -e ${d}/release ]; do sleep 0.05; done; rm ${d}/apk.running`);
    tool("pgrep", `[ "$*" = "-x apk" ] && [ -e ${d}/apk.running ]`);
    tool("podman", "echo 5.8.10");
    writeFileSync(join(d, "alpine-release"), "3.24.4\n");
    writeFileSync(join(d, "version"), "3.24.0-5.8.0-20062535e787\n");
    const script = UPGRADE.replaceAll("/etc/ressac-vm-version", join(d, "version")).replaceAll("/etc/alpine-release", join(d, "alpine-release"));
    const launch = (input: string) => new Promise<number>((ok) => {
      const began = Date.now();
      const p = spawn("/bin/sh", [], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["pipe", "ignore", "ignore"] });
      p.on("close", () => ok(Date.now() - began));
      p.stdin.end(input);
    });
    expect(await launch(script)).toBeLessThan(5000); // returns while apk still runs (it waits for the release below)
    await vi.waitFor(() => expect(existsSync(join(d, "apk.running"))).toBe(true));
    expect(await launch(script)).toBeLessThan(5000);
    expect(readFileSync(join(d, "version"), "utf8").trim()).toBe("3.24.0-5.8.0-20062535e787");
    writeFileSync(join(d, "release"), "");
    await vi.waitFor(() => expect(readFileSync(join(d, "version"), "utf8").trim()).toBe("3.24.4-5.8.10-20062535e787"), { timeout: 3000 });
    expect(readFileSync(join(d, "apk.log"), "utf8")).toBe("upgrade --no-cache\n");
  });
});

describe("engineCopy", () => {
  it("copies the shipped engine once to <dataDir>/engine-<content hash>, a new content to a new folder; a failed copy falls back to the shipped one", async () => {
    const d = mkdtempSync(join(tmpdir(), "e-"));
    dirs.push(d);
    const shipped = join(d, "shipped");
    mkdirSync(join(shipped, "blocks"), { recursive: true });
    writeFileSync(join(shipped, "harvester.mjs"), "a");
    writeFileSync(join(shipped, "blocks", "x.mjs"), "b");
    const data = join(d, "data");
    const first = engineCopy(shipped, data);
    expect(first).toMatch(/\/engine-[0-9a-f]{12}$/);
    expect(readFileSync(join(first, "blocks", "x.mjs"), "utf8")).toBe("b");
    writeFileSync(join(first, "marker"), ""); // a second launch of the same build leaves it as it is (mounted by a VM that survived)
    expect(engineCopy(shipped, data)).toBe(first);
    expect(existsSync(join(first, "marker"))).toBe(true);
    writeFileSync(join(shipped, "harvester.mjs"), "a2");
    const second = engineCopy(shipped, data);
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true); // the running machine may mount it: deleted at a later boot
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(join(d, "file"), "");
      expect(engineCopy(shipped, join(d, "file"))).toBe(shipped);
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
});

describe("vmImage", () => {
  it("the pinned image unless RESSAC_VM_IMAGE_URL and RESSAC_VM_IMAGE_SHA256 are both set", async () => {
    const { vmImage } = await import("../host/machine");
    expect(vmImage({})).toBe(VM_IMAGE);
    expect(vmImage({ RESSAC_VM_IMAGE_URL: "file:///x.raw.zst" })).toBe(VM_IMAGE);
    // The packaged app (its host runs with RESSAC_KERNEL_RESOURCES) only ever takes the pinned image.
    expect(vmImage({ RESSAC_KERNEL_RESOURCES: "/App/k", RESSAC_VM_IMAGE_URL: "file:///x.raw.zst", RESSAC_VM_IMAGE_SHA256: "ff" })).toBe(VM_IMAGE);
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
