import { expect, test } from "vitest";
import { findSecrets, mask, variants } from "../../src/outflow/detect.js";

const kinds = (text: string) => findSecrets(text).map((s) => s.kind);

// Remainder of a long digit string modulo 97, digit by digit (BigInt would do too).
const mod97 = (digits: string) => [...digits].reduce((r, d) => (r * 10 + Number(d)) % 97, 0);

/** Appends the Luhn check digit to `body`. */
function luhn(body: string): string {
  let sum = 0;
  [...body].reverse().forEach((c, i) => {
    let d = Number(c) * (i % 2 === 0 ? 2 : 1);
    if (d > 9) d -= 9;
    sum += d;
  });
  return body + ((10 - (sum % 10)) % 10);
}

/** French IBAN with computed check digits. */
function iban(bban: string): string {
  const numeric = (bban + "FR00").replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  return `FR${String(98 - mod97(numeric)).padStart(2, "0")}${bban}`;
}

const nirKey = (thirteen: string) => String(97 - mod97(thirteen)).padStart(2, "0");

test("api keys, private keys and JWTs", () => {
  for (const key of [
    "sk" + "_live_51NxQk2LmN8pRs4TuVw6YzA8b",
    "sk_test_51NxQk2LmN8pRs4TuVw6YzA8b",
    "rk" + "_live_51NxQk2LmN8pRs4TuVw6YzA8b",
    "whsec_9aBcD3fGhJ5kLmN7pQrS1tUv",
    "ghp_x7Kq9LmN2pRs4TuVw6YzA8bCdEfGhJ1kMn3P",
    "gho_x7Kq9LmN2pRs4TuVw6YzA8bCdEfGhJ1kMn3P",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234",
    "xoxb-1234-5678-abcd",
    "AKIAIOSFODNN7EXAMPLE",
    "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
    // Built at run time, like the keys above: a push-protection scanner must not take the fixtures for real keys.
    "glpat" + "-xK9mQ2rT7vW4yZ1bN6cD",
    "shpat" + "_" + "a1b2c3d4e5f60718293a4b5c6d7e8f90",
    "dop" + "_v1_" + "4f6e2a9c1b8d7e3f5a0c2b4d6e8f1a3c5b7d9e0f2a4c6b8d0e1f3a5c7b9d2e4f",
  ]) {
    expect(findSecrets(`ma clé ${key} merci`), key).toEqual([{ kind: "api-key", value: key }]);
  }
  expect(kinds("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----")).toEqual(["private-key"]);
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  expect(findSecrets(`token ${jwt}`)).toEqual([{ kind: "jwt", value: jwt }]);
});

test("card: Luhn-valid only", () => {
  const card = luhn("497010123456789");
  const spaced = card.replace(/(\d{4})(?=\d)/g, "$1 ");
  expect(findSecrets(`carte ${spaced}`)).toEqual([{ kind: "card", value: card }]);
  const wrong = card.slice(0, 15) + ((Number(card[15]) + 1) % 10);
  expect(findSecrets(`carte ${wrong}`)).toEqual([]);
});

test("iban: valid check digits only", () => {
  const valid = iban("30006000011234567890189");
  expect(valid).toBe("FR7630006000011234567890189");
  expect(findSecrets("FR76 3000 6000 0112 3456 7890 189")).toEqual([{ kind: "iban", value: valid }]);
  expect(findSecrets("FR76 3000 6000 0112 3456 7890 188")).toEqual([]);
});

test("nir: valid key only", () => {
  const body = "1850578006084";
  const key = nirKey(body);
  expect(findSecrets(`nir 1 85 05 78 006 084 ${key}`)).toEqual([{ kind: "nir", value: body + key }]);
  const bad = String((Number(key) % 97) + 1).padStart(2, "0");
  expect(findSecrets(`nir 1 85 05 78 006 084 ${bad}`)).toEqual([]);
  // Corsica: 2A counts as 19, 2B as 18.
  const corsica = "185052A006084";
  expect(kinds(corsica + nirKey("1850519006084"))).toEqual(["nir"]);
});

test("random: long, mixed and high-entropy", () => {
  expect(findSecrets("Zx8Kq2LmN9pRs4TuVw6YzA8bCdEf")).toEqual([{ kind: "random", value: "Zx8Kq2LmN9pRs4TuVw6YzA8bCdEf" }]);
});

test("encoded secrets are found", () => {
  const key = "sk" + "_live_51NxQk2LmN8pRs4TuVw6YzA8b";
  expect(findSecrets(`q=${Buffer.from(key).toString("base64")}`)).toEqual([{ kind: "api-key", value: key }]);
  expect(findSecrets(`q=${Buffer.from(key).toString("base64url")}`)).toEqual([{ kind: "api-key", value: key }]);
  expect(findSecrets("https://s.fr/?q=FR76%203000%206000%200112%203456%207890%20189")).toEqual([
    { kind: "iban", value: "FR7630006000011234567890189" },
  ]);
  expect(findSecrets("https://s.fr/?q=FR76%25203000%25206000%25200112%25203456%25207890%2520189")).toEqual([
    { kind: "iban", value: "FR7630006000011234567890189" },
  ]);
  const card = luhn("497010123456789");
  expect(findSecrets(Buffer.from(card).toString("hex"))).toEqual([{ kind: "card", value: card }]);
});

test("ordinary numbers are not secrets", () => {
  for (const text of [
    "vol AF1234 Paris Lisbonne 2027",
    "casque WH-1000XM5 prix 349 €",
    "75011",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://github.com/sveltejs/svelte/commit/9f2c1e7",
    "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE/edit",
    "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE/view",
    "utm_source=newsletter&gclid=Cj0KCQiA",
    "",
  ]) {
    expect(findSecrets(text), text).toEqual([]);
  }
});

test("variants: decodings, lowercased, plus a copy without separators, at most 32", () => {
  const v = variants("A%20B FR76 3000");
  expect(v).toContain("a%20b fr76 3000");
  expect(v).toContain("a b fr76 3000");
  expect(v).toContain("abfr763000");
  expect(variants(`${"aGVsbG8gd29ybGQgaGVsbG8= ".repeat(50)}%2541`).length).toBeLessThanOrEqual(32);
});

test("a 100 KB text stays fast", () => {
  const text = Array.from({ length: 6000 }, (_, i) => `mot${i} 4970 ${i} Zx8Kq2Lm/`).join(" ").slice(0, 100_000);
  const start = performance.now();
  findSecrets(text);
  expect(performance.now() - start).toBeLessThan(500);
});

test("mask", () => {
  expect(mask("FR7630006000011234567890189")).toBe("FR76••••0189");
  expect(mask("abc123xyz")).toBe("ab••••yz");
  expect(mask("0612345678")).toBe("06••••78");
  expect(mask("abc")).toBe("••••");
});

test("card next to other digits: expiry, CVV, a number before it", () => {
  const card = { kind: "card", value: "4970101234567893" };
  for (const text of [
    "carte 4970 1012 3456 7893 03/28",
    "carte 4970 1012 3456 7893 123",
    "4970101234567893 123",
    "ref 32 4970 1012 3456 7893",
  ])
    expect(findSecrets(text), text).toContainEqual(card);
  // Amex in its 4-6-5 grouping.
  const amex = luhn("37828224631000");
  expect(findSecrets(`${amex.slice(0, 4)} ${amex.slice(4, 10)} ${amex.slice(10)}`)).toEqual([{ kind: "card", value: amex }]);
});

test("card needs an issuer prefix, its length and a standard grouping", () => {
  const visa = luhn("497010123456789");
  expect(findSecrets(luhn("1970101234567"))).toEqual([]); // no issuer starts with 1
  expect(findSecrets(luhn("49701012345678"))).toEqual([]); // Visa is never 15 digits
  expect(findSecrets(`${visa.slice(0, 3)} ${visa.slice(3, 9)} ${visa.slice(9)}`)).toEqual([]); // 3-6-7
  expect(findSecrets(`${visa.slice(0, 4)}-${visa.slice(4, 8)} ${visa.slice(8, 12)}.${visa.slice(12)}`)).toEqual([]);
});

test("iban next to a BIC, a city or a year", () => {
  const iban = { kind: "iban", value: "FR7630006000011234567890189" };
  for (const text of [
    "FR76 3000 6000 0112 3456 7890 189 BIC",
    "iban FR76 3000 6000 0112 3456 7890 189 PARIS",
    "FR7630006000011234567890189 2026",
    "AB12 FR76 3000 6000 0112 3456 7890 189",
  ])
    expect(findSecrets(text), text).toContainEqual(iban);
});

test("lowercase iban and nir", () => {
  const iban = [{ kind: "iban", value: "FR7630006000011234567890189" }];
  expect(findSecrets("fr76 3000 6000 0112 3456 7890 189")).toEqual(iban);
  expect(findSecrets("fr7630006000011234567890189")).toEqual(iban);
  expect(kinds(`185052a006084${nirKey("1850519006084")}`)).toEqual(["nir"]);
});

test("ordinary digit runs are not cards", () => {
  let seed = 42;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const digits = (n: number) => Array.from({ length: n }, () => rand(10)).join("");
  const pad = (n: number) => String(n).padStart(2, "0");
  for (let i = 0; i < 300; i++) {
    for (const text of [
      `commande ${400 + rand(100)}-${digits(7)}-${digits(7)}`,
      `prix ${rand(1000)} ${rand(1000)} ${rand(1000)} ${rand(10000)} euros`,
      `${2000 + rand(40)}-${pad(1 + rand(12))}-${pad(1 + rand(28))} ${2000 + rand(40)}-${pad(1 + rand(12))}-${pad(1 + rand(28))}`,
      `id ${1 + rand(9)}${digits(12)}`,
    ])
      expect(findSecrets(text), text).toEqual([]);
  }
});

test("nested encodings", () => {
  const key = "sk" + "_live_51NxQk2LmN8pRs4TuVw6YzA8b";
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  expect(findSecrets(b64("q=FR76%203000%206000%200112%203456%207890%20189"))).toContainEqual({
    kind: "iban",
    value: "FR7630006000011234567890189",
  });
  expect(findSecrets(b64(b64(key)))).toContainEqual({ kind: "api-key", value: key });
  expect(findSecrets(Buffer.from(b64(key)).toString("hex"))).toContainEqual({ kind: "api-key", value: key });
});

test("1 MB of private key headers without an end stays fast", () => {
  const text = "-----BEGIN RSA PRIVATE KEY-----".repeat(34_000);
  const start = performance.now();
  expect(kinds(text)).toEqual(["private-key"]);
  expect(performance.now() - start).toBeLessThan(2000);
});

test("a readable slug is not a random secret, a secret padded into one still is", () => {
  expect(kinds("https://www.tripadvisor.fr/Hotels-g189158-Lisbon_Lisbon_District_Central_Portugal-Hotels.html")).toEqual([]);
  expect(kinds("https://www.fnac.com/Samsung-Galaxy-S25-6-2-5G-Double-nano-SIM-256-Go-Bleu-Marine/a21034567/w-4")).toEqual([]);
  expect(kinds("https://x.example/Hotel-Zx8Kq2LmN9pRs4TuVw6YzA8bCdEf-Paris-Lyon")).toEqual(["random"]);
  // Separators inside a random string do not make it a slug.
  expect(kinds("gen173nr-1FCAEoggI46AdIM1gEaE2IAQGYAQ24ARfIAQzYAQHoAQH4AQuIAgGoAgO4AqKX87kGwAIB0gIkYjQ5")).toEqual(["random"]);
});

test("a separator in a random string does not shorten it", () => {
  expect(kinds("Zx8Kq2LmN9p-Rs4TuVw6YzA8")).toEqual(["random"]);
  expect(kinds("Zx8Kq2LmN9p_Rs4TuVw6YzA8")).toEqual(["random"]);
});

test("256 KB of Google Docs host names stays fast", () => {
  const text = "docs.google.com/".repeat(16_384);
  const start = performance.now();
  findSecrets(text);
  expect(performance.now() - start).toBeLessThan(100);
});

test("numbers spaced as French pages print them are still found", () => {
  const card = luhn("497010123456789");
  const groups = card.match(/\d{4}/g)!;
  for (const sep of [" ", " ", "  ", "/", "_", ","])
    expect(findSecrets(`carte ${groups.join(sep)}`), JSON.stringify(sep)).toEqual([{ kind: "card", value: card }]);
  const valid = "FR7630006000011234567890189";
  for (const sep of [".", "-", " ", " "])
    expect(findSecrets(`FR76${sep}3000${sep}6000${sep}0112${sep}3456${sep}7890${sep}189`), JSON.stringify(sep)).toEqual([{ kind: "iban", value: valid }]);
  const body = "1850578006084";
  const key = nirKey(body);
  expect(findSecrets(`nir 1 85 05 78 006 084 ${key}`)).toEqual([{ kind: "nir", value: body + key }]);
  // Full-width digits read as their ASCII form.
  const wide = card.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)));
  expect(findSecrets(`carte ${wide}`)).toEqual([{ kind: "card", value: card }]);
});

test("mask shows at most half of a value", () => {
  for (const v of ["0612345678", "FR7630006000011234567890189", "abc123xyz", "ab", "4970101234567893"]) {
    const shown = mask(v).replace(/•/g, "").length;
    expect(shown, v).toBeLessThanOrEqual(Math.floor(v.length / 2));
  }
});
