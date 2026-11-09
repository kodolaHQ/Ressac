import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeclarationWidget } from "../../src/accueil/schemas.js";
import { DeclarationAction } from "../../src/actions/schemas.js";
import { grantValid, accorder, lireAccords, retirerAccord } from "../../src/widgets/accords.js";
import { tempFolder } from "../aide/temporaire.js";

const declaration = (account: string[], publics: string[]) =>
  DeclarationWidget.parse({
    nom: "W",
    tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } },
    sources: { compte: account, publiques: publics },
  });

describe("grants", () => {
  it("accorder then lireAccords, retirerAccord", async () => {
    const d = await tempFolder();
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

  it("simultaneous writes are not lost", async () => {
    const d = await tempFolder();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => accorder(d, `w${i}`, { domaines: ["a.fr"], publiques: [], profil: "p" })),
    );
    expect(Object.keys(await lireAccords(d)).sort()).toHaveLength(10);
  });

  it("a damaged file or invalid entries are ignored", async () => {
    const d = await tempFolder();
    await writeFile(join(d, "accords.json"), "{pas du json");
    expect(await lireAccords(d)).toEqual({});
    await writeFile(join(d, "accords.json"), JSON.stringify({ ok: { domaines: ["a.fr"], publiques: [], profil: "p" }, ko: { profil: 3 } }));
    expect(Object.keys(await lireAccords(d))).toEqual(["ok"]);
  });

  it("an invalid id is refused", async () => {
    const d = await tempFolder();
    await expect(accorder(d, "../x", { domaines: [], publiques: [], profil: "p" })).rejects.toThrow();
    await expect(retirerAccord(d, "../x")).rejects.toThrow();
  });

  it("a grant whose domains no longer match the declaration is no longer valid", () => {
    const accord = { domaines: ["app.daily.dev", "b.fr"], publiques: ["x.fr"], profil: "p" };
    expect(grantValid(declaration(["b.fr", "app.daily.dev"], ["x.fr"]), accord)).toBe(true);
    expect(grantValid(declaration(["app.daily.dev"], ["x.fr"]), accord)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr", "c.fr"], ["x.fr"]), accord)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr"], ["x.fr", "y.fr"]), accord)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr"], []), accord)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr"], ["x.fr"]), undefined)).toBe(false);
  });

  it("accordValide accepts any declaration that has sources (widget or action)", () => {
    const action = DeclarationAction.parse({ nom: "A", sources: { compte: ["gitlab.com"], publiques: ["x.fr"] } });
    const accord = { domaines: ["gitlab.com"], publiques: ["x.fr"], profil: "p" };
    expect(grantValid(action, accord)).toBe(true);
    expect(grantValid(action, { ...accord, domaines: ["autre.fr"] })).toBe(false);
    expect(grantValid(action)).toBe(false);
  });
});
