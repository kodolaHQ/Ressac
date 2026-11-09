import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
// Built in two parts so this file does not match itself.
const NAME = ["tho", "mas"].join("");

test("no file under apps/, packages/ or scripts/ names the owner", (ctx) => {
  const r = spawnSync("git", ["grep", "-il", NAME, "--", "apps", "packages", "scripts"], { cwd: repoRoot, encoding: "utf8" });
  // git grep exits 1 when nothing matches; no git (or not a checkout) means nothing to check.
  if (r.error || (r.status !== 0 && r.status !== 1)) return ctx.skip();
  expect(r.stdout.trim()).toBe("");
});
