import { describe, expect, it } from "vitest";
import { catalogText, BUILTIN_COMPONENTS } from "../../src/pages/catalogue.js";

describe("catalog of built-in components", () => {
  it("each built-in component has a description and at least one required property or children", () => {
    for (const c of BUILTIN_COMPONENTS) {
      expect(c.origine).toBe("integre");
      expect(c.description.length).toBeGreaterThan(0);
      const required = Object.values(c.proprietes).some((p) => p.requis);
      expect(required || ["colonnes", "paragraphe", "etiquettes"].includes(c.nom), c.nom).toBe(true);
    }
    expect(BUILTIN_COMPONENTS.map((c) => c.nom)).toEqual([
      "titre", "paragraphe", "encadre", "chiffre", "chiffres", "liste", "cartes", "tableau", "champs", "etiquettes", "lien", "groupe", "colonnes",
    ]);
  });

  it("catalogText cites table, its columns and « requis »", () => {
    const t = catalogText(BUILTIN_COMPONENTS);
    const line = t.split("\n").find((l) => l.startsWith("tableau"))!;
    expect(line).toContain("colonnes [{champ, libelle}] ≤8");
    expect(line).toContain("requis");
  });

  it("catalogText of the whole catalog is under 4,000 characters", () => {
    expect(catalogText(BUILTIN_COMPONENTS).length).toBeLessThan(4000);
  });

  it("catalogText states the one-or-the-other rules and the limits", () => {
    const t = catalogText(BUILTIN_COMPONENTS);
    expect(t).toContain("texte OU valeur");
    expect(t).toContain("valeurs OU elements + champ");
    expect(t).toContain("texte OU champTexte");
    expect(t).toContain("chiffres [{valeur: référence, libelle}] ≤6");
    expect(t).toContain("texte ≤80");
  });
});
