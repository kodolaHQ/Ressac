import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

describe("package scripts", () => {
  it("builds the three bundles before surfer import, build and build:ui", () => {
    for (const s of ["engine:import", "build", "build:ui"]) expect(scripts[s]).toMatch(/^zsh scripts\/ui\.sh && /);
    expect(readFileSync(new URL("../scripts/ui.sh", import.meta.url), "utf8")).toMatch(/for mode in sidebar window store/);
  });
});
