import { describe, expect, it } from "vitest";
import type { HomeTheme } from "../../../packages/kernel/src/home/theme";
import { variablesTheme } from "../ui/theme";

describe("variablesTheme", () => {
  it("only returns #rrggbb and ignores a missing key", () => {
    const v = variablesTheme({ version: 1, background: "#1e1e22", accent: "#8b7cf6" });
    expect(v).toEqual({ "--accueil-fond": "#1e1e22", "--accueil-accent": "#8b7cf6" });
    for (const value of Object.values(v)) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("returns the radius, the space and the font in CSS units", () => {
    expect(variablesTheme({ version: 1, radius: 12, space: 8, font: "serif" })).toEqual({
      "--accueil-rayon": "12px",
      "--accueil-espace": "8px",
      "--accueil-police": "serif",
    });
  });

  it("ignores an invalid color and a missing theme", () => {
    expect(variablesTheme({ version: 1, background: "red", card: "#12345" } as HomeTheme)).toEqual({});
    expect(variablesTheme(null)).toEqual({});
  });

  it("does not accept a prototype key as a font", () => {
    expect(variablesTheme({ version: 1, font: "toString" } as unknown as HomeTheme)).toEqual({});
  });
});
