import { describe, expect, it } from "vitest";
import { catalogText, BUILTIN_COMPONENTS } from "../../src/pages/catalog.js";

describe("catalog of built-in components", () => {
  it("each built-in component has a description and at least one required property or children", () => {
    for (const c of BUILTIN_COMPONENTS) {
      expect(c.origin).toBe("builtin");
      expect(c.description.length).toBeGreaterThan(0);
      const required = Object.values(c.properties).some((p) => p.required);
      expect(required || ["columns", "paragraph", "tags"].includes(c.name), c.name).toBe(true);
    }
    expect(BUILTIN_COMPONENTS.map((c) => c.name)).toEqual([
      "title", "paragraph", "callout", "figure", "figures", "list", "cards", "table", "fields", "tags", "link", "group", "columns",
    ]);
  });

  it("catalogText cites table, its columns and « requis »", () => {
    const t = catalogText(BUILTIN_COMPONENTS);
    const line = t.split("\n").find((l) => l.startsWith("table"))!;
    expect(line).toContain("columns [{field, label}] ≤8");
    expect(line).toContain("requis");
  });

  it("catalogText of the whole catalog is under 4,000 characters", () => {
    expect(catalogText(BUILTIN_COMPONENTS).length).toBeLessThan(4000);
  });

  it("catalogText states the one-or-the-other rules and the limits", () => {
    const t = catalogText(BUILTIN_COMPONENTS);
    expect(t).toContain("text OU value");
    expect(t).toContain("values OU items + field");
    expect(t).toContain("text OU textField");
    expect(t).toContain("figures [{value: référence, label}] ≤6");
    expect(t).toContain("text ≤80");
  });
});
