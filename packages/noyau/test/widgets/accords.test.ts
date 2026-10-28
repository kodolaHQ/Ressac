import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeclarationWidget } from "../../src/accueil/schemas.js";
import { accordValide, accorder, lireAccords, retirerAccord } from "../../src/widgets/accords.js";
import { dossierTemporaire } from "../aide/temporaire.js";

const declaration = (compte: string[], publiques: string[]) =>
  DeclarationWidget.parse({
    nom: "W",
    tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } },
    sources: { compte, publiques },
  });

describe("accords", () => {
  it("accorder puis lireAccords, retirerAccord", async () => {
    const d = await dossierTemporaire();
    expect(await lireAccords(d)).toEqual({});
    await accorder(d, "daily", { domaines: ["app.daily.dev"], publiques: [], profil: "p1" });
    await accorder(d, "autre", { domaines: ["a.fr"], publiques: ["b.fr"], profil: "p2" });
    expect(await lireAccords(d)).toEqual({
      daily: { domaines: ["app.daily.dev"], publiques: [], profil: "p1" },
      autre: { domaines: ["a.fr"], publiques: ["b.fr"], profil: "p2" },
    });
    expect(JSON.parse(await readFile(join(d, "accords.json"), "utf8")).daily.profil).toBe("p1");
    await retirerAccord(d, "daily");
    expect(Object.keys(await lireAccords(d))).toEqual(["autre"]);
  });

  it("des écritures simultanées ne se perdent pas", async () => {
    const d = await dossierTemporaire();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => accorder(d, `w${i}`, { domaines: ["a.fr"], publiques: [], profil: "p" })),
    );
    expect(Object.keys(await lireAccords(d)).sort()).toHaveLength(10);
  });

  it("un fichier abîmé ou des entrées invalides sont ignorés", async () => {
    const d = await dossierTemporaire();
    await writeFile(join(d, "accords.json"), "{pas du json");
    expect(await lireAccords(d)).toEqual({});
    await writeFile(join(d, "accords.json"), JSON.stringify({ ok: { domaines: ["a.fr"], publiques: [], profil: "p" }, ko: { profil: 3 } }));
    expect(Object.keys(await lireAccords(d))).toEqual(["ok"]);
  });

  it("un id invalide est refusé", async () => {
    const d = await dossierTemporaire();
    await expect(accorder(d, "../x", { domaines: [], publiques: [], profil: "p" })).rejects.toThrow();
    await expect(retirerAccord(d, "../x")).rejects.toThrow();
  });

  it("un accord dont les domaines ne correspondent plus à la déclaration n'est plus valide", () => {
    const accord = { domaines: ["app.daily.dev", "b.fr"], publiques: ["x.fr"], profil: "p" };
    expect(accordValide(declaration(["b.fr", "app.daily.dev"], ["x.fr"]), accord)).toBe(true);
    expect(accordValide(declaration(["app.daily.dev"], ["x.fr"]), accord)).toBe(false);
    expect(accordValide(declaration(["app.daily.dev", "b.fr", "c.fr"], ["x.fr"]), accord)).toBe(false);
    expect(accordValide(declaration(["app.daily.dev", "b.fr"], ["x.fr", "y.fr"]), accord)).toBe(false);
    expect(accordValide(declaration(["app.daily.dev", "b.fr"], []), accord)).toBe(false);
    expect(accordValide(declaration(["app.daily.dev", "b.fr"], ["x.fr"]), undefined)).toBe(false);
  });
});
