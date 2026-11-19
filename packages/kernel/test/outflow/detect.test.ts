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
    "sk_live_51NxQk2LmN8pRs4TuVw6YzA8b",
    "sk_test_51NxQk2LmN8pRs4TuVw6YzA8b",
    "rk_live_51NxQk2LmN8pRs4TuVw6YzA8b",
    "whsec_9aBcD3fGhJ5kLmN7pQrS1tUv",
    "ghp_x7Kq9LmN2pRs4TuVw6YzA8bCdEfGhJ1kMn3P",
    "gho_x7Kq9LmN2pRs4TuVw6YzA8bCdEfGhJ1kMn3P",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234",
    "xoxb-1234-5678-abcd",
    "AKIAIOSFODNN7EXAMPLE",
    "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
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
  const key = "sk_live_51NxQk2LmN8pRs4TuVw6YzA8b";
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
  expect(mask("abc123xyz")).toBe("ab••••");
});
