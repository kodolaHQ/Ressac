import { describe, expect, it } from "vitest";
import type { ThemeAccueil } from "../../../packages/noyau/src/accueil/theme";
import { variablesTheme } from "../ui/theme";

describe("variablesTheme", () => {
  it("ne rend que des #rrggbb et ignore une clé absente", () => {
    const v = variablesTheme({ version: 1, fond: "#1e1e22", accent: "#8b7cf6" });
    expect(v).toEqual({ "--accueil-fond": "#1e1e22", "--accueil-accent": "#8b7cf6" });
    for (const valeur of Object.values(v)) expect(valeur).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("rend le rayon, l'espace et la police en unités CSS", () => {
    expect(variablesTheme({ version: 1, rayon: 12, espace: 8, police: "serif" })).toEqual({
      "--accueil-rayon": "12px",
      "--accueil-espace": "8px",
      "--accueil-police": "serif",
    });
  });

  it("ignore une couleur invalide et un thème absent", () => {
    expect(variablesTheme({ version: 1, fond: "red", carte: "#12345" } as ThemeAccueil)).toEqual({});
    expect(variablesTheme(null)).toEqual({});
  });

  it("n'accepte pas une clé de prototype comme police", () => {
    expect(variablesTheme({ version: 1, police: "toString" } as unknown as ThemeAccueil)).toEqual({});
  });
});
