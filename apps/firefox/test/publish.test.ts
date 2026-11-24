import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

// Stands in for updates.getressac.app: 0.9.9 is up with the fixture's MAR, 0.9.8 with another one.
const KEY = "k3yk3yk3yk3yk3yk3yk3yk3y";
let host = "";
const published: Record<string, string> = {
  [`/updates/${KEY}/releases/0.9.9/Ressac-0.9.9.mar`]: "mar",
  [`/updates/${KEY}/releases/0.9.8/Ressac-0.9.8.mar`]: "other",
  // The live feed: 0.9.9 and later go on, older stops.
  [`/updates/${KEY}/browser/Darwin_aarch64-gcc3/ressac/update.xml`]: `<updates><update displayVersion="0.9.9" appVersion="160.0"/></updates>`,
};
const server = createServer((req, res) => {
  const body = published[new URL(req.url ?? "/", "http://x").pathname];
  res.statusCode = body === undefined ? 404 : 200;
  res.end(body);
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A copy of apps/firefox's layout in a temp dir: publish.sh, package.json, release notes, dist/ and a fake signmar. */
function fixture(o: { version?: string; notes?: string; xml?: string; xmlKey?: string; mar?: boolean; signmarOk?: boolean } = {}) {
  const v = o.version ?? "1.2.3";
  const root = mkdtempSync(path.join(os.tmpdir(), "ressac-publish-"));
  mkdirSync(path.join(root, "scripts"));
  copyFileSync(new URL("../scripts/publish.sh", import.meta.url), path.join(root, "scripts/publish.sh"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: v }));
  mkdirSync(path.join(root, "shared"));
  writeFileSync(path.join(root, "shared/release-notes.ts"), `export const RELEASE_NOTES = [\n  {\n    version: "${o.notes ?? v}",\n    items: [],\n  },\n  {\n    version: "0.0.1",\n  },\n];\n`);
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, `dist/Ressac-${v}.dmg`), "dmg");
  if (o.mar !== false) writeFileSync(path.join(root, `dist/Ressac-${v}.mar`), "mar");
  writeFileSync(path.join(root, "dist/update.xml"), `<updates>\n  <update type="minor" displayVersion="${o.xml ?? v}" appVersion="159.0.1">\n    <patch type="complete" URL="https://updates.getressac.app/updates/${o.xmlKey ?? KEY}/releases/${v}/Ressac-${v}.mar"/>\n  </update>\n</updates>\n`);
  const bin = path.join(root, "engine/obj-aarch64-apple-darwin/dist/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "signmar"), `#!/bin/sh\nexit ${o.signmarOk === false ? 1 : 0}\n`);
  chmodSync(path.join(bin, "signmar"), 0o755);
  return root;
}

async function publish(root: string, extra: Record<string, string | undefined> = {}) {
  const env = { ...process.env, RESSAC_PUBLISH_DRY_RUN: "1", RESSAC_PUBLISH_SKIP_APPLE: "1", RESSAC_PUBLISH_HOST: host, RESSAC_UPDATE_KEY: KEY, ...extra };
  try {
    const { stdout } = await promisify(execFile)("zsh", [path.join(root, "scripts/publish.sh")], { env });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("publish.sh", () => {
  it("never waits forever on the already-published check", () => {
    expect(readFileSync(new URL("../scripts/publish.sh", import.meta.url), "utf8")).toMatch(/curl --max-time 30 /);
  });

  it("refuses a version older than the live feed's; the same or a newer one goes on", async () => {
    const older = await publish(fixture({ version: "0.9.7" }));
    expect(older.code).not.toBe(0);
    expect(older.stderr).toContain("0.9.9 is live, newer than 0.9.7");
    expect((await publish(fixture({ version: "0.10.0" }))).code).toBe(0);
  });

  it("is the release:publish script, not pnpm's own publish", () => {
    expect(scripts["release:publish"]).toBe("zsh scripts/env.sh zsh scripts/publish.sh");
    expect(scripts.publish).toBeUndefined();
  });

  it("uploads the MAR, the DMG, the latest DMG, then update.xml last and uncached, all under the secret folder", async () => {
    const { code, stdout } = await publish(fixture());
    expect(code).toBe(0);
    const puts = stdout.split("\n").filter((l) => l.startsWith("wrangler "));
    expect(puts.map((l) => l.match(/ressac-update\/(\S+)/)?.[1])).toEqual([
      `updates/${KEY}/releases/1.2.3/Ressac-1.2.3.mar`,
      `updates/${KEY}/releases/1.2.3/Ressac-1.2.3.dmg`,
      `updates/${KEY}/Ressac.dmg`,
      `updates/${KEY}/browser/Darwin_aarch64-gcc3/ressac/update.xml`,
    ]);
    for (const l of puts) expect(l).toMatch(/^wrangler r2 object put .* --remote/);
    expect(puts[3]).toContain("--cache-control no-cache");
    // Cloudflare caches .dmg by default: the stable link must not serve an old version for long.
    expect(puts[2]).toContain("--cache-control public, max-age=300");
    expect(puts[2]).toMatch(/--file \S+\/dist\/Ressac-1\.2\.3\.dmg/);
  });

  const refusals: [string, Parameters<typeof fixture>[0], RegExp, Record<string, string | undefined>?][] = [
    ["the MAR is missing", { mar: false }, /Ressac-1\.2\.3\.mar is missing/],
    ["update.xml is for another version", { xml: "1.2.2" }, /update\.xml is not for 1\.2\.3/],
    ["the newest release notes are for another version", { notes: "1.2.2" }, /release-notes\.ts is not 1\.2\.3/],
    ["the MAR's signature does not verify", { signmarOk: false }, /not signed by our key/],
    ["the version is already published with another MAR", { version: "0.9.8" }, /already published with another MAR/],
    ["update.xml was packaged with another key", { xmlKey: "another0another0another0" }, /another RESSAC_UPDATE_KEY/],
    ["no key is set", {}, /RESSAC_UPDATE_KEY is empty/, { RESSAC_UPDATE_KEY: undefined }],
    ["the key could leave its folder", {}, /24 to 64 lowercase/, { RESSAC_UPDATE_KEY: "../../download/aaaaaaaaaaaaaaaaaaaa" }],
  ];
  for (const [why, o, reason, env] of refusals) {
    it(`refuses when ${why}`, async () => {
      const { code, stdout, stderr } = await publish(fixture(o), env);
      expect(code).not.toBe(0);
      expect(stderr).toMatch(reason);
      expect(stdout).not.toMatch(/^wrangler /m);
    });
  }

  it("resumes a version already up with the same MAR (a retry after a failed upload)", async () => {
    const { code, stdout } = await publish(fixture({ version: "0.9.9" }));
    expect(code).toBe(0);
    expect(stdout.split("\n").filter((l) => l.startsWith("wrangler "))).toHaveLength(4);
  });

  it("ignores the test variables outside a dry run: the Apple checks still run, nothing is uploaded", async () => {
    // A fake npx first on PATH: should the script ever get past the checks, it records the call and uploads nothing.
    const bin = mkdtempSync(path.join(os.tmpdir(), "ressac-npx-"));
    const record = path.join(bin, "called");
    writeFileSync(path.join(bin, "npx"), `#!/bin/sh\necho "$@" > ${record}\nexit 1\n`);
    chmodSync(path.join(bin, "npx"), 0o755);
    const { code, stderr } = await publish(fixture(), { RESSAC_PUBLISH_DRY_RUN: undefined, PATH: `${bin}:${process.env.PATH}` });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/not notarized/);
    expect(existsSync(record)).toBe(false);
    rmSync(bin, { recursive: true, force: true });
  });
});

describe("prune-releases.sh", () => {
  const KEY = "k".repeat(32);
  /** Runs the script against a fake curl that lists `keys` and logs every call (its config on stdin included). */
  async function prune(keys: string[], env: Record<string, string> = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "prune-"));
    const log = path.join(dir, "curl.log");
    const xml = `<ListBucketResult>${keys.map((k) => `<Contents><Key>updates/${KEY}/releases/${k}</Key></Contents>`).join("")}</ListBucketResult>`;
    writeFileSync(path.join(dir, "curl"), `#!/bin/zsh\nprint -r -- "$* | $(cat)" >> ${log}\n[[ " $* " == *" -X DELETE "* ]] || print -r -- '${xml}'\n`);
    chmodSync(path.join(dir, "curl"), 0o755);
    writeFileSync(path.join(dir, "r2.env"), "R2_ACCESS_KEY_ID=id\nR2_SECRET_ACCESS_KEY=secret-value\nR2_ENDPOINT=https://r2.invalid/\n");
    const run = promisify(execFile)("zsh", [new URL("../scripts/prune-releases.sh", import.meta.url).pathname], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RESSAC_UPDATE_KEY: KEY, RESSAC_R2_ENV: path.join(dir, "r2.env"), ...env },
    });
    const { stdout } = await run;
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    rmSync(dir, { recursive: true, force: true });
    return { stdout, calls };
  }
  const KEYS = ["0.1.9/Ressac-0.1.9.mar", "0.1.9/Ressac-0.1.9.dmg", "0.1.10/Ressac-0.1.10.mar", "0.1.24/Ressac-0.1.24.mar", "0.1.25/Ressac-0.1.25.mar", "notes/x.txt", "stray.txt"];

  it("keeps the three newest versions (0.1.10 after 0.1.9), never a folder that is no version; the key never on curl's command line", async () => {
    const { stdout, calls } = await prune(KEYS);
    const deletes = calls.filter((c) => c.includes("-X DELETE")).map((c) => c.split(" | ")[0]!.match(/releases\/(\S+)/)![1]);
    expect(deletes.sort()).toEqual(["0.1.9/Ressac-0.1.9.dmg", "0.1.9/Ressac-0.1.9.mar"]);
    expect(stdout).toMatch(/keeping 0\.1\.25 0\.1\.24 0\.1\.10, deleting 0\.1\.9$/m);
    for (const c of calls) expect(c.split(" | ")[0]).not.toContain("secret-value");
    expect(calls[0]).toContain('user = "id:secret-value"');
  });

  it("a dry run deletes nothing; three versions or fewer, nothing to delete", async () => {
    const dry = await prune(KEYS, { RESSAC_PUBLISH_DRY_RUN: "1" });
    expect(dry.calls.some((c) => c.includes("DELETE"))).toBe(false);
    expect(dry.stdout).toMatch(/^delete ressac-update\/updates\/k+\/releases\/0\.1\.9\/Ressac-0\.1\.9\.mar$/m);
    const few = await prune(KEYS.slice(2, 5));
    expect(few.calls.some((c) => c.includes("DELETE"))).toBe(false);
    expect(few.stdout).toMatch(/nothing to delete/);
  });
});
