// Security tests: a variant missed beside its label is a de-anonymisation (spec § 5.3). Once a value was masked in
// the sources, every usual form of it in a later sources text gets the same label and leaves no 4-digit run of it.
import { describe, expect, it } from "vitest";
import type { LabelType } from "../../src/mask/detectors.js";
import { maskText } from "../../src/mask/mask.js";
import { LabelTable } from "../../src/mask/table.js";
import { CARD, CODE, IBAN, PHONE, runs, windows } from "./values.js";

const SRC = { zone: "sources", origin: "https://mail.example" } as const;
const fullwidth = (s: string) => s.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
const spaced4 = (s: string) => s.replace(/(.{4})(?=.)/g, "$1 ");
const unlabelled = (s: string) => s.replace(/⟨[a-z]+-[a-z0-9]{8}⟩/g, " ");

function check(type: LabelType, first: string, value: string, forms: string[], hidden: RegExp[] = []) {
  const table = new LabelTable();
  const masked = maskText(first, { table, ...SRC });
  const label = masked.match(new RegExp(`⟨${type}-[a-z0-9]{8}⟩`))?.[0];
  expect(label, masked).toBeDefined();
  for (const form of forms) {
    const out = maskText(`Plus tard, dans un autre mail : ${form} voilà.`, { table, ...SRC });
    expect(out, form).toContain(label);
    const left = runs(unlabelled(out)).join(" ");
    for (const w of windows(value)) expect(left, `${form} → ${out}`).not.toContain(w);
    for (const re of hidden) expect(unlabelled(out), `${form} → ${out}`).not.toMatch(re);
  }
}

describe("variants", () => {
  it("iban", () =>
    check("iban", `RIB : ${IBAN}`, IBAN, [
      spaced4(IBAN),
      IBAN.replace(/(.{4})(?=.)/g, "$1-"),
      spaced4(IBAN).toLowerCase(),
      fullwidth(spaced4(IBAN)),
      spaced4(IBAN).replaceAll(" ", "%20"),
    ]));

  it("carte", () =>
    check("carte", `carte ${CARD}`, CARD, [spaced4(CARD), CARD, CARD.replace(/(\d{4})(?=\d)/g, "$1."), fullwidth(CARD)]));

  it("tel", () =>
    check("tel", `Tél. ${PHONE}`, PHONE.slice(1), [
      "06 12 34 56 78",
      "+33 6 12 34 56 78",
      "0033 6 12 34 56 78",
      "+33 (0)6 12 34 56 78",
      "06.12.34.56.78",
      "6 12 34 56 78",
      "zéro six douze trente-quatre cinquante-six soixante-dix-huit",
      "zéro six un deux trois quatre cinq six sept huit",
    ]));

  it("email", () =>
    check("email", "écris à t.exemple@exemple.fr", "", ["T.EXEMPLE@EXEMPLE.FR", "t.exemple%40exemple.fr", "T.Exemple@exemple.fr"], [/t\.exemple/i]));

  it("code", () =>
    check("code", `Votre code : ${CODE}`, CODE, [
      CODE,
      "381 624",
      "trois cent quatre-vingt-un six cent vingt-quatre",
      "trois huit un six deux quatre",
      fullwidth(CODE),
    ]));

  it("nom", () =>
    check("nom", "De : Hélène Dupré <h.dupre@exemple.fr>", "", ["Hélène Dupré", "Helene Dupre", "HÉLÈNE DUPRÉ", "He\u0301le\u0300ne Dupre\u0301"], [
      /h[ée\u0301\u0300]+l/i,
      /dupr/i,
    ]));

  it("nom in reversed, comma and initial forms", () =>
    check("nom", "De : Camille Exemple <c.exemple@exemple.fr>", "", ["EXEMPLE Camille", "Exemple Camille", "Exemple, Camille", "C. Exemple", "Exemple C.", "C Exemple", "Exemple, CAMILLE", "Exemple,Camille", "Camille, Exemple"], [/exemple(?!@)/i]));

  it("nom with a hyphenated first name as initials", () =>
    check("nom", "De : Jean-Pierre Dupont <jp.dupont@exemple.fr>", "", ["Jean Pierre Dupont", "J.-P. Dupont", "JP Dupont", "J-P Dupont", "Dupont J.-P."], [
      /dupont(?!@)/i,
    ]));

  it("leaves an unrelated name and a lone first name clear", () => {
    const table = new LabelTable();
    maskText("De : Camille Exemple <c.exemple@exemple.fr>", { table, ...SRC });
    for (const text of ["Camille Martin", "Bonjour Camille,", "Exemplaire C. Martin", "Exemple c'est", "Exemple c’est", "Marie et c Exemple"])
      expect(maskText(text, { table, ...SRC }), text).toBe(text);
  });
});
