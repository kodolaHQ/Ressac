import { describe, expect, it } from "vitest";
import { catalogueTexte, COMPOSANTS_INTEGRES } from "../../src/pages/catalogue.js";

describe("catalogue des composants intégrés", () => {
  it("chaque composant intégré a une description et au moins une propriété requise ou des enfants", () => {
    for (const c of COMPOSANTS_INTEGRES) {
      expect(c.origine).toBe("integre");
      expect(c.description.length).toBeGreaterThan(0);
      const requise = Object.values(c.proprietes).some((p) => p.requis);
      expect(requise || ["colonnes", "paragraphe", "etiquettes", "lien", "groupe"].includes(c.nom), c.nom).toBe(true);
    }
    expect(COMPOSANTS_INTEGRES.map((c) => c.nom)).toEqual([
      "titre", "paragraphe", "encadre", "chiffre", "chiffres", "liste", "cartes", "tableau", "champs", "etiquettes", "lien", "groupe", "colonnes",
    ]);
  });

  it("catalogueTexte cite tableau, ses colonnes et « requis »", () => {
    const t = catalogueTexte(COMPOSANTS_INTEGRES);
    const ligne = t.split("\n").find((l) => l.startsWith("tableau"))!;
    expect(ligne).toContain("colonnes");
    expect(ligne).toContain("requis");
  });

  it("catalogueTexte de tout le catalogue fait moins de 4 000 caractères", () => {
    expect(catalogueTexte(COMPOSANTS_INTEGRES).length).toBeLessThan(4000);
  });
});
