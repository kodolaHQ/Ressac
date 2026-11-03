import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

describe("package scripts", () => {
  it("builds the three bundles before surfer import, build and build:ui", () => {
    for (const s of ["engine:import", "build", "build:ui"]) expect(scripts[s]).toMatch(/^zsh scripts\/ui\.sh && /);
    expect(readFileSync(new URL("../scripts/ui.sh", import.meta.url), "utf8")).toMatch(/for mode in sidebar window store/);
  });

  it("prunes dangling links before surfer import", () => {
    expect(scripts["engine:import"]).toMatch(/ui\.sh && zsh scripts\/engine\.sh prune && zsh scripts\/env\.sh surfer import$/);
  });
});

describe("engine.sh prune", () => {
  it("removes only dangling links into a WebAiOs checkout, never obj-*", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "webaios-prune-"));
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(new URL("../scripts/engine.sh", import.meta.url), path.join(root, "scripts/engine.sh"));
    const dir = path.join(root, "engine/browser/base");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(root, "engine/obj-x"));
    writeFileSync(path.join(root, "real.txt"), "");
    const gone = "/nowhere/WebAiOs/.claude/worktrees/old/apps/firefox/src/browser/base/x.js";
    symlinkSync(gone, path.join(dir, "dangling-ours"));
    symlinkSync("/nowhere/other/file", path.join(dir, "dangling-other"));
    symlinkSync(path.join(root, "real.txt"), path.join(dir, "alive"));
    symlinkSync(gone, path.join(root, "engine/obj-x/dangling-build"));
    execFileSync("zsh", [path.join(root, "scripts/engine.sh"), "prune"]);
    const exists = (p: string) => existsSync(p) || (() => { try { return !!lstatSync(p); } catch { return false; } })();
    expect(exists(path.join(dir, "dangling-ours"))).toBe(false);
    expect(exists(path.join(dir, "dangling-other"))).toBe(true);
    expect(exists(path.join(dir, "alive"))).toBe(true);
    expect(exists(path.join(root, "engine/obj-x/dangling-build"))).toBe(true);
  });
});
