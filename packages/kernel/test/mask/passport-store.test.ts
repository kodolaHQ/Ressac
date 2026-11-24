import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { validatePassport, type PassportEntry, type PassportField, type PassportValue } from "../../src/mask/passport-fields.js";
import { PassportStore } from "../../src/mask/passport.js";

let n = 0;
const entry = (field: PassportField, value: PassportValue, extra: Partial<PassportEntry> = {}): PassportEntry => ({
  id: (++n).toString(16).padStart(16, "0"),
  field,
  value,
  variants: [],
  origins: [],
  how: "typed",
  created: "2026-11-23T10:00:00.000Z",
  updated: "2026-11-23T10:00:00.000Z",
  ...extra,
});

const name = () => entry("nom", { given: "Camille", family: "Exemplaire" }, { origins: ["ameli.fr"] });
const address = () => entry("adresse", { text: "14 rue des Tanneurs\n69005 Lyon" });

describe("PassportStore", () => {
  it("keeps a profile's entries as replaced", () => {
    const s = new PassportStore();
    const a = name();
    s.replace("p1", [a]);
    expect(s.entries("p1")).toEqual([a]);
    expect(s.entries("p2")).toEqual([]);
    expect(s.get({ profile: "p1", id: a.id })).toBe(a);
    expect(s.get({ profile: "p2", id: a.id })).toBeUndefined();
    expect(s.profiles()).toEqual(["p1"]);
  });

  it("says when a replace adds a search form, not when it only changes origins or removes an entry", () => {
    const s = new PassportStore();
    const a = name();
    const b = address();
    expect(s.replace("p1", [a]).added.length).toBeGreaterThan(0);
    expect(s.replace("p1", [a, b]).added.length).toBeGreaterThan(0);
    expect(s.replace("p1", [{ ...a, origins: ["impots.gouv.fr"] }, b]).added.length).toBe(0);
    expect(s.replace("p1", [b]).added.length).toBe(0);
    expect(s.replace("p1", [b, { ...a, variants: ["Cam Exemplaire"] }]).added.length).toBeGreaterThan(0);
    expect(s.replace("p1", [b, { ...a, variants: ["Cam Exemplaire", "Camille E."] }]).added).toEqual([a.id]);
  });

  it("does not count a move between profiles as new forms", () => {
    const s = new PassportStore();
    const a = name();
    s.replace("p1", [a]);
    expect(s.replace("p2", [a]).added.length).toBe(0);
    s.drop("p1");
    expect(s.entries("p2")).toEqual([a]);
  });

  it("increments its version on every replace and drop", () => {
    const s = new PassportStore();
    const v0 = s.version;
    s.replace("p1", []);
    s.replace("p1", []);
    s.drop("p1");
    expect(s.version).toBe(v0 + 3);
  });

  it("drops an invalid entry and keeps the others", () => {
    const s = new PassportStore();
    const a = name();
    const bad = entry("email", { text: "pas-une-adresse" });
    const b = address();
    s.replace("p1", [a, bad, b]);
    expect(s.entries("p1")).toEqual([a, b]);
  });

  it("refuses a profile id that is not a plain name", () => {
    const s = new PassportStore();
    expect(() => s.replace("../x", [])).toThrow("invalid passport profile");
    expect(() => s.replace("", [])).toThrow("invalid passport profile");
    expect(() => s.replace("a".repeat(65), [])).toThrow("invalid passport profile");
  });

  it("never prints a value", () => {
    const s = new PassportStore();
    s.replace("p1", [name(), address()]);
    for (const out of [JSON.stringify(s), JSON.stringify({ s }), inspect(s), inspect({ s }, { depth: 5 })]) {
      expect(out).toContain("[passeport]");
      for (const v of ["Camille", "Exemplaire", "Tanneurs", "ameli"]) expect(out).not.toContain(v);
    }
  });

  it("is ready at once unless built to await the host", async () => {
    await new PassportStore().ready;
    const s = new PassportStore({ awaitReady: true });
    let ready = false;
    void s.ready.then(() => (ready = true));
    await Promise.resolve();
    expect(ready).toBe(false);
    s.markReady(["p2"]);
    await s.ready;
    expect(s.unreadable()).toEqual(["p2"]);
  });

  it("forgets that a profile was unreadable once it is replaced or dropped", () => {
    const s = new PassportStore();
    s.markReady(["p1", "p2"]);
    s.replace("p1", []);
    s.drop("p2");
    expect(s.unreadable()).toEqual([]);
  });

  it("knows the hosts and origins of every entry", () => {
    const s = new PassportStore();
    s.replace("p1", [name(), entry("adresse", { text: "3 place Bellecour" }, { origins: ["ameli.fr", "impots.gouv.fr"] })]);
    expect(s.origins().hosts().sort()).toEqual(["ameli.fr", "impots.gouv.fr"]);
    expect(s.origins().isOrigin("https://www.ameli.fr/x")).toBe(true);
    expect(s.origins().isOrigin("https://ameli.fr")).toBe(true);
    expect(s.origins().isOrigin("http://ameli.fr/")).toBe(false);
    expect(s.origins().isOrigin("https://compte.ameli.fr/")).toBe(false);
    expect(s.origins().isOrigin("pas une adresse")).toBe(false);
  });

  it("takes http on a loopback host only when told local addresses are allowed", () => {
    const e = entry("adresse", { text: "3 place Bellecour" }, { origins: ["127.0.0.1:5301"] });
    const off = new PassportStore();
    const on = new PassportStore({ localAddresses: true });
    off.replace("p1", [e]);
    on.replace("p1", [e]);
    expect(off.origins().isOrigin("http://127.0.0.1:5301/form")).toBe(false);
    expect(on.origins().isOrigin("http://127.0.0.1:5301/form")).toBe(true);
  });
  it("drops a malformed entry without throwing or printing its value, and keeps the others", () => {
    const secret = ["Camille", "Secret"].join(" ");
    const a = name();
    const base = { ...address() } as Record<string, unknown>;
    const malformed: unknown[] = [
      { ...base, value: secret },
      { ...base, field: "nom", value: { given: secret } },
      { ...base, value: { text: 42 } },
      { ...base, variants: secret },
      { ...base, origins: [secret, 3] },
      { ...base, id: 7 },
      { ...base, field: "inconnu" },
      { ...base, value: null },
      null,
      secret,
    ];
    const s = new PassportStore();
    let out = "";
    try {
      const r = validatePassport(malformed as PassportEntry[]);
      expect(r.dropped.map((d) => d.problems)).toEqual(malformed.map(() => [{ code: "malformed", at: "value" }]));
      out = JSON.stringify(r);
      s.replace("p1", [...(malformed as PassportEntry[]), a]);
    } catch (e) {
      out += String(e);
    }
    expect(s.entries("p1")).toEqual([a]);
    expect(out).not.toContain("Secret");
    expect(() => s.replace("p1", secret as unknown as PassportEntry[])).toThrow(/^invalid passport$/);
  });
});
