import { describe, expect, it } from "vitest";
import { foldedProjections, foldWords, originalSpan, projections } from "../../src/mask/projections.js";

const get = (t: string, kind: string) => projections(t).find((p) => p.kind === kind)!;

describe("projections", () => {
  it("maps nfkc fullwidth digits back to their span", () => {
    const text = "code ３８１６２４";
    const p = get(text, "nfkc");
    const i = p.text.indexOf("381624");
    expect(originalSpan(p, i, i + 6)).toEqual([5, 11]);
  });
  it("maps a percent-decoded @", () => {
    const text = "a%40b.fr";
    const p = get(text, "percent");
    expect(p.text).toBe("a@b.fr");
    expect(originalSpan(p, 1, 2)).toEqual([1, 4]);
  });
  it("maps multi-byte percent escapes", () => {
    const p = get("x%C3%A9y", "percent");
    expect(p.text).toBe("xéy");
    expect(originalSpan(p, 1, 2)).toEqual([1, 7]);
  });
  it("digits keeps only digits, first at 0 and last at 13", () => {
    const text = "06 12 34 56 78";
    const p = get(text, "digits");
    expect(p.text).toBe("0612345678");
    expect(originalSpan(p, 0, 10)).toEqual([0, 14]);
    expect(p.start[9]).toBe(13);
    expect(originalSpan(p, 9, 10)).toEqual([13, 14]);
  });
  it("stays exact after a ligature and an emoji", () => {
    const text = "ﬁ 😀 " + "0612" + "345678";
    const p = get(text, "nfkc");
    const i = p.text.indexOf("0612345678");
    const [s, e] = originalSpan(p, i, i + 10);
    expect(text.slice(s, e)).toBe("0612345678");
    const d = get(text, "digits");
    expect(text.slice(...originalSpan(d, 0, 10))).toBe("0612345678");
  });
  it("adds numerals only when a run exists", () => {
    expect(projections("hello").map((p) => p.kind)).toEqual(["nfkc", "digits"]);
    const p = get("tel trois cent quatre-vingt-un", "numerals");
    expect(p.text).toBe("381");
    expect(originalSpan(p, 0, 3)).toEqual([4, 30]);
  });
  it("decodes percent up to 3 times", () => {
    for (const [text, at] of [["a%2540b.fr", 1], ["a%252540b.fr", 1]] as const) {
      const p = get(text, "percent");
      expect(p.text).toBe("a@b.fr");
      expect(originalSpan(p, at, at + 1)).toEqual([1, text.indexOf("b")]);
    }
  });
  it("chains percent into nfkc and digits", () => {
    const text = "%EF%BC%93%EF%BC%98";
    expect(get(text, "percent").text).toBe("38");
    expect(projections(text).filter((p) => p.kind === "digits").map((p) => p.text)).toContain("38");
  });
  it("folds digits of any script", () => {
    expect(get("code \u0660\u0666\u0661\u0662", "digits").text).toBe("0612");
  });
  it("keeps spans after a truncated escape", () => {
    const p = get("a%E2%82b", "percent");
    expect(p.text).toBe("a\ufffdb");
    expect(originalSpan(p, 2, 3)).toEqual([7, 8]);
  });
  it("reads percent-encoded number words", () => {
    const text = "code%20%3A%20trois%20huit%20un%20six%20deux%20quatre";
    const p = projections(text).find((x) => x.kind === "numerals" && x.text === "381624")!;
    expect(p).toBeDefined();
    expect(originalSpan(p, 0, 6)).toEqual([text.indexOf("trois"), text.length]);
  });
});

describe("the escapes projection", () => {
  it("decodes JSON \\u, \\/ and numeric HTML references, each char spanning its whole escape", () => {
    const text = "H\\u00e9lo&#xEF;se &#233;t\\/\\u00E9";
    const p = get(text, "escapes");
    expect(p.text).toBe("Héloïse ét/é");
    expect(text.slice(...originalSpan(p, 1, 2))).toBe("\\u00e9");
    expect(text.slice(...originalSpan(p, 4, 5))).toBe("&#xEF;");
    expect(text.slice(...originalSpan(p, 8, 9))).toBe("&#233;");
    expect(text.slice(...originalSpan(p, 10, 11))).toBe("\\/");
    expect(text.slice(...originalSpan(p, 0, p.text.length))).toBe(text);
  });
  it("decodes up to 3 times, then normalizes", () => {
    const text = "x\\u0026#x26;#233;y \\uFF13";
    const p = get(text, "escapes");
    expect(p.text).toBe("xéy 3");
    expect(originalSpan(p, 1, 2)).toEqual([1, text.indexOf("y")]);
  });
  it("decodes a surrogate pair without shifting what follows", () => {
    const text = "a \\uD83D\\uDE00 &#128512; " + "\\u0030\\u0036 b";
    const p = get(text, "escapes");
    expect(p.text).toBe("a 😀 😀 06 b");
    const b = p.text.indexOf("b");
    expect(originalSpan(p, b, b + 1)).toEqual([text.length - 1, text.length]);
    expect(projections(text).filter((x) => x.kind === "digits").map((x) => x.text)).toContain("06");
  });
  it("leaves broken escapes as they are", () => {
    const text = "\\u12G4 \\u12 &#12 &#x;";
    expect(projections(text).map((p) => p.kind)).not.toContain("escapes");
    expect(get("&#1114112; H&#233;", "escapes").text).toBe("&#1114112; Hé");
    expect(get("&#12 \\u00e9 \\u12", "escapes").text).toBe("&#12 é \\u12");
  });
  it("is not built for URL slashes away from a digit, nor for a reference it leaves as written", () => {
    const kinds = (t: string) => projections(t).map((p) => p.kind);
    expect(kinds('{"url":"https:\\/\\/exemple.test\\/a","n":"x"} &#99999999;')).toEqual(["nfkc", "digits"]);
    expect(kinds("né le 14\\/03\\/1990")).toContain("escapes");
    expect(get("né le 14\\/03\\/1990", "escapes").text).toBe("né le 14/03/1990");
    expect(kinds("https:\\/\\/x.test H&#233;lo")).toContain("escapes");
    // An escape that writes another escape (`\u0026` is « & ») may decode to a letter on the next pass.
    expect(get("x\\u0026#233;", "escapes").text).toBe("xé");
    expect(foldedProjections("https:\\/\\/x.test")).toHaveLength(1);
    expect(kinds("https:\\/\\/x")).toEqual(["nfkc", "digits"]);
    expect(kinds("&#99999999;")).toEqual(["nfkc", "digits"]);
    expect(kinds("un &#39; deux")).toContain("escapes");
  });
  it("is built for any decodable escape, a separator included (« 06&#32;12 », « Camille &#32; Aubrac »)", () => {
    for (const t of ["06&#32;12", "FR76&#160;3000", "Camille\\u0020Aubrac", "06\\u002d12", "d&#39;Alène", "&#32;&#32;x&#32;\\u0020y", "Camille &#32; Aubrac", "Camille &#160; Aubrac", "Camille &#32;Aubrac", "Camille\n&#32;Aubrac"])
      expect(projections(t).map((p) => p.kind), t).toContain("escapes");
  });
  it("is built only when an escape is in the text, and is folded for the passport", () => {
    expect(projections("Héloïse, 06 12, a/b \\n").map((p) => p.kind)).toEqual(["nfkc", "digits"]);
    expect(foldedProjections("Héloïse")).toHaveLength(1);
    const ps = foldedProjections("H\\u00e9lo\\u00efse");
    expect(ps.map((p) => p.text)).toEqual(["h u00e9lo u00efse", "heloise"]);
    expect(foldedProjections("H\\u00e9lo\\u00efse", projections("H\\u00e9lo\\u00efse")).map((p) => p.text)).toEqual(["h u00e9lo u00efse", "heloise"]);
  });
});

describe("foldWords", () => {
  it.each([
    ["DUPONT, Jean\u2011Pierre", "dupont jean pierre"],
    ["Aubrac Camille", "aubrac camille"],
    // A zero-width char is removed, not turned into a space.
    ["Aubrac\u200bCamille", "aubraccamille"],
    ["A\u0301ubrac", "aubrac"],
    ["Cœur d’Alène", "coeur d alene"],
    ["14,\nrue des Tanneurs", "14 rue des tanneurs"],
    ["  Straße  ", "strasse"],
    ["Ｊｅａｎ\u00a0Dupont", "jean dupont"],
  ])("foldWords(%j) = %j", (input, out) => expect(foldWords(input)).toBe(out));

  it("the folded projection maps every char back to its source span", () => {
    const text = "AUBRAC Camille";
    const p = foldedProjections(text)[0]!;
    expect(p.kind).toBe("folded");
    expect(p.text).toBe(foldWords(text));
    const i = p.text.indexOf("camille");
    expect(originalSpan(p, i, i + 7)).toEqual([7, 14]);
  });
  it("maps a separator run to its whole span and a decomposed accent to its letter", () => {
    const text = "Jean - Pie\u0301rre";
    const p = foldedProjections(text)[0]!;
    expect(p.text).toBe("jean pierre");
    expect(originalSpan(p, 4, 5)).toEqual([4, 7]);
    expect(text.slice(...originalSpan(p, 5, 11))).toBe("Pie\u0301rre");
  });
  it("folds the percent-decoded text too, only when it exists", () => {
    expect(foldedProjections("Jean Dupont")).toHaveLength(1);
    const text = "q=Jean%20Dupont";
    const ps = foldedProjections(text);
    expect(ps.map((p) => p.text)).toEqual(["q jean 20dupont", "q jean dupont"]);
    const p = ps[1]!;
    const i = p.text.indexOf("dupont");
    expect(originalSpan(p, i, i + 6)).toEqual([text.indexOf("Dupont"), text.length]);
  });
  it("is not one of the detectors' projections", () => {
    expect(projections("Jean Dupont").map((p) => p.kind)).toEqual(["nfkc", "digits"]);
  });
});
