import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

// Stands in for updates.getressac.app: only the 0.9.9 MAR is "already published".
let host = "";
const server = createServer((req, res) => {
  res.statusCode = req.url === "/releases/0.9.9/Ressac-0.9.9.mar" ? 200 : 404;
  res.end();
});
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A copy of apps/firefox's layout in a temp dir: publish.sh, package.json, release notes, dist/ and a fake signmar. */
function fixture(o: { version?: string; notes?: string; xml?: string; mar?: boolean; signmarOk?: boolean } = {}) {
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
  writeFileSync(path.join(root, "dist/update.xml"), `<updates>\n  <update type="minor" displayVersion="${o.xml ?? v}" appVersion="159.0.1">\n</updates>\n`);
  const bin = path.join(root, "engine/obj-aarch64-apple-darwin/dist/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "signmar"), `#!/bin/sh\nexit ${o.signmarOk === false ? 1 : 0}\n`);
  chmodSync(path.join(bin, "signmar"), 0o755);
  return root;
}

async function publish(root: string) {
  const env = { ...process.env, RESSAC_PUBLISH_DRY_RUN: "1", RESSAC_PUBLISH_SKIP_APPLE: "1", RESSAC_PUBLISH_HOST: host };
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
  it("is the release:publish script, not pnpm's own publish", () => {
    expect(scripts["release:publish"]).toBe("zsh scripts/env.sh zsh scripts/publish.sh");
    expect(scripts.publish).toBeUndefined();
  });

  it("uploads the MAR, the DMG, the stable DMG, then update.xml last and uncached", async () => {
    const { code, stdout } = await publish(fixture());
    expect(code).toBe(0);
    const puts = stdout.split("\n").filter((l) => l.startsWith("wrangler "));
    expect(puts.map((l) => l.match(/ressac-update\/(\S+)/)?.[1])).toEqual([
      "releases/1.2.3/Ressac-1.2.3.mar",
      "releases/1.2.3/Ressac-1.2.3.dmg",
      "download/Ressac.dmg",
      "updates/browser/Darwin_aarch64-gcc3/ressac/update.xml",
    ]);
    for (const l of puts) expect(l).toMatch(/^wrangler r2 object put .* --remote/);
    expect(puts[3]).toContain("--cache-control no-cache");
    expect(puts[2]).toMatch(/--file \S+\/dist\/Ressac-1\.2\.3\.dmg/);
  });

  const refusals: [string, Parameters<typeof fixture>[0], RegExp][] = [
    ["the MAR is missing", { mar: false }, /Ressac-1\.2\.3\.mar is missing/],
    ["update.xml is for another version", { xml: "1.2.2" }, /update\.xml is not for 1\.2\.3/],
    ["the newest release notes are for another version", { notes: "1.2.2" }, /release-notes\.ts is not 1\.2\.3/],
    ["the MAR's signature does not verify", { signmarOk: false }, /not signed by our key/],
    ["the version is already published", { version: "0.9.9" }, /already be published \(HTTP 200/],
  ];
  for (const [why, o, reason] of refusals) {
    it(`refuses when ${why}`, async () => {
      const { code, stdout, stderr } = await publish(fixture(o));
      expect(code).not.toBe(0);
      expect(stderr).toMatch(reason);
      expect(stdout).not.toMatch(/^wrangler /m);
    });
  }
});
