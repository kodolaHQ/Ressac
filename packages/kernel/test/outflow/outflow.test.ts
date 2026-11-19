import { expect, test } from "vitest";
import { Outflow } from "../../src/outflow/outflow.js";

const IBAN = "FR7630006000011234567890189";
const SPACED_IBAN = "FR76 3000 6000 0112 3456 7890 189";

test("rule 1 without a read", () => {
  const o = new Outflow();
  const hit = o.check("w", "pnpm fix ghp_x7Kq9LmN2pRs4TuVw6YzA8bCdEfGhJ1kMn3P");
  expect(hit).toEqual({ kind: "api-key", masked: "ghp_••••Mn3P" });
});

test("read item comes back", () => {
  const o = new Outflow();
  o.read("w", `Solde 14382.17 € — IBAN ${SPACED_IBAN}`, "clients.boursobank.com");
  expect(o.check("w", `https://x.example/fee?i=${IBAN}`)).toMatchObject({
    kind: "iban",
    source: "clients.boursobank.com",
  });
});

test("read e-mail comes back encoded", () => {
  const o = new Outflow();
  o.read("w", "De : camille.roussel@example.com", "mail.google.com");
  expect(o.check("w", "https://x.example/t?acct=camille.roussel%40example.com")).toMatchObject({
    kind: "email",
    source: "mail.google.com",
  });
  expect(o.check("w", "https://x.example/t?q=Y2FtaWxsZS5yb3Vzc2VsQGV4YW1wbGUuY29t")).toMatchObject({ kind: "email" });
});

test("chunk of a retained token hits", () => {
  const o = new Outflow();
  o.read("w", "key: sk_live_51NxQk2LmN8pRs4TuVw6YzA8bCdEf", "dashboard.stripe.com");
  expect(o.check("w", "trials 51NxQk2LmN")).toMatchObject({ source: "dashboard.stripe.com" });
});

test("a 6-digit chunk of a read number hits, a 5-digit one does not", () => {
  const o = new Outflow();
  o.read("w", "Commande n° 48213977 expédiée", "shop.example");
  expect(o.check("w", "suivi 821397")).toMatchObject({ kind: "digits" });
  expect(o.check("w", "suivi 82139")).toBeUndefined();
});

test("read phone numbers come back without separators", () => {
  const o = new Outflow();
  o.read("w", "Tél. 06 12 34 56 78 ou +33 1 42 68 53 00", "contacts.google.com");
  expect(o.check("w", "qui appelle 0612345678")).toMatchObject({ kind: "phone" });
  expect(o.check("w", "annuaire 33142685300")).toMatchObject({ kind: "phone" });
});

test("an e-mail not read is not a hit", () => {
  expect(new Outflow().check("w", "contact jean.dupont@example.org")).toBeUndefined();
});

test("typed paste whitelists re-spaced digits", () => {
  const o = new Outflow();
  o.typed("w", `\x1b[200~${IBAN}\x1b[201~ cherche ma banque\r`);
  o.read("w", `IBAN ${SPACED_IBAN}`, "clients.boursobank.com");
  expect(o.check("w", `https://search.example/?q=${SPACED_IBAN}`)).toBeUndefined();
});

test("a typed secret is not a rule-1 hit", () => {
  const o = new Outflow();
  o.typed("w", "utilise ghp_x7Kq9LmN2pRs4TuVw6YzA8bCdEfGhJ1kMn3P\r");
  expect(o.check("w", "pnpm fix ghp_x7Kq9LmN2pRs4TuVw6YzA8bCdEfGhJ1kMn3P")).toBeUndefined();
});

test("rule 1 hit carries the source when the secret was read", () => {
  const o = new Outflow();
  o.read("w", "token ghp_x7Kq9LmN2pRs4TuVw6YzA8bCdEfGhJ1kMn3P", "github.com");
  expect(o.check("w", "x ghp_x7Kq9LmN2pRs4TuVw6YzA8bCdEfGhJ1kMn3P")).toEqual({
    kind: "api-key",
    masked: "ghp_••••Mn3P",
    source: "github.com",
  });
});

test("windows are separate", () => {
  const o = new Outflow();
  o.typed("a", `${IBAN}\r`);
  o.read("b", `IBAN ${SPACED_IBAN}`, "clients.boursobank.com");
  expect(o.check("b", `q=${IBAN}`)).toMatchObject({ kind: "iban" });
  expect(o.check("a", `q=${IBAN}`)).toBeUndefined();
});

test("lastMessage", () => {
  const o = new Outflow();
  expect(o.lastMessage("w")).toBeUndefined();
  o.typed("w", "trouve un vélo\r");
  expect(o.lastMessage("w")).toBe("trouve un vélo");
  o.typed("w", "pas \x1b[Acher");
  expect(o.lastMessage("w")).toBe("pas cher");
  o.typed("w", "\r");
  expect(o.lastMessage("w")).toBe("pas cher");
});

test("typed escapes, paste returns, backspace and clear keys", () => {
  const o = new Outflow();
  o.typed("w", "\x1b]0;title\x07\x1bOAab\x1b[1;5Dc\x7f\x08d\x1bxe");
  expect(o.lastMessage("w")).toBe("ade");
  o.typed("w", "\x1b[200~ligne 1\rligne 2\x1b[201~");
  expect(o.lastMessage("w")).toBe("ade" + "ligne 1\nligne 2");
  o.typed("w", "\x15effacé\x03neuf\x1b]2;t\x1b\\\r");
  expect(o.lastMessage("w")).toBe("neuf");
});

test("an escape split across chunks is still stripped", () => {
  const o = new Outflow();
  o.typed("w", "a\x1b");
  o.typed("w", "[20");
  o.typed("w", "0~b\rc\x1b[201~");
  expect(o.lastMessage("w")).toBe("ab\nc");
});

test("forget clears read and typed for that window only", () => {
  const o = new Outflow();
  for (const w of ["a", "b"]) {
    o.read(w, "camille.roussel@example.com", "mail.google.com");
    o.typed(w, "bonjour\r");
  }
  o.forget("a");
  expect(o.check("a", "camille.roussel@example.com")).toBeUndefined();
  expect(o.lastMessage("a")).toBeUndefined();
  expect(o.check("b", "camille.roussel@example.com")).toMatchObject({ kind: "email" });
  expect(o.lastMessage("b")).toBe("bonjour");
});

test("oldest read items are dropped past 5 000", () => {
  const o = new Outflow();
  o.read("w", "tok A1b2C3d4E5f6G7h8", "first");
  for (let i = 0; i < 5000; i++) o.read("w", `id Zz${String(i).padStart(6, "0")}QqWw`, "page");
  expect(o.check("w", "A1b2C3d4E5f6G7h8")).toBeUndefined();
  expect(o.check("w", "Zz004999QqWw")).toMatchObject({ source: "page" });
});

test("check stays fast with 5 000 items and a 2 KB URL", () => {
  const o = new Outflow();
  const items = Array.from({ length: 5000 }, (_, i) => `ref${i}x${(i * 7919).toString(36)}Kq${i % 97}zz9`);
  o.read("w", items.join(" "), "page");
  // Encoded text the decoder expands into many variants, none of them a hit: the worst case scans every piece.
  const text = encodeURIComponent(encodeURIComponent("vélo rouge n° 2024-11 pas cher, Paris 75011 & aGVsbG8gd29ybGQ= "));
  const url = `https://x.example/s?q=${text.repeat(30)}`.slice(0, 2048);
  o.check("w", url);
  const start = performance.now();
  expect(o.check("w", url)).toBeUndefined();
  expect(performance.now() - start).toBeLessThan(50);
});
