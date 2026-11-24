import { describe, expect, it } from "vitest";
import { numerals } from "../../src/mask/numerals.js";

const d = (t: string) => numerals(t).map((r) => r.digits);

describe("numerals", () => {
  it("reads compound numerals", () => {
    expect(d("trois cent quatre-vingt-un")).toEqual(["381"]);
    expect(d("quatre-vingt-douze")).toEqual(["92"]);
    expect(d("three hundred eighty-one")).toEqual(["381"]);
    expect(d("soixante-dix-sept")).toEqual(["77"]);
    expect(d("deux mille vingt-six")).toEqual(["2026"]);
    expect(d("quatre-vingts")).toEqual(["80"]);
    expect(d("vingt et un")).toEqual(["21"]);
  });
  it("reads a run of several numbers one after the other", () => {
    expect(d("trois cent quatre-vingt-un six cent vingt-quatre")).toEqual(["381624"]);
    expect(d("zéro six, douze, trente-quatre, cinquante-six, soixante-dix-huit")).toEqual(["0612345678"]);
    expect(d("quatre-vingt-dix-neuf dix-sept")).toEqual(["9917"]);
    expect(d("nineteen eighty-four")).toEqual(["1984"]);
  });
  it("reads digit-by-digit sequences of 4 words or more", () => {
    expect(d("code : trois huit un six deux quatre")).toEqual(["381624"]);
    expect(d("trois huit un six")).toEqual(["3816"]);
  });
  it("ignores ordinary words", () => {
    expect(d("code promo : deux mois offerts")).toEqual([]);
    expect(d("un deux trois")).toEqual([]);
  });
  it("gives the span of the run", () => {
    const t = "le code : trois huit un six.";
    const [r] = numerals(t);
    expect(t.slice(r!.start, r!.end)).toBe("trois huit un six");
  });
});
