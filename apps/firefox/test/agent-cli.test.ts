import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HashMismatchError } from "../../../packages/kernel/src/index.ts";
import { AGENT_CLIS, createAgentCli } from "../host/agent-cli";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "agent-cli-"));
  dirs.push(d);
  return d;
};

/** A .tgz like the npm platform package: the binary at its member path, plus a file that must not be extracted. */
function fixture(agent: "claude" | "codex", text = `#!/bin/sh\necho ${agent}\n`): string {
  const d = temp();
  const member = join(d, AGENT_CLIS[agent].member);
  mkdirSync(dirname(member), { recursive: true });
  writeFileSync(member, text);
  writeFileSync(join(d, "package", "README.md"), "readme");
  execFileSync("tar", ["-czf", join(d, "a.tgz"), "-C", d, "package"]);
  return join(d, "a.tgz");
}

/** downloadVerified stand-in: copies the fixture to `file`, optionally waiting for `gate`. */
function fakeDownload(archive: string | Record<string, string>, gate?: Promise<void>) {
  return vi.fn(async (o: { url: string; file: string; onPercent: (p: number | null) => void }) => {
    await gate;
    o.onPercent(50);
    mkdirSync(dirname(o.file), { recursive: true });
    copyFileSync(typeof archive === "string" ? archive : archive[o.url]!, o.file);
  });
}

describe("agent CLI download", () => {
  it("ensure installs the binary and the version file", async () => {
    const internal = temp();
    const download = fakeDownload(fixture("claude"));
    const cli = createAgentCli({ internal, download: download as any, env: {} });
    expect(await cli.installed("claude")).toBe(false);
    const percents: (number | null)[] = [];
    await cli.ensure("claude", (p) => percents.push(p));
    const bin = join(internal, "cli", "claude", "claude");
    expect(readFileSync(bin, "utf8")).toContain("echo claude");
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(internal, "cli", "claude", "version"), "utf8")).toBe(AGENT_CLIS.claude.version);
    // One member only, and no archive left behind: the folder holds the binary and its version, nothing else.
    expect(readdirSync(join(internal, "cli", "claude")).sort()).toEqual(["claude", "version"]);
    expect(existsSync(join(internal, "cli", "claude.download"))).toBe(false);
    expect(percents).toContain(50);
    expect(download.mock.calls[0]![0]).toMatchObject({ url: AGENT_CLIS.claude.url, sha256: AGENT_CLIS.claude.sha256, bytes: AGENT_CLIS.claude.bytes });
    expect(await cli.installed("claude")).toBe(true);
    // Installed: no second download.
    await cli.ensure("claude");
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("a hash mismatch leaves nothing on PATH", async () => {
    const internal = temp();
    const download = vi.fn(async (o: { file: string }) => {
      mkdirSync(dirname(o.file), { recursive: true });
      writeFileSync(`${o.file}.part.extra`, "x");
      throw new HashMismatchError();
    });
    const cli = createAgentCli({ internal, download: download as any, env: {} });
    await expect(cli.ensure("claude")).rejects.toThrow(/ne correspond pas|does not match/);
    expect(existsSync(join(internal, "cli", "claude"))).toBe(false);
    expect(existsSync(join(internal, "cli", "claude.download"))).toBe(false);
    expect(await cli.installed("claude")).toBe(false);
  });

  it("an older version is replaced whole", async () => {
    const internal = temp();
    const old = join(internal, "cli", "claude");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "claude"), "old");
    writeFileSync(join(old, "leftover"), "old");
    writeFileSync(join(old, "version"), "0.0.1");
    const cli = createAgentCli({ internal, download: fakeDownload(fixture("claude")) as any, env: {} });
    expect(await cli.installed("claude")).toBe(false);
    await cli.ensure("claude");
    expect(readFileSync(join(old, "claude"), "utf8")).toContain("echo claude");
    expect(existsSync(join(old, "leftover"))).toBe(false);
    expect(await cli.installed("claude")).toBe(true);
  });

  it("only the chosen agent is downloaded", async () => {
    const internal = temp();
    const download = fakeDownload(fixture("claude"));
    const cli = createAgentCli({ internal, download: download as any, env: {} });
    await cli.ensure("claude");
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]![0].url).toBe(AGENT_CLIS.claude.url);
    expect(existsSync(join(internal, "cli", "codex"))).toBe(false);
    expect(await cli.installed("codex")).toBe(false);
  });

  it("codex installs its native binary from the vendor path", async () => {
    const internal = temp();
    const cli = createAgentCli({ internal, download: fakeDownload(fixture("codex")) as any, env: {} });
    await cli.ensure("codex");
    expect(readFileSync(join(internal, "cli", "codex", "codex"), "utf8")).toContain("echo codex");
  });

  it("two ensure calls share one download", async () => {
    const internal = temp();
    let open!: () => void;
    const download = fakeDownload(fixture("claude"), new Promise<void>((r) => (open = r)));
    const cli = createAgentCli({ internal, download: download as any, env: {} });
    const seen: string[] = [];
    const a = cli.ensure("claude", () => seen.push("a"));
    const b = cli.ensure("claude", () => seen.push("b"));
    open();
    await Promise.all([a, b]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("a download left by another version is not resumed", async () => {
    const internal = temp();
    const stale = join(internal, "cli", "claude.download");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "0.0.1.tgz.part"), "old bytes");
    const download = fakeDownload(fixture("claude"));
    await createAgentCli({ internal, download: download as any, env: {} }).ensure("claude");
    expect(existsSync(join(stale, "0.0.1.tgz.part"))).toBe(false);
    expect(await createAgentCli({ internal, env: {} }).installed("claude")).toBe(true);
  });

  it("env overrides (dev only) and RESSAC_TEST_CLI_PRESENT", async () => {
    const internal = temp();
    const download = fakeDownload({ "file:///x.tgz": fixture("codex") });
    const env = { RESSAC_CLI_CODEX_URL: "file:///x.tgz", RESSAC_CLI_CODEX_SHA256: "ab".repeat(32), RESSAC_CLI_CODEX_BYTES: "1000" };
    await createAgentCli({ internal, download: download as any, env }).ensure("codex");
    expect(download.mock.calls[0]![0]).toMatchObject({ url: "file:///x.tgz", sha256: "ab".repeat(32), bytes: 1000 });
    expect(await createAgentCli({ internal: temp(), env: { RESSAC_TEST_CLI_PRESENT: "1" } }).installed("claude")).toBe(true);
    // The packaged host ignores both.
    expect(await createAgentCli({ internal: temp(), env: { RESSAC_TEST_CLI_PRESENT: "1", RESSAC_KERNEL_RESOURCES: "/k" } }).installed("claude")).toBe(false);
  });
  it("a caller's abort or delay ends its wait at once; the shared download goes on for the next call", async () => {
    const internal = temp();
    let open!: () => void;
    const download = fakeDownload(fixture("claude"), new Promise<void>((r) => (open = r)));
    const cli = createAgentCli({ internal, download: download as any, env: {} });
    const abort = new AbortController();
    const aborted = cli.ensure("claude", undefined, { signal: abort.signal, delayMs: 60_000 });
    abort.abort(new Error("stopped"));
    await expect(aborted).rejects.toThrow("stopped");
    await expect(cli.ensure("claude", undefined, { delayMs: 5 })).rejects.toThrow(/encore en cours|still running/);
    const next = cli.ensure("claude");
    open();
    await next;
    expect(download).toHaveBeenCalledTimes(1);
    expect(await cli.installed("claude")).toBe(true);
  });

  it("a link in place of the cli folder is removed, never followed", async () => {
    const internal = temp();
    const outside = temp();
    symlinkSync(outside, join(internal, "cli"));
    await createAgentCli({ internal, download: fakeDownload(fixture("claude")) as any, env: {} }).ensure("claude");
    expect(lstatSync(join(internal, "cli")).isDirectory()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(internal, "cli", "claude", "claude"), "utf8")).toContain("echo claude");
  });

  it("the pinned versions are the Dockerfile's", () => {
    const dockerfile = readFileSync(join(__dirname, "../../../packages/kernel/docker/workshop.Dockerfile"), "utf8");
    expect(/@anthropic-ai\/claude-code@(\S+)/.exec(dockerfile)?.[1]).toBe(AGENT_CLIS.claude.version);
    expect(/@openai\/codex@(\S+)/.exec(dockerfile)?.[1]).toBe(AGENT_CLIS.codex.version);
  });
});
