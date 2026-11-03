import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

describe("package scripts", () => {
  it("builds the three bundles before surfer import, build and build:ui", () => {
    for (const s of ["engine:import", "build", "build:ui"]) expect(scripts[s]).toMatch(/^zsh scripts\/ui\.sh && /);
    expect(readFileSync(new URL("../scripts/ui.sh", import.meta.url), "utf8")).toMatch(/for mode in sidebar window store agent actor/);
  });

  it("prunes dangling links before surfer import", () => {
    expect(scripts["engine:import"]).toMatch(/ui\.sh && zsh scripts\/engine\.sh prune && zsh scripts\/env\.sh surfer set brand webaios && zsh scripts\/env\.sh surfer import$/);
  });

  it("sets the brand in every checkout before importing or building (surfer keeps it in the untracked .surfer/)", () => {
    for (const s of ["engine:import", "build", "build:ui"]) expect(scripts[s]).toMatch(/surfer set brand webaios && zsh scripts\/env\.sh surfer (import|build)/);
  });
});

describe("agent scaffolding", () => {
  it("builds the agent panel and the page actor", () => {
    const ui = readFileSync(new URL("../scripts/ui.sh", import.meta.url), "utf8");
    const jar = readFileSync(new URL("../src/browser/base/content/webaios/jar.inc.mn", import.meta.url), "utf8");
    for (const m of ["agent", "actor"]) expect(ui).toMatch(new RegExp(`\\b${m}\\b`));
    for (const f of ["agent.html", "agent.js", "agent.css", "page-actor.sys.mjs"]) expect(jar).toContain(`content/webaios/${f})`);
  });

  it("copies the page actor into the build: the content sandbox cannot follow a link into a checkout", () => {
    const jar = readFileSync(new URL("../src/browser/base/content/webaios/jar.inc.mn", import.meta.url), "utf8");
    expect(jar).toMatch(/^\*\s+content\/browser\/webaios\/page-actor\.sys\.mjs/m);
    // `*` runs Mozilla's preprocessor: it needs one directive, and any other line starting with # would be read as one.
    const built = new URL("../src/browser/base/content/webaios/page-actor.sys.mjs", import.meta.url);
    if (existsSync(built)) expect(readFileSync(built, "utf8").match(/^\s*#.*$/gm)).toEqual(["#define WEBAIOS_PAGE_ACTOR"]);
  });
});

describe("engine.sh prune", () => {
  it("removes only dangling links into a WebAiOs checkout, and only under src/'s directories", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "webaios-prune-"));
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "src/browser"), { recursive: true });
    copyFileSync(new URL("../scripts/engine.sh", import.meta.url), path.join(root, "scripts/engine.sh"));
    const dir = path.join(root, "engine/browser/base");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(root, "real.txt"), "");
    const gone = "/nowhere/WebAiOs/.claude/worktrees/old/apps/firefox/src/browser/base/x.js";
    symlinkSync(gone, path.join(dir, "dangling-ours"));
    symlinkSync("/nowhere/other/file", path.join(dir, "dangling-other"));
    symlinkSync(path.join(root, "real.txt"), path.join(dir, "alive"));
    execFileSync("zsh", [path.join(root, "scripts/engine.sh"), "prune"]);
    const exists = (p: string) => existsSync(p) || (() => { try { return !!lstatSync(p); } catch { return false; } })();
    expect(exists(path.join(dir, "dangling-ours"))).toBe(false);
    expect(exists(path.join(dir, "dangling-other"))).toBe(true);
    expect(exists(path.join(dir, "alive"))).toBe(true);
  });

  it("also removes live links into another checkout, so surfer import relinks every file to this one", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "webaios-prune-"));
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "src/browser"), { recursive: true });
    copyFileSync(new URL("../scripts/engine.sh", import.meta.url), path.join(root, "scripts/engine.sh"));
    const dir = path.join(root, "engine/browser/base");
    mkdirSync(dir, { recursive: true });
    const other = mkdtempSync(path.join(os.tmpdir(), "webaios-main-"));
    mkdirSync(path.join(other, "apps/firefox/src"), { recursive: true });
    writeFileSync(path.join(other, "apps/firefox/src/x.js"), "");
    writeFileSync(path.join(root, "src/browser/y.js"), "");
    symlinkSync(path.join(other, "apps/firefox/src/x.js"), path.join(dir, "other-checkout"));
    symlinkSync(path.join(realpathSync(root), "src/browser/y.js"), path.join(dir, "this-checkout"));
    execFileSync("zsh", [path.join(root, "scripts/engine.sh"), "prune"]);
    const exists = (p: string) => { try { return !!lstatSync(p); } catch { return false; } };
    expect(exists(path.join(dir, "other-checkout"))).toBe(false);
    expect(exists(path.join(dir, "this-checkout"))).toBe(true);
  });
});
