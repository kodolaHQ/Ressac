import { describe, expect, it } from "vitest";
import { maskedRuns, maskText, type MaskedRun } from "../../src/mask/mask.js";
import type { PassportEntry } from "../../src/mask/passport-fields.js";
import { PassportStore } from "../../src/mask/passport.js";
import { LabelTable } from "../../src/mask/table.js";
import { iban, PHONE } from "./values.js";

const IBAN = iban("3000" + "6000" + "0112" + "3456" + "7890" + "189");
const L = "⟨[a-z]+-[a-z0-9]{8}⟩";
const created = "2026-11-23T10:00:00.000Z";
const camille: PassportEntry = { id: "0000000000000001", field: "nom", value: { given: "Camille", family: "Aubrac" }, variants: [], origins: [], how: "typed", created, updated: created };

function table(): LabelTable {
  const s = new PassportStore();
  s.replace("perso", [camille]);
  return new LabelTable({ resolvable: true, passport: s });
}
const ctx = (t: LabelTable, zone: "sources" | "web") => ({ table: t, zone, origin: "https://banque.example" });
const TEXT = `Virement de Camille Aubrac sur ${IBAN}, rappel au ${PHONE}.`;
const at = (text: string, r: MaskedRun) => text.slice(r.start, r.end);
const escape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

/** Every run of `text` replaced by one label, in order: what maskText must give. */
const expected = (text: string, runs: MaskedRun[]) => {
  let re = "^";
  let k = 0;
  for (const r of runs) {
    re += escape(text.slice(k, r.start)) + L;
    k = r.end;
  }
  return new RegExp(re + escape(text.slice(k)) + "$", "u");
};

describe("maskedRuns", () => {
  it("finds the IBAN and phone in both zones, the passport name only in the sources", () => {
    const src = maskedRuns(TEXT, ctx(table(), "sources"));
    expect(src.map((r) => [at(TEXT, r), r.type])).toEqual([["Camille Aubrac", "nom"], [IBAN, "iban"], [PHONE, "tel"]]);
    const web = maskedRuns(TEXT, ctx(table(), "web"));
    // The web zone masks high-risk shapes only: the IBAN; a phone is a sources type.
    expect(web.map((r) => [at(TEXT, r), r.type])).toEqual([[IBAN, "iban"]]);
  });

  it("issues no label", () => {
    const t = table();
    maskedRuns(TEXT, ctx(t, "sources"));
    maskedRuns(TEXT, ctx(t, "web"));
    expect(t.entries("sources")).toHaveLength(0);
    expect(t.entries("web")).toHaveLength(0);
    expect(t.touched).toBe(false);
  });

  it("gives exactly the spans maskText labels, in both zones", () => {
    const texts = [
      TEXT,
      // A value found once, then in another of its forms: maskText's lookup gains it mid-call.
      `IBAN ${IBAN}, soit le compte ${IBAN.slice(4)} ; ${PHONE} ou +33${PHONE.slice(1)}.`,
    ];
    for (const zone of ["sources", "web"] as const)
      for (const text of texts) {
        const t = table();
        const runs = maskedRuns(text, ctx(t, zone));
        expect(maskText(text, ctx(t, zone))).toMatch(expected(text, runs));
      }
  });

  it("gives runs on the original offsets when private-use characters are stripped before masking", () => {
    const text = `\uE000x\uE001 ${IBAN} et Camille Aubrac`;
    expect(maskedRuns(text, ctx(table(), "sources")).map((r) => at(text, r))).toEqual([IBAN, "Camille Aubrac"]);
  });

  it("keeps a label already in the text out of every run", () => {
    const t = table();
    const masked = maskText(`IBAN ${IBAN}`, ctx(t, "sources"));
    const text = `${masked} et ${PHONE}`;
    expect(maskedRuns(text, ctx(t, "sources")).map((r) => at(text, r))).toEqual([PHONE]);
  });
});
