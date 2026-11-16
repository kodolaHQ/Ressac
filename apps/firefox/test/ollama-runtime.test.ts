import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BAD_ARCHIVE, NOT_STARTED, OLLAMA_VERSION, createOllamaRuntime, olderThan } from "../host/ollama-runtime";

// A full disk, on demand: the archive's write stream fails like ENOSPC.
const disk = vi.hoisted(() => ({ full: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    createWriteStream: (...a: Parameters<typeof fs.createWriteStream>) =>
      disk.full ? new Writable({ write: (_c, _e, done) => done(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })) }) : fs.createWriteStream(...a),
  };
});

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => (dirs.push(mkdtempSync(join(tmpdir(), "ollama-runtime-"))), dirs.at(-1)!);
const APP = "/Applications/Ollama.app";

/** A fake machine: `version` is what /api/version answers (undefined: nothing listens), `paths` what exists. */
function machine(o: { version?: string; paths?: string[]; managed?: boolean; archive?: Buffer; sha256?: string; startsAfterLaunch?: boolean; stalls?: true }) {
  const dataDir = temp();
  const state = { version: o.version, ran: [] as string[], launched: [] as string[], killed: 0 };
  const paths = new Set(o.paths ?? []);
  const up = () => o.startsAfterLaunch !== false && (state.version ??= "0.40.13");
  const runtime = createOllamaRuntime({
    url: "http://ollama.test",
    dataDir,
    managed: o.managed ?? true,
    pollMs: 1,
    startDelayMs: 50,
    idleMs: 200,
    exists: (p) => paths.has(p) || existsSync(p) && p.startsWith(dataDir),
    fetch: (async (url: string) => {
      if (String(url).endsWith("/api/version")) {
        if (state.version === undefined) throw new Error("refused");
        return new Response(JSON.stringify({ version: state.version }));
      }
      // A network gone silent: one chunk, then nothing, ever.
      if (o.stalls) return new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array(10)) }), { headers: { "content-length": "100" } });
      return new Response(o.archive && new Uint8Array(o.archive), { headers: { "content-length": String(o.archive?.length ?? 0) } });
    }) as typeof fetch,
    run: async (cmd, args) => {
      state.ran.push([cmd, ...args].join(" "));
      if (cmd === "open") up();
      if (cmd !== "tar") return 0;
      try { execFileSync("tar", args); return 0; } catch { return 1; }
    },
    launch: (cmd, args) => (state.launched.push([cmd, ...args].join(" ")), up(), { kill: () => void state.killed++ }),
    archive: { url: "http://ollama.test/archive.tgz", sha256: o.sha256 ?? createHash("sha256").update(o.archive ?? "").digest("hex") },
  });
  return { runtime, state, dataDir, own: join(dataDir, "ollama", OLLAMA_VERSION, "ollama") };
}

/** A tiny archive holding an `ollama` file, like the real one's top level. */
function archive(): Buffer {
  const d = temp();
  mkdirSync(join(d, "in"));
  writeFileSync(join(d, "in", "ollama"), "#!/bin/sh\n");
  execFileSync("tar", ["-czf", join(d, "a.tgz"), "-C", join(d, "in"), "ollama"]);
  return readFileSync(join(d, "a.tgz"));
}

describe("olderThan", () => {
  it("compares version numbers part by part", () => {
    expect(olderThan("0.34.1", "0.40.0")).toBe(true);
    expect(olderThan("0.40.0", "0.40.0")).toBe(false);
    expect(olderThan("0.40.13", "0.40.2")).toBe(false);
    expect(olderThan("1.0", "0.40.0")).toBe(false);
  });
});

describe("the Ollama runtime", () => {
  it("status: ready, outdated, stopped, absent, and unmanaged for another address", async () => {
    expect(await machine({ version: "0.40.13" }).runtime.status()).toEqual({ kind: "ready", version: "0.40.13" });
    expect(await machine({ version: "0.34.1" }).runtime.status()).toEqual({ kind: "outdated", version: "0.34.1", min: "0.40.0" });
    expect(await machine({ paths: [APP] }).runtime.status()).toEqual({ kind: "stopped" });
    expect(await machine({}).runtime.status()).toEqual({ kind: "absent" });
    expect(await machine({ version: "0.40.13", managed: false }).runtime.status()).toEqual({ kind: "unmanaged" });
  });

  it("start opens the installed app, and starts nothing when Ollama already answers", async () => {
    const stopped = machine({ paths: [APP] });
    await stopped.runtime.start();
    expect(stopped.state.ran).toEqual([`open -g --env OLLAMA_CONTEXT_LENGTH=65536 -a ${APP}`]);
    const running = machine({ version: "0.40.13", paths: [APP] });
    await running.runtime.start();
    expect(running.state.ran).toEqual([]);
  });

  it("start runs a command-line install with `serve`, and close stops it", async () => {
    const m = machine({ paths: ["/opt/homebrew/bin/ollama"] });
    await m.runtime.start();
    expect(m.state.launched).toEqual(["/opt/homebrew/bin/ollama serve"]);
    m.runtime.close();
    expect(m.state.killed).toBe(1);
  });

  it("start fails when nothing is installed, or when Ollama never answers", async () => {
    await expect(machine({}).runtime.start()).rejects.toThrow(NOT_STARTED());
    await expect(machine({ paths: [APP], startsAfterLaunch: false }).runtime.start()).rejects.toThrow(NOT_STARTED());
  });

  it("install downloads, checks, unpacks, then serves its own copy", async () => {
    const m = machine({ archive: archive() });
    const seen: (number | null)[] = [];
    await m.runtime.install((p) => seen.push(p));
    expect(existsSync(m.own)).toBe(true);
    expect(seen.at(-1)).toBe(100);
    expect(m.state.launched).toEqual([`${m.own} serve`]);
    expect(await m.runtime.status()).toMatchObject({ kind: "ready" });
  });

  it("a copy left by an older Ressac is still started after a version bump, and an install removes it", async () => {
    const m = machine({ archive: archive() });
    const old = join(m.dataDir, "ollama", "0.30.1", "ollama");
    const older = join(m.dataDir, "ollama", "0.9.0", "ollama");
    for (const p of [old, older]) {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "#!/bin/sh\n");
    }
    expect(await m.runtime.status()).toEqual({ kind: "stopped" });
    await m.runtime.start();
    expect(m.state.launched).toEqual([`${old} serve`]);
    await m.runtime.install(() => {});
    expect([existsSync(m.own), existsSync(old), existsSync(older)]).toEqual([true, false, false]);
  });

  it("install on a full disk rejects and leaves nothing behind, instead of an uncaught error", async () => {
    const m = machine({ archive: archive() });
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    disk.full = true;
    try {
      await expect(m.runtime.install(() => {})).rejects.toThrow("ENOSPC");
    } finally {
      disk.full = false;
      process.off("uncaughtException", onUncaught);
    }
    expect(uncaught).toEqual([]);
    expect(existsSync(join(m.dataDir, "ollama", `${OLLAMA_VERSION}.part`))).toBe(false);
    expect(m.state.launched).toEqual([]);
  });

  it("a download that stalls is dropped after the idle delay and leaves nothing behind", async () => {
    const m = machine({ stalls: true });
    await expect(m.runtime.install(() => {})).rejects.toThrow("Le téléchargement s'est interrompu");
    expect(existsSync(join(m.dataDir, "ollama", `${OLLAMA_VERSION}.part`))).toBe(false);
  });

  it("install refuses an archive whose hash differs and leaves nothing behind", async () => {
    const m = machine({ archive: archive(), sha256: "0".repeat(64) });
    await expect(m.runtime.install(() => {})).rejects.toThrow(BAD_ARCHIVE());
    expect(existsSync(join(m.dataDir, "ollama", OLLAMA_VERSION))).toBe(false);
    expect(existsSync(join(m.dataDir, "ollama", `${OLLAMA_VERSION}.part`))).toBe(false);
    expect(m.state.launched).toEqual([]);
  });
});
