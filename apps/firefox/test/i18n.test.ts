import { expect, test } from "vitest";
import { KERNEL_SOURCES } from "../../../packages/kernel/src/index";
import { format, languageName, LOCALES, localeIssues, localeIssuesOf, resolveLocale } from "../shared/i18n";

test("the shipped languages, English first", () => {
  expect(LOCALES[0]).toBe("en");
  expect(LOCALES).toContain("fr");
});

test("« system » takes the first Mac language Ressac has, else English; a chosen one wins", () => {
  expect(resolveLocale("system", ["de-DE", "fr-FR"])).toBe("fr");
  expect(resolveLocale("system", ["de-DE"])).toBe("en");
  expect(resolveLocale("system", ["en-GB"])).toBe("en");
  expect(resolveLocale("system", ["fr-CA"])).toBe("fr");
  expect(resolveLocale("system", [])).toBe("en");
  expect(resolveLocale("en", ["fr-FR"])).toBe("en");
  expect(resolveLocale("xx", [])).toBe("en");
});

test("plurals follow the language; a missing message or language falls back to English", () => {
  expect(format("fr", "test-plural", { count: 1 })).toBe("1 onglet");
  expect(format("fr", "test-plural", { count: 2 })).toBe("2 onglets");
  expect(format("en", "test-plural", { count: 1 })).toBe("1 tab");
  expect(format("de", "test-plural", { count: 3 })).toBe("3 tabs");
  expect(format("fr", "test-english-only")).toBe("Only in English");
  expect(format("fr", "no-such-message")).toBe("no-such-message");
});

test("a language is named in itself", () => {
  expect(languageName("fr")).toBe("Français");
  expect(languageName("en")).toBe("English");
});

test("the shipped files are consistent", () => expect(localeIssues()).toEqual([]));

test("an unknown message, a renamed variable, a syntax error and a gap in French are reported", () => {
  const issues = localeIssuesOf({
    en: "a = A { $name }\nb = B\nc = C",
    fr: "a = A { $nom }\nb = B\nz = Z\nbroken = { $\n",
    de: "b = B",
  });
  expect(issues).toEqual(
    expect.arrayContaining([
      "fr: a uses { nom }, en uses { name }",
      "fr: z is not in en",
      "fr: c is missing",
      expect.stringMatching(/^fr: 1 message\(s\) with a syntax error/),
    ]),
  );
  expect(issues.some((i) => i.startsWith("de:"))).toBe(false);
});

test("the kernel's languages follow the same parity rules", () => {
  expect(localeIssuesOf(KERNEL_SOURCES)).toEqual([]);
});
