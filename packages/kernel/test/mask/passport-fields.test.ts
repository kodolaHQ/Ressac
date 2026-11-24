import { describe, expect, it } from "vitest";
import { nirValid } from "../../src/outflow/detect.js";
import {
  canonicalOf,
  cleanOrigin,
  maskedDisplay,
  originMatches,
  parseAddress,
  passportForms,
  rawOf,
  validateEntry,
  validatePassport,
  valueForKind,
  type PassportEntry,
  type PassportField,
  type PassportValue,
} from "../../src/mask/passport-fields.js";

// Secret-shaped values are built from parts at run time, never written whole.
const mod97 = (digits: string) => [...digits].reduce((r, d) => (r * 10 + Number(d)) % 97, 0);
const letters = (s: string) => s.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
const ibanOf = (country: string, bban: string) => {
  const key = String(98 - mod97(letters(bban + country + "00"))).padStart(2, "0");
  return country + key + bban;
};
const bank = ["30006", "00001"].join("");
const account = ["12345", "678901"].join("");
const bban = bank + account + "89";
const iban = ibanOf("FR", bban);
const nir13 = ["1", "90", "03", "69", "123", "456"].join("");
const nir = nir13 + String(97 - mod97(nir13)).padStart(2, "0");

let n = 0;
const entry = (field: PassportField, value: PassportValue, extra: Partial<PassportEntry> = {}): PassportEntry => ({
  id: (++n).toString(16).padStart(16, "0"),
  field,
  value,
  variants: [],
  origins: [],
  how: "typed",
  created: "2026-11-23T00:00:00.000Z",
  updated: "2026-11-23T00:00:00.000Z",
  ...extra,
});
const text = (field: PassportField, t: string, extra?: Partial<PassportEntry>) => entry(field, { text: t }, extra);
const folded = (e: PassportEntry) => passportForms(e).folded.map((f) => f.form);
const codes = (e: PassportEntry, others: PassportEntry[] = []) => validateEntry(e, others).problems.map((p) => p.code);

describe("nom", () => {
  const e = entry("nom", { given: "Jean-Pierre", family: "de La Fontaine" });
  it("gives the direct, reversed, initial, particle-less and civility forms", () => {
    expect(folded(e)).toEqual(
      expect.arrayContaining([
        "jean pierre de la fontaine",
        "de la fontaine jean pierre",
        "j p de la fontaine",
        "jp de la fontaine",
        "de la fontaine j p",
        "la fontaine jean pierre",
        "mme de la fontaine",
        "monsieur la fontaine",
      ]),
    );
  });
  it("never a first name or a surname alone", () => {
    expect(folded(e)).not.toContain("jean pierre");
    expect(folded(e)).not.toContain("de la fontaine");
    expect(folded(e)).not.toContain("la fontaine");
    expect(folded(e)).not.toContain("fontaine");
  });
  it("marks the initials that must be capitals in the text", () => {
    const f = passportForms(e).folded;
    expect(f.find((x) => x.form === "j p de la fontaine")!.initials).toEqual([0, 2]);
    expect(f.find((x) => x.form === "jp de la fontaine")!.initials).toEqual([0, 1]);
    expect(f.find((x) => x.form === "de la fontaine j p")!.initials).toEqual([15, 17]);
    expect(f.find((x) => x.form === "jean pierre de la fontaine")!.initials).toEqual([]);
  });
  it("takes a user variant as it is, one word included, with a warning", () => {
    const v = entry("nom", { given: "Camille", family: "Aubrac" }, { variants: ["Camille", "C. Fontaine"] });
    expect(folded(v)).toEqual(expect.arrayContaining(["camille", "c fontaine"]));
    expect(passportForms(v).folded.find((x) => x.form === "c fontaine")!.initials).toEqual([]);
    const r = validateEntry(v, []);
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([{ code: "one-word", index: 0 }]);
  });
  it("refuses a variant under 4 folded chars, and a name without a family name", () => {
    const v = entry("nom", { given: "Camille", family: "Aubrac" }, { variants: ["Cam"] });
    expect(validateEntry(v, []).problems).toEqual([{ code: "too-short", at: "variant", index: 0 }]);
    expect(codes(entry("nom", { given: "Camille", family: "  " }))).toEqual(["name"]);
  });
  it("canonical and raw", () => {
    expect(rawOf(e)).toBe("Jean-Pierre de La Fontaine");
    expect(canonicalOf(entry("nom", { given: "Élodie", family: "Durand" }))).toBe("elodie durand");
  });
});

describe("adresse", () => {
  const e = text("adresse", "14 bis rue Saint-Jean\n69005 Lyon");
  it("gives the street line's writings", () => {
    expect(folded(e)).toEqual(
      expect.arrayContaining(["14 bis rue saint jean", "14bis rue saint jean", "14 b r st jean", "rue saint jean 14 bis"]),
    );
  });
  it("never the postcode, the city or a street without its number", () => {
    for (const f of ["69005 lyon", "lyon", "69005", "rue saint jean"]) expect(folded(e)).not.toContain(f);
    expect(passportForms(e).digits).toEqual([]);
  });
  it("parses the street, postcode and city", () => {
    expect(parseAddress("14 bis rue Saint-Jean\n69005 Lyon")).toEqual({ street: "14 bis rue Saint-Jean", postcode: "69005", city: "Lyon" });
    expect(parseAddress("Rue de la Loi 16\nBruxelles")).toEqual({ street: "Rue de la Loi 16", postcode: null, city: null });
    expect(parseAddress("Le Moulin\nLyon")).toEqual({ street: null, postcode: null, city: null });
  });
  it("reads a number after the street", () => {
    expect(folded(text("adresse", "Avenue du Général Leclerc 12"))).toEqual(
      expect.arrayContaining(["avenue du general leclerc 12", "12 av du gal leclerc"]),
    );
  });
  it("an unparsed address never falls back to its postcode and city line", () => {
    expect(folded(text("adresse", "69005 Lyon\nLe Moulin"))).toEqual(["le moulin"]);
    expect(folded(text("adresse", "69005 Lyon"))).toEqual([]);
  });
  it("searches an unparsed address as its first line", () => {
    expect(folded(text("adresse", "Lieu-dit Le Moulin\n43100 Brioude"))).toEqual(["lieu dit le moulin"]);
  });
  it("needs a number and a word", () => {
    expect(codes(text("adresse", "rue Saint-Jean"))).toEqual(["address"]);
  });
});

describe("naissance", () => {
  it("gives digit and written forms, always with the year", () => {
    const f = passportForms(text("naissance", "1990-03-14"));
    expect(f.digits).toEqual(expect.arrayContaining(["14031990", "19900314", "140390", "1431990"]));
    expect(f.folded.map((x) => x.form)).toEqual(expect.arrayContaining(["14 mars 1990", "14 mar 1990", "march 14 1990", "14 march 1990"]));
    expect(f.folded.map((x) => x.form)).not.toContain("14 mars");
    expect(f.digits).not.toContain("1403");
  });
  it("the first of the month is « 1er »", () => {
    expect(folded(text("naissance", "1990-03-01"))).toContain("1er mars 1990");
  });
  it("refuses a future or impossible date", () => {
    expect(codes(text("naissance", "2999-01-01"))).toEqual(["date"]);
    expect(codes(text("naissance", "1990-02-30"))).toEqual(["date"]);
    expect(codes(text("naissance", "1890-01-01"))).toEqual(["date"]);
    expect(codes(text("naissance", "1990-03-14"))).toEqual([]);
  });
});

describe("iban", () => {
  it("all digits, the BBAN and the French account number", () => {
    const f = passportForms(text("iban", iban.replace(/(.{4})/g, "$1 ").trim()));
    expect(f.digits).toEqual(expect.arrayContaining([iban.replace(/\D/g, ""), bban, account]));
    expect(f.folded).toEqual([]);
  });
  it("checks the length then the key", () => {
    expect(codes(text("iban", iban))).toEqual([]);
    expect(codes(text("iban", iban.slice(0, 20)))).toEqual(["iban-short"]);
    const wrong = iban.slice(0, 2) + (iban[2] === "9" ? "1" : "9") + iban.slice(3);
    expect(codes(text("iban", wrong))).toEqual(["iban-key"]);
  });
  it("same canonical as an entry of the same passport: duplicate", () => {
    const a = text("iban", iban);
    expect(codes(text("iban", iban.toLowerCase().replace(/(.{4})/g, "$1 ")), [a])).toEqual(["duplicate"]);
    expect(canonicalOf(a)).toBe(iban);
  });
});

describe("secu", () => {
  it("15 and 13 digits", () => {
    expect(passportForms(text("secu", nir)).digits).toEqual([nir, nir13]);
  });
  it("accepts a Corsican department (2A, 2B), key checked by step 1's nirValid", () => {
    const corsica = ["2", "75", "06", "2A", "004", "012"].join("");
    const ok = corsica + String(97 - mod97(corsica.replace("2A", "19"))).padStart(2, "0");
    expect(nirValid(ok)).toBe(true);
    expect(codes(text("secu", ok))).toEqual([]);
    expect(codes(text("secu", ok.slice(0, 13) + String((Number(ok.slice(13)) % 97) + 1).padStart(2, "0")))).toEqual(["secu-key"]);
  });
  it("checks the length then the key", () => {
    expect(codes(text("secu", nir))).toEqual([]);
    expect(codes(text("secu", nir13))).toEqual(["secu-short"]);
    const wrongKey = nir13 + String((Number(nir.slice(13)) % 97) + 1).padStart(2, "0");
    expect(codes(text("secu", wrongKey))).toEqual(["secu-key"]);
  });
});

describe("tel", () => {
  const mobile = ["06", "12", "34", "56", "78"].join(" ");
  it("the step-1 digit forms", () => {
    const d = mobile.replace(/ /g, "");
    expect(passportForms(text("tel", mobile)).digits).toEqual(["33" + d.slice(1), "0033" + d.slice(1), d, "330" + d.slice(1), d.slice(1)]);
    expect(canonicalOf(text("tel", mobile))).toBe("+33" + d.slice(1));
  });
  it("10 digits starting with 0, or + and 8 to 15 digits", () => {
    expect(codes(text("tel", mobile))).toEqual([]);
    expect(codes(text("tel", "+44 20 7946 0000"))).toEqual([]);
    expect(codes(text("tel", "06 12"))).toEqual(["tel"]);
  });
});

describe("email", () => {
  it("no form beyond the detector, a warning about the domain", () => {
    const e = text("email", "camille@exemple.fr");
    expect(passportForms(e)).toEqual({ folded: [], digits: [] });
    expect(validateEntry(e, [])).toEqual({ problems: [], warnings: [{ code: "email-domain" }] });
    expect(codes(text("email", "camille@exemple"))).toEqual(["email"]);
    expect(canonicalOf(text("email", "Camille@Exemple.FR"))).toBe("camille@exemple.fr");
  });
});

describe("plaque and piece", () => {
  it("as written and compact", () => {
    expect(folded(text("plaque", "AB-123-CD"))).toEqual(["ab 123 cd", "ab123cd"]);
    expect(codes(text("plaque", "AB-123-CD"))).toEqual([]);
    expect(codes(text("plaque", "1234 AB 56"))).toEqual([]);
    expect(codes(text("plaque", "AB-12-CD"))).toEqual(["plate"]);
  });
  it("a piece has 6 to 20 letters or digits", () => {
    expect(codes(text("piece", "12AB34"))).toEqual([]);
    expect(codes(text("piece", "12AB3"))).toEqual(["piece"]);
  });
});

describe("libre", () => {
  it("digits only gives a digit form", () => {
    const v = ["00421", "78306"].join("");
    expect(passportForms(text("libre", v))).toEqual({ folded: [], digits: [v] });
  });
  it("too short", () => {
    expect(codes(text("libre", "Pa"))).toEqual(["too-short"]);
    expect(codes(text("libre", "12 34"))).toEqual(["too-short-digits"]);
    // Not digits only, so it needs a letter: else every standalone « 1234 » would be masked.
    expect(codes(text("libre", "1234 €"))).toEqual(["too-short"]);
  });
  it("one word: a warning", () => {
    expect(validateEntry(text("libre", "Paris"), []).warnings).toEqual([{ code: "one-word" }]);
  });
});

describe("caps", () => {
  const many = (k: number) => Array.from({ length: k }, (_, i) => text("libre", `donnee numero ${i}`));
  it("a 201st entry is full", () => {
    expect(codes(text("libre", "une de trop"), many(200))).toEqual(["full"]);
    expect(codes(text("libre", "une de plus"), many(199))).toEqual([]);
  });
  it("too long, too many variants or origins, a bad origin", () => {
    expect(codes(text("libre", "x".repeat(301)))).toEqual(["long"]);
    expect(codes(text("libre", "valeur", { variants: Array.from({ length: 11 }, (_, i) => `variante ${i}`) }))).toEqual(["variants-full"]);
    expect(codes(text("libre", "valeur", { origins: Array.from({ length: 21 }, (_, i) => `site${i}.fr`) }))).toEqual(["origins-full"]);
    expect(validateEntry(text("libre", "valeur", { origins: ["ameli.fr", "pas un site"] }), []).problems).toEqual([{ code: "origin", at: "origin", index: 1 }]);
    expect(validateEntry(text("libre", "valeur", { variants: ["y".repeat(201)] }), []).problems).toEqual([{ code: "long", at: "variant", index: 0 }]);
  });
  it("never more than 64 forms", () => {
    const e = text("adresse", "14 bis boulevard du Général Saint-Maréchal Docteur\n69005 Lyon", {
      variants: Array.from({ length: 10 }, (_, i) => `ancienne adresse ${i}`),
    });
    const f = passportForms(e);
    expect(f.folded.length + f.digits.length).toBeLessThanOrEqual(64);
    expect(f.folded[0]!.form).toBe("14 bis boulevard du general saint marechal docteur");
    expect(folded(e)).toContain("ancienne adresse 9");
  });
});

describe("validatePassport (on load)", () => {
  it("keeps the first copy of a duplicate", () => {
    const a = text("libre", "Ma donnee");
    const b = text("libre", "ma  DONNEE");
    const r = validatePassport([a, b]);
    expect(r.kept).toEqual([a]);
    expect(r.dropped).toEqual([{ index: 1, problems: [{ code: "duplicate", at: "value" }] }]);
  });
  it("a 201st entry drops only itself", () => {
    const all = Array.from({ length: 201 }, (_, i) => text("libre", `donnee numero ${i}`));
    const r = validatePassport(all);
    expect(r.kept).toEqual(all.slice(0, 200));
    expect(r.dropped.map((d) => d.index)).toEqual([200]);
  });
  it("drops an invalid entry, keeps the others", () => {
    const ok = text("libre", "valeur");
    const r = validatePassport([text("tel", "06 12"), ok]);
    expect(r.kept).toEqual([ok]);
    expect(r.dropped).toEqual([{ index: 0, problems: [{ code: "tel", at: "value" }] }]);
  });
});

describe("origins", () => {
  it("cleans what the user writes", () => {
    expect(cleanOrigin("https://www.Impots.gouv.fr/x")).toBe("www.impots.gouv.fr");
    expect(cleanOrigin(" ameli.fr ")).toBe("ameli.fr");
    expect(cleanOrigin("pas un site")).toBeNull();
    expect(cleanOrigin("user@ameli.fr")).toBeNull();
  });
  it("matches https on the host and its www, nothing else", () => {
    expect(originMatches("impots.gouv.fr", "https://impots.gouv.fr")).toBe(true);
    expect(originMatches("impots.gouv.fr", "https://www.impots.gouv.fr")).toBe(true);
    expect(originMatches("impots.gouv.fr", "http://impots.gouv.fr")).toBe(false);
    expect(originMatches("impots.gouv.fr", "https://mail.impots.gouv.fr")).toBe(false);
    expect(originMatches("www.impots.gouv.fr", "https://www.www.impots.gouv.fr")).toBe(false);
  });
  it("http on a loopback address only through the test seam, off by default", () => {
    expect(originMatches("127.0.0.1:5300", "http://127.0.0.1:5300")).toBe(false);
    expect(originMatches("127.0.0.1:5300", "http://127.0.0.1:5300", { localAddresses: true })).toBe(true);
    expect(originMatches("localhost", "http://localhost", { localAddresses: true })).toBe(true);
    expect(originMatches("impots.gouv.fr", "http://impots.gouv.fr", { localAddresses: true })).toBe(false);
    expect(originMatches("10.0.0.1", "http://10.0.0.1", { localAddresses: true })).toBe(false);
  });
});

describe("maskedDisplay", () => {
  it("per kind of value", () => {
    expect(maskedDisplay(text("email", "camille@exemple.fr"))).toBe("c••••••@exemple.fr");
    expect(maskedDisplay(text("naissance", "1990-03-14"))).toBe("••/••/••••");
    expect(maskedDisplay(text("iban", iban))).toBe("•••• " + iban.slice(-4, -2) + " " + iban.slice(-2));
    expect(maskedDisplay(entry("nom", { given: "Camille", family: "Aubrac" }))).toBe("C•••••• A•••••");
    expect(maskedDisplay(text("adresse", "14 rue Neuve\n69005 Lyon"))).toBe("•• r•• N••••, ••••• L•••");
  });
});

describe("valueForKind", () => {
  it("a date per input type, a name in parts, an address in parts", () => {
    const d = text("naissance", "1990-03-14");
    expect(valueForKind(d, "naissance", "date")).toBe("1990-03-14");
    expect(valueForKind(d, "naissance", "text")).toBe("14/03/1990");
    const name = entry("nom", { given: "Jean-Pierre", family: "de La Fontaine" });
    expect(valueForKind(name, "prenoms", "text")).toBe("Jean-Pierre");
    expect(valueForKind(name, "nom_famille", "text")).toBe("de La Fontaine");
    expect(valueForKind(name, "nom_complet", "text")).toBe("Jean-Pierre de La Fontaine");
    const a = text("adresse", "14 bis rue Saint-Jean\n69005 Lyon");
    expect(valueForKind(a, "code_postal", "text")).toBe("69005");
    expect(valueForKind(a, "ville", "text")).toBe("Lyon");
    expect(valueForKind(a, "adresse_voie", "text")).toBe("14 bis rue Saint-Jean");
    expect(valueForKind(text("adresse", "14 rue Neuve\nBruxelles"), "code_postal", "text")).toBeNull();
    expect(valueForKind(a, "tel", "tel")).toBeNull();
  });
});
