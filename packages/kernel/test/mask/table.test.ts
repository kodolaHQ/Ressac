import { describe, expect, it } from "vitest";
import { maskText } from "../../src/mask/mask.js";
import { PassportStore } from "../../src/mask/passport.js";
import { LabelTable } from "../../src/mask/table.js";
import { CODE } from "./values.js";

const LABEL = /^⟨[a-z]+-[a-z0-9]{8}⟩$/;

describe("LabelTable", () => {
  it("gives one label per canonical value in the sources, origins accumulating", () => {
    const t = new LabelTable({ resolvable: true });
    const a = t.label("code", CODE, "sources", "https://mail.example");
    expect(t.label("code", CODE, "sources", "https://banque.example")).toBe(a);
    expect(t.resolve(a)).toMatchObject({ type: "code", value: CODE, zone: "sources", origins: ["https://mail.example", "https://banque.example"] });
    expect(t.label("id", CODE, "sources", null)).not.toBe(a);
  });

  it("gives one label per origin in the web zone, never a sources label", () => {
    const t = new LabelTable();
    const src = t.label("code", CODE, "sources", "https://mail.example");
    const w1 = t.label("code", CODE, "web", "https://a.example");
    const w2 = t.label("code", CODE, "web", "https://b.example");
    expect(new Set([src, w1, w2]).size).toBe(3);
    expect(t.label("code", CODE, "web", "https://a.example")).toBe(w1);
    expect(t.entries("web").map((e) => e.label)).toEqual([w1, w2]);
    expect(t.entries("sources").map((e) => e.label)).toEqual([src]);
  });

  it("never gives a web line the label the mail's code got (ECB)", () => {
    const t = new LabelTable();
    const mail = maskText(`Votre code : ${CODE}`, { table: t, zone: "sources", origin: "https://mail.example" });
    const [mailLabel] = mail.match(/⟨code-[a-z0-9]{8}⟩/)!;
    const page = maskText(`ligne ${CODE} : code ${CODE}`, { table: t, zone: "web", origin: "https://piege.example" });
    expect(page).not.toContain(mailLabel);
    expect(page).not.toContain(CODE);
    const labels = page.match(/⟨code-[a-z0-9]{8}⟩/g)!;
    expect(labels).toHaveLength(2);
    expect(labels[0]).toBe(labels[1]);
  });

  it("draws well-formed random labels", () => {
    const t = new LabelTable();
    const labels = Array.from({ length: 1000 }, (_, i) => t.label("tel", "+3361234" + String(i).padStart(4, "0"), "sources", null));
    for (const l of labels) expect(l).toMatch(LABEL);
    expect(new Set(labels).size).toBe(1000);
  });

  it("redraws on a collision", () => {
    let calls = 0;
    const random = (n: number) => new Uint8Array(n).fill(calls++ < 2 ? 0 : 1);
    const t = new LabelTable({ random });
    const a = t.label("code", "1111", "sources", null);
    const b = t.label("code", "2222", "sources", null);
    expect(a).toBe("⟨code-aaaaaaaa⟩");
    expect(b).toBe("⟨code-bbbbbbbb⟩");
    expect(calls).toBe(3);
  });

  it("issues labels it cannot resolve when not resolvable", () => {
    const t = new LabelTable();
    const a = t.label("iban", "FR00", "sources", null);
    expect(t.issued(a)).toBe(true);
    expect(t.resolve(a)).toBeUndefined();
    expect(t.issued("⟨iban-zzzzzzzz⟩")).toBe(false);
    t.wipe();
    expect(t.issued(a)).toBe(false);
    expect(t.entries("sources")).toEqual([]);
  });
  it("links an entry to every passport entry it was drawn for, once each", () => {
    const t = new LabelTable({ resolvable: true });
    const a = t.label("nom", "camille exemplaire", "sources", null, "Camille Exemplaire", { profile: "p1", id: "a" });
    expect(t.label("nom", "camille exemplaire", "sources", null, "Camille Exemplaire", { profile: "p2", id: "b" })).toBe(a);
    t.label("nom", "camille exemplaire", "sources", null, "Camille Exemplaire", { profile: "p1", id: "a" });
    expect(t.resolve(a)?.passport).toEqual([{ profile: "p1", id: "a" }, { profile: "p2", id: "b" }]);
    expect(t.resolve(t.label("code", "1234", "sources", null))?.passport).toBeUndefined();
  });

  it("is untouched when new and knows the store it was given", () => {
    const passport = new PassportStore();
    expect(new LabelTable().touched).toBe(false);
    expect(new LabelTable().passport).toBeUndefined();
    expect(new LabelTable({ passport }).passport).toBe(passport);
  });
});
