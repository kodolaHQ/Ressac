import { describe, it, expect } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { approveReads, readReads, readsCovered, readsUnrestricted, removeReads, seedReads } from "../../src/widgets/reads.js";
import { tempFolder } from "../helpers/temp.js";

const decl = (publics: string[], web = false) => ({ sources: { public: publics, web } });

describe("reads", () => {
  it("readsCovered: subset of the approved domains, web only if approved, nothing to read is covered", () => {
    expect(readsCovered(decl([]))).toBe(true);
    expect(readsCovered(decl(["a.fr"]))).toBe(false);
    expect(readsCovered(decl(["a.fr"]), { public: ["a.fr", "b.fr"], web: false })).toBe(true);
    expect(readsCovered(decl(["a.fr", "c.fr"]), { public: ["a.fr", "b.fr"], web: false })).toBe(false);
    expect(readsCovered(decl([], true), { public: [], web: false })).toBe(false);
    expect(readsCovered(decl(["a.fr"], true), { public: ["a.fr"], web: true })).toBe(true);
    expect(readsCovered(decl([]), { public: [], web: false })).toBe(true);
  });

  it("approveReads, removeReads, damaged entries ignored", async () => {
    const d = await tempFolder();
    await approveReads(d, "w", { public: ["b.fr", "a.fr"], web: true });
    expect(await readReads(d)).toEqual({ w: { public: ["a.fr", "b.fr"], web: true } });
    await removeReads(d, "w");
    expect(await readReads(d)).toEqual({});
    await writeFile(join(d, "reads.json"), JSON.stringify({ ok: { public: [], web: false }, ko: { public: 3 } }));
    expect(Object.keys(await readReads(d))).toEqual(["ok"]);
    await expect(approveReads(d, "../x", { public: [], web: false })).rejects.toThrow();
  });

  it("seeding: no-account owners present keep any host (web), account owners get nothing, only once", async () => {
    const d = await tempFolder();
    await seedReads(d, [{ id: "w", sources: { account: [], public: ["a.fr"] } }, { id: "c", sources: { account: ["b.fr"], public: [] } }]);
    expect(await readReads(d)).toEqual({ w: { public: ["a.fr"], web: true } });
    expect(await readsUnrestricted(d, "w", { sources: { account: [] } })).toBe(true);
    expect(await readsUnrestricted(d, "w", { sources: { account: ["a.fr"] } })).toBe(false);
    expect(await readsUnrestricted(d, "new", { sources: { account: [] } })).toBe(false);
    expect(await readsUnrestricted(d, "new", { sources: { account: [], web: true } })).toBe(true);
    await rm(join(d, "reads.json"));
    await seedReads(d, [{ id: "w", sources: { account: [], public: ["a.fr"] } }]);
    expect(await readReads(d)).toEqual({});
  });

  it("seeding keeps the entries already there and adds the others", async () => {
    const d = await tempFolder();
    await approveReads(d, "x", { public: ["x.fr"], web: false });
    await seedReads(d, [{ id: "w", sources: { account: [], public: ["a.fr"] } }, { id: "x", sources: { account: [], public: ["y.fr"] } }]);
    expect(await readReads(d)).toEqual({ x: { public: ["x.fr"], web: false }, w: { public: ["a.fr"], web: true } });
  });
});
