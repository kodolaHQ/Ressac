import { describe, it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeclarationWidget } from "../../src/home/schemas.js";
import { DeclarationAction } from "../../src/actions/schemas.js";
import { grantValid, giveGrant, readGrants, removeGrant } from "../../src/widgets/grants.js";
import { tempFolder } from "../helpers/temp.js";

const declaration = (account: string[], publics: string[]) =>
  DeclarationWidget.parse({
    name: "W",
    sizes: { min: { w: 1, h: 1 }, max: { w: 4, h: 4 }, default: { w: 2, h: 2 } },
    sources: { account: account, public: publics },
  });

describe("grants", () => {
  it("accorder then readGrants, removeGrant", async () => {
    const d = await tempFolder();
    expect(await readGrants(d)).toEqual({});
    await giveGrant(d, "daily", { domains: ["app.daily.dev"], public: [], profile: "p1" });
    await giveGrant(d, "autre", { domains: ["a.fr"], public: ["b.fr"], profile: "p2" });
    expect(await readGrants(d)).toEqual({
      daily: { domains: ["app.daily.dev"], public: [], profile: "p1" },
      autre: { domains: ["a.fr"], public: ["b.fr"], profile: "p2" },
    });
    expect(JSON.parse(await readFile(join(d, "grants.json"), "utf8")).daily.profile).toBe("p1");
    await removeGrant(d, "daily");
    expect(Object.keys(await readGrants(d))).toEqual(["autre"]);
  });

  it("simultaneous writes are not lost", async () => {
    const d = await tempFolder();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => giveGrant(d, `w${i}`, { domains: ["a.fr"], public: [], profile: "p" })),
    );
    expect(Object.keys(await readGrants(d)).sort()).toHaveLength(10);
  });

  it("a damaged file or invalid entries are ignored", async () => {
    const d = await tempFolder();
    await writeFile(join(d, "grants.json"), "{pas du json");
    expect(await readGrants(d)).toEqual({});
    await writeFile(join(d, "grants.json"), JSON.stringify({ ok: { domains: ["a.fr"], public: [], profile: "p" }, ko: { profile: 3 } }));
    expect(Object.keys(await readGrants(d))).toEqual(["ok"]);
  });

  it("an invalid id is refused", async () => {
    const d = await tempFolder();
    await expect(giveGrant(d, "../x", { domains: [], public: [], profile: "p" })).rejects.toThrow();
    await expect(removeGrant(d, "../x")).rejects.toThrow();
  });

  it("a grant whose domains no longer match the declaration is no longer valid", () => {
    const grant = { domains: ["app.daily.dev", "b.fr"], public: ["x.fr"], profile: "p" };
    expect(grantValid(declaration(["b.fr", "app.daily.dev"], ["x.fr"]), grant)).toBe(true);
    expect(grantValid(declaration(["app.daily.dev"], ["x.fr"]), grant)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr", "c.fr"], ["x.fr"]), grant)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr"], ["x.fr", "y.fr"]), grant)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr"], []), grant)).toBe(false);
    expect(grantValid(declaration(["app.daily.dev", "b.fr"], ["x.fr"]), undefined)).toBe(false);
  });

  it("grantValid accepts any declaration that has sources (widget or action)", () => {
    const action = DeclarationAction.parse({ name: "A", sources: { account: ["gitlab.com"], public: ["x.fr"] } });
    const grant = { domains: ["gitlab.com"], public: ["x.fr"], profile: "p" };
    expect(grantValid(action, grant)).toBe(true);
    expect(grantValid(action, { ...grant, domains: ["autre.fr"] })).toBe(false);
    expect(grantValid(action)).toBe(false);
  });
});
