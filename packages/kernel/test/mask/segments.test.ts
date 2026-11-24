import { expect, test } from "vitest";
import { Segments, unwrap } from "../../src/mask/segments.js";
import { LabelTable } from "../../src/mask/table.js";
import { IBAN, PHONE } from "./values.js";

const MAIL = "camille.exemple" + "@" + "novacourriel.test";

test("wrap tags with a fresh 16-hex token and strips the mark characters from the text", () => {
  const s = new Segments();
  const a = s.wrap("abcd", "sources", null);
  const b = s.wrap("x", "sources", null);
  expect(a).toMatch(/^[0-9a-f]{16}abcd$/);
  expect(a.slice(1, 17)).not.toBe(b.slice(1, 17));
  expect(unwrap(a)).toBe("abcd");
});

test("apply masks a tagged part by its zone, the rest as the web, and drops every mark", () => {
  const s = new Segments();
  const t = new LabelTable({ resolvable: true });
  const out = s.apply(`web ${PHONE} ${s.wrap(`source ${PHONE}`, "sources", "https://a.test")} fin`, t);
  expect(out).toMatch(new RegExp(`^web ${PHONE} source ⟨tel-[a-z0-9]{8}⟩ fin$`));
});

test("an unknown token is page text: its part is masked as the web and its marks removed", () => {
  const out = new Segments().apply(`${"0123456789abcdef"}sources ${PHONE} ${IBAN}`, new LabelTable());
  expect(out).toMatch(new RegExp(`^sources ${PHONE} ⟨iban-[a-z0-9]{8}⟩$`));
});

test("web-zone parts use only their origin's web entries, never the sources'", () => {
  const s = new Segments();
  const t = new LabelTable({ resolvable: true });
  const mine = s.apply(s.wrap(IBAN, "sources", null), t);
  const page = s.apply(s.wrap(IBAN, "web", "https://b.test"), t);
  expect(page).not.toBe(mine);
  expect(t.entries("web")[0]!.origins).toEqual(["https://b.test"]);
});

test("a rewritten web address leaves a handle to the real one, with the origin it was read on; only in a resolvable table", () => {
  const s = new Segments();
  const real = `https://a.test/u/${MAIL}`;
  const t = new LabelTable({ resolvable: true });
  const out = s.apply(s.wrap(`Lien : ${real} et https://a.test/clair`, "sources", "https://a.test"), t);
  const masked = out.match(/https:\/\/a\.test\/u\/\S+/)![0];
  expect(masked).toMatch(/⟨email-[a-z0-9]{8}⟩@novacourriel\.test$/);
  expect(t.unhandle(masked)).toEqual({ real, origin: "https://a.test" });
  expect(t.unhandle("https://a.test/clair")).toBeUndefined();
  const main = new LabelTable();
  const shown = s.apply(s.wrap(real, "sources", "https://a.test"), main);
  expect(main.unhandle(shown)).toBeUndefined();
});

test("raw: the one revealed value of a result is left as it is, once per result; its token used elsewhere is page text", () => {
  const s = new Segments();
  const t = new LabelTable({ resolvable: true });
  const raw = s.raw(IBAN);
  expect(s.apply(`Valeur : ${raw} ; page : ${IBAN}`, t)).toMatch(new RegExp(`^Valeur : ${IBAN} ; page : ⟨iban-[a-z0-9]{8}⟩$`));
  expect(() => s.raw(PHONE)).toThrow();
  // The same marked text in another result (a page echoing it) is masked like any page text.
  expect(new Segments().apply(raw, t)).toMatch(/^⟨iban-[a-z0-9]{8}⟩$/);
});
