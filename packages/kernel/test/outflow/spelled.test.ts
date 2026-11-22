import { expect, test } from "vitest";
import { spelled } from "../../src/outflow/spelled.js";

test("a run of digit words becomes digits, in any table language", () => {
  expect(spelled("code trois huit un six deux quatre")).toContain("381624");
  expect(spelled("Code drei acht eins sechs zwei vier")).toContain("381624");
  expect(spelled("codigo tres ocho uno seis dos cuatro")).toContain("381624");
});
test("spaced letters are glued, then read as digit words when they spell only digit words", () => {
  expect(spelled("verif s e p t z é r o q u a t r e")).toContain("704");
  expect(spelled("f r a i s verif")).toContain("frais");
});
test("a token made only of glued digit words is read", () => {
  expect(spelled("verif septzeroquatre")).toContain("704");
});
test("NATO words become letters", () => {
  expect(spelled("ref bravo xray two two nine one kilo quebec seven")).toContain("bx2291kq7");
});
test("ordinary words stay", () => {
  expect(spelled("un bon gratin pour six")).toBeUndefined();
  expect(spelled("neuf idées de recettes")).toBeUndefined();
});
test("a long query is one pass", () => {
  // 20 000 words: a pass quadratic in the words would take seconds; a linear one takes milliseconds, so 500 ms holds on a loaded machine.
  const q = "gratin ".repeat(20_000);
  const t = performance.now(); spelled(q); expect(performance.now() - t).toBeLessThan(500);
});

test("punctuation and line breaks do not stop a run", () => {
  for (const q of [
    "trois huit un six deux quatre.",
    "trois, huit, un, six, deux, quatre",
    "trois-huit-un-six-deux-quatre",
    "trois\nhuit\nun six deux quatre",
    "trois huit un, six deux quatre",
  ])
    expect(spelled(q)).toContain("381624");
});
test("real words are not glued digit words", () => {
  for (const w of ["entre", "took", "unto", "bonbon"]) expect(spelled(w)).toBeUndefined();
});
test("NATO beats digit words in a run, and x-ray is x", () => {
  expect(spelled("lima echo kilo")).toContain("lek");
  expect(spelled("x-ray bravo two")).toBe("xb2");
});
test("Indic vowel signs are kept", () => {
  expect(spelled("তিন তিন তিন")).toContain("333");
});
test("CJK, hangul and romanised digits are read in runs of 3 only", () => {
  expect(spelled("三八一六二四")).toContain("381624");
  expect(spelled("삼팔일육이사")).toContain("381624");
  expect(spelled("三 八 一，六 二 四")).toContain("381624");
  expect(spelled("san hachi ichi roku ni yon")).toContain("381624");
  expect(spelled("sam pal il yuk i sa")).toContain("381624");
  expect(spelled("yi er san")).toContain("123");
  expect(spelled("一緒に行く")).toBeUndefined();
  expect(spelled("이 책")).toBeUndefined();
  expect(spelled("san ni")).toBeUndefined();
});
test("bare numerals join a run of words, but a run of numerals alone is no rewrite", () => {
  expect(spelled("code 3 huit 1 six 2 quatre")).toContain("381624");
  expect(spelled("formation 4-4-2 football")).toBeUndefined();
  expect(spelled("tr\u200bois huit un")).toContain("381");
});
test("romanised Russian digits are read in runs of 3 only", () => {
  expect(spelled("tri vosem odin shest dva chetyre")).toContain("381624");
  expect(spelled("nol pyat sem devyat")).toContain("0579");
  expect(spelled("sem")).toBeUndefined();
});
test("Greek digit words are read with or without tonos", () => {
  expect(spelled("μηδέν ένα δύο τρία τέσσερα πέντε έξι επτά οκτώ εννέα")).toContain("0123456789");
  expect(spelled("εφτα οχτω εννια")).toContain("789");
});
test("Hindi digit words are read, vowel signs kept", () => {
  expect(spelled("शून्य एक दो तीन चार पाँच छह सात आठ नौ")).toContain("0123456789");
  expect(spelled("पांच छः पाँच")).toContain("565");
});
test("digits of other scripts are read as ASCII digits", () => {
  for (const q of ["٣٨١٦٢٤", "۳۸۱۶۲۴", "३८१६२४"]) expect(spelled(q)).toContain("381624");
});
test("object prototype names are no digit words", () => {
  expect(spelled("constructor toString valueOf")).toBeUndefined();
  expect(spelled("constructor constructor constructor")).toBeUndefined();
  expect(spelled("trois huit constructor un")).toBeUndefined();
  expect(spelled("trois huit un constructor")).toBe("381 constructor");
});
test("ASCII digits count toward a CJK or hangul run that holds a numeral", () => {
  for (const q of ["3 八 1 六 2 四", "3八1六2四", "3 팔 1 육 2 사", "三8一6二4"]) expect(spelled(q), q).toContain("381624");
  // Ordinary text: no run of 3 with a numeral in it, or the numerals stay apart.
  for (const q of ["第1章", "2024年3月15日", "一緒に3人で", "이 책 3권"]) expect(spelled(q) ?? "", q).not.toMatch(/\d{3}/);
});
test("spaced letters next to a romanised « i » are also read unglued", () => {
  expect(spelled("B X i i gu il K Q chil")?.replace(/\s/g, "")).toContain("bx2291kq");
  expect(spelled("f r a i s verif")).toContain("frais");
});
