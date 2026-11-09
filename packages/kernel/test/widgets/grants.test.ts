import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeclarationWidget } from "../../src/home/schemas.js";
import { DeclarationAction } from "../../src/actions/schemas.js";
import { grantValid, giveGrant, readGrants, removeGrant } from "../../src/widgets/grants.js";
import { tempFolder } from "../helpers/temp.js";

const declaration = (account: string[], publics: string[]) =>
  DeclarationWidget.parse({
    nom: "W",
    tailles: { min: { l: 1, h: 1 }, max: { l: 4, h: 4 }, defaut: { l: 2, h: 2 } },
    sources: { compte: account, publiques: publics },
  });

describe("grants", () => {
  it("accorder then readGrants, removeGrant", async () => {
    const d = await tempFolder();
    expect(await readGrants(d)).toEqual({});
    await giveGrant(d, "daily", { domaines: ["app.daily.dev"], publiques: [], profil: "p1" });
    await giveGrant(d, "autre", { domaines: ["a.fr"], publiques: ["b.fr"], profil: "p2" });
    expect(await readGrants(d)).toEqual({
      daily: { domaines: ["app.daily.dev"], publiques: [], profil: "p1" },
      autre: { domaines: ["a.fr"], publiques: ["b.fr"], profil: "p2" },
    });
    expect(JSON.parse(await readFile(join(d, "accords.json"), "utf8")).daily.profil).toBe("p1");
    await removeGrant(d, "daily");
    expect(Object.keys(await readGrants(d))).toEqual(["autre"]);
  });

  it("simultaneous writes are not lost", async () => {
    const d = await tempFolder();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => giveGrant(d, `w${i}`, { domaines: ["a.fr"], publiques: [], profil: "p" })),
    );
    expect(Object.keys(await readGrants(d)).sort()).toHaveLength(10);
  });

  it("a damaged file or invalid entries are ignored", async () => {
    const d = await tempFolder();
    await writeFile(join(d, "accords.json"), "{pas du json");
    expect(await readGrants(d)).toEqual({});
    await writeFile(join(d, "accords.json"), JSON.stringify({ ok: { domaines: ["a.fr"], publiques: [], profil: "p" }, ko: { profil: 3 } }));
    expect(Object.keys(await readGrants(d))).toEqual(["ok"]);
  });

  it("an invalid id is refused", async () => {
    const d = await tempFolder();
    await expect(giveGrant(d, "../x", { domaines: [], publiques: [], profil: "p" })).rejects.toThrow();
    await expect(removeGrant(d, "../x")).rejects.toThrow();
  });

  it("a grant whose domains no longer match the declaration is no longer valid", () => {
    const grant = { domaines: ["app.daily.dev", "b.fr"], publiques: ["x.fr"], profil: "p" };
    expect(grantValid(declaration(["b.fr", "app.daily.dev"], ["x.fr"]), grant)).toBe(true);
    expect(grantValid(declaration(["app.daily.dev"], ["x.fr"]), grant)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr", "c.fr"], ["x.fr"]), grant)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr"], ["x.fr", "y.fr"]), grant)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr"], []), grant)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr"], ["x.fr"]), undefined)).toBe(false);
  });

  it("grantValid accepts any declaration that has sources (widget or action)", () => {
    const action = DeclarationAction.parse({ nom: "A", sources: { compte: ["gitlab.com"], publiques: ["x.fr"] } });
    const grant = { domaines: ["gitlab.com"], publiques: ["x.fr"], profil: "p" };
    expect(grantValid(action, grant)).toBe(true);
    expect(grantValid(action, { ...grant, domaines: ["autre.fr"] })).toBe(false);
    expect(grantValid(action)).toBe(false);
  });
});
