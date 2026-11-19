import { describe, it, expect } from "vitest";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { approveReads, readReads, readsCovered, readsUnrestricted, removeReads } from "../../src/widgets/reads.js";
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

  it("an unreadable reads.json (EACCES) fails the approval and erases no other one", async () => {
    const d = await tempFolder();
    await approveReads(d, "a", { public: ["a.fr"], web: false });
    await chmod(join(d, "reads.json"), 0o000);
    await expect(approveReads(d, "b", { public: [], web: true })).rejects.toThrow(/EACCES/);
    await chmod(join(d, "reads.json"), 0o600);
    expect(Object.keys(await readReads(d))).toEqual(["a"]);
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
});
