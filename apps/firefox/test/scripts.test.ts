import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

describe("package scripts", () => {
  it("builds the UI before surfer import, so the generated sidebar files get linked into engine/", () => {
    expect(scripts["engine:import"]).toMatch(/^vite build && .*surfer import$/);
  });
});
