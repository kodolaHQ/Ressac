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
  o.read("w", "key: sk" + "_live_51NxQk2LmN8pRs4TuVw6YzA8bCdEf", "dashboard.stripe.com");
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

// What the user typed is never a leak: these tests see the typed text through check().
const MAIL = "camille.roussel@example.com";
const typedThenRead = (...chunks: string[]) => {
  const o = new Outflow();
  for (const c of chunks) o.typed("w", c);
  o.read("w", MAIL, "mail.google.com");
  return o.check("w", MAIL);
};

test("typed escapes, paste returns, backspace and clear keys", () => {
  expect(typedThenRead("\x1b]0;title\x07\x1bOAcamille.rx\x7foussel@exa\x1b[1;5Dmple.com\r")).toBeUndefined();
  expect(typedThenRead("\x1b[200~ligne 1\r" + MAIL + "\x1b[201~\r")).toBeUndefined();
  // Cleared before it was sent: not the user's.
  expect(typedThenRead("\x15" + MAIL + "\x03neuf\r")).toMatchObject({ kind: "email" });
});

test("an escape split across chunks is still stripped", () => {
  expect(typedThenRead("camille.rous\x1b", "[20", "0~sel@example.com\x1b[201~\r")).toBeUndefined();
});

test("forget clears read and typed for that window only", () => {
  const o = new Outflow();
  for (const w of ["a", "b"]) {
    o.read(w, "camille.roussel@example.com", "mail.google.com");
    o.typed(w, "bonjour\r");
  }
  o.forget("a");
  expect(o.check("a", "camille.roussel@example.com")).toBeUndefined();
  expect(o.check("b", "camille.roussel@example.com")).toMatchObject({ kind: "email" });
});

test("oldest read items are dropped past 20 000", () => {
  const o = new Outflow();
  o.read("w", "tok A1b2C3d4E5f6G7h8", "first");
  // Each read retains a token and its digit run.
  for (let i = 0; i < 10_000; i++) o.read("w", `id Zz${String(i).padStart(6, "0")}QqWw`, "page");
  expect(o.check("w", "A1b2C3d4E5f6G7h8")).toBeUndefined();
  expect(o.check("w", "Zz004999QqWw")).toMatchObject({ source: "page" });
});

test("check stays fast with 20 000 items and a 2 KB URL", () => {
  const o = new Outflow();
  const items = Array.from({ length: 20_000 }, (_, i) => `ref${i}x${(i * 7919).toString(36)}Kq${i % 97}zz9`);
  for (let i = 0; i < items.length; i += 500) o.read("w", items.slice(i, i + 500).join(" "), "page");
  // Encoded text the decoder expands into many variants, none of them a hit: the worst case scans every piece.
  const text = encodeURIComponent(encodeURIComponent("vélo rouge n° 2024-11 pas cher, Paris 75011 & aGVsbG8gd29ybGQ= "));
  const url = `https://x.example/s?q=${text.repeat(30)}`.slice(0, 2048);
  o.check("w", url);
  const start = performance.now();
  expect(o.check("w", url)).toBeUndefined();
  expect(performance.now() - start).toBeLessThan(50);
});

test("read and typed stay linear on long runs", () => {
  const o = new Outflow();
  const hex = Array.from({ length: 1 << 20 }, (_, i) => "0123456789abcdef"[(i * 7919) % 16]).join("");
  for (const blob of ["a".repeat(100_000), `${"a".repeat(100_000)}@`, hex]) {
    const start = performance.now();
    o.read("w", blob, "page");
    o.typed("w", blob);
    expect(performance.now() - start).toBeLessThan(2000);
  }
});

test("a chunk of an e-mail's domain alone does not hit, one of its local part does", () => {
  const o = new Outflow();
  o.read("w", "De : jean.dupont@gmail.com", "mail.google.com");
  expect(o.check("w", "https://www.gmail.com/settings")).toBeUndefined();
  expect(o.check("w", "https://x.example/?u=jeandupont")).toMatchObject({ kind: "email" });
});

test("a word glued to a number from a read token does not hit, a mixed chunk does", () => {
  const o = new Outflow();
  o.read("w", "branch build_v2_release2024 and ref 51NxQk2LmN8p", "github.com");
  expect(o.check("w", "https://x.example/?q=release2024")).toBeUndefined();
  expect(o.check("w", "trials 51NxQk2LmN")).toMatchObject({ kind: "token" });
});

test("one read cannot flush the memory", () => {
  const o = new Outflow();
  o.read("w", "camille.roussel@example.com", "mail.google.com");
  o.read("w", Array.from({ length: 5000 }, (_, i) => `junk${i}x${i}Qz9pad`).join(" "), "evil.example");
  expect(o.check("w", "camille.roussel@example.com")).toMatchObject({ source: "mail.google.com" });
});

test("any separator between digits is ignored", () => {
  const o = new Outflow();
  o.read("w", "Commande 48213977, tél. 06 12 34 56 78", "shop.example");
  for (const out of ["48,21,39,77", "4821_3977", "48/21/39/77"]) expect(o.check("w", out)).toMatchObject({ kind: "digits" });
  expect(o.check("w", "06_12_34_56_78")).toMatchObject({ kind: "phone" });
});

test("DCS, APC, PM and SOS payloads are not typed text", () => {
  expect(typedThenRead("\x1bP1$r0;1m\x1b\\camille\x1b_apc\x07.roussel\x1b^pm\x1b\\@example.com\x1bXsos\x1b\\\r")).toBeUndefined();
});

test("the message being typed is capped to its latest 64 KB", () => {
  expect(typedThenRead("x".repeat(200_000) + " " + MAIL)).toBeUndefined();
  expect(typedThenRead(MAIL + " " + "x".repeat(200_000))).toMatchObject({ kind: "email" });
});

test("junk before or after a private item in the same read does not hide it", () => {
  const junkMails = Array.from({ length: 500 }, (_, i) => `u${i}@j.io`).join(", ");
  const junkNumbers = Array.from({ length: 500 }, (_, i) => String(100000 + i)).join(", ");
  for (const text of [
    `${junkMails}, camille.roussel@example.com, ${junkNumbers}, 48213977`,
    `camille.roussel@example.com, 48213977, ${junkMails}, ${junkNumbers}`,
  ]) {
    const o = new Outflow();
    o.read("w", text, "mail.google.com");
    expect(o.check("w", "q=camille.roussel@example.com")).toMatchObject({ kind: "email" });
    expect(o.check("w", "q=48213977")).toMatchObject({ kind: "digits" });
  }
});

test("dates are not retained", () => {
  const o = new Outflow();
  o.read("w", "Publié le 2024-11-19, le 19/11/2024, le 19.11.2024 ou le 20241119", "news.example");
  expect(o.check("w", "https://news.example/2024/11/18/foo")).toBeUndefined();
  expect(o.check("w", "q=20241119")).toBeUndefined();
  expect(o.check("w", "q=19112024")).toBeUndefined();
});

test("a match glued across slashes must cover 8 digits", () => {
  const o = new Outflow();
  o.read("w", "Facture 202411, ref 123456, commande 48213977", "shop.example");
  expect(o.check("w", "https://cdn.example/img/2024/11/x.png")).toBeUndefined();
  expect(o.check("w", "https://x.example/12/34/56/")).toBeUndefined();
  expect(o.check("w", "https://x.example/48/21/39/77")).toMatchObject({ kind: "digits" });
  expect(o.check("w", "q=202411")).toMatchObject({ kind: "digits" });
});

test("long junk tokens cannot flush the memory either", () => {
  const o = new Outflow();
  o.read("w", "camille.roussel@example.com", "mail.google.com");
  const long = (i: number) => `k${i}x9Q`.repeat(40);
  o.read("w", Array.from({ length: 2000 }, (_, i) => long(i)).join(" "), "evil.example");
  expect(o.check("w", "camille.roussel@example.com")).toMatchObject({ source: "mail.google.com" });
});

test("many items sharing a piece keep reads fast", () => {
  const o = new Outflow();
  for (let r = 0; r < 20; r++) {
    const text = Array.from({ length: 2000 }, (_, i) => "000000" + String(r * 2000 + i).padStart(6, "0")).join(", ");
    const start = performance.now();
    o.read("w", text, "page");
    expect(performance.now() - start).toBeLessThan(300);
  }
});

test("slashes between characters do not hide an e-mail or a token", () => {
  const o = new Outflow();
  o.read("w", "camille.roussel@example.com, ref Zx81Qa92Lp07Wm33", "mail.google.com");
  expect(o.check("w", "https://x.example/c/a/m/i/l/l/e/r/o/u/s/s/e/l@example.com")).toMatchObject({ kind: "email" });
  expect(o.check("w", "https://x.example/Zx81/Qa92/Lp07/Wm33")).toMatchObject({ kind: "token" });
});

test("a date glued to a time or a number is not retained with it", () => {
  for (const [read, out] of [
    ["Publié le 2024-11-19 12:30", "https://news.example/2024/11/19/foo"],
    ["Le 2024-11-19 2 commentaires", "https://news.example/2024/11/19/foo"],
    ["Facture 2024-11 001234", "https://cdn.example/2024/11/00/x.png"],
  ] as const) {
    const o = new Outflow();
    o.read("w", read, "news.example");
    expect(o.check("w", out)).toBeUndefined();
  }
  const o = new Outflow();
  o.read("w", "Facture 2024-11 001234", "shop.example");
  expect(o.check("w", "q=001234")).toMatchObject({ kind: "digits" });
});

test("padding of one kind does not hide an item of another kind", () => {
  const o = new Outflow();
  const numbers = Array.from({ length: 5000 }, (_, i) => String(100000 + i)).join(", ");
  o.read("w", `${numbers}, camille.roussel@example.com`, "mail.google.com");
  expect(o.check("w", "q=camille.roussel@example.com")).toMatchObject({ kind: "email" });
});

test("padding of two kinds does not hide items of the other kinds", () => {
  const numbers = Array.from({ length: 5000 }, (_, i) => String(100000 + i)).join(", ");
  const tokens = Array.from({ length: 5000 }, (_, i) => `Qz${100000 + i}pad9x`).join(" ");
  const phones = Array.from({ length: 5000 }, (_, i) => `07 ${String(10000000 + i).replace(/(..)(?=.)/g, "$1 ")}`).join(", ");
  const real = "camille.roussel@example.com, 06 12 34 56 78, ref Zx81Qa92Lp07Wm33";

  const o = new Outflow();
  o.read("w", `${numbers} ${tokens} ${real}`, "mail.google.com");
  expect(o.check("w", "q=camille.roussel@example.com")).toMatchObject({ kind: "email" });
  expect(o.check("w", "q=0612345678")).toMatchObject({ kind: "phone" });

  const p = new Outflow();
  p.read("w", `${numbers} ${phones} ${real}`, "mail.google.com");
  expect(p.check("w", "q=camille.roussel@example.com")).toMatchObject({ kind: "email" });
  expect(p.check("w", "q=Zx81Qa92Lp07Wm33")).toMatchObject({ kind: "token" });
});

test("one read padded with every kind cannot flush the memory", () => {
  const o = new Outflow();
  o.read("w", "tok A1b2C3d4E5f6G7h8", "first");
  const pad = Array.from(
    { length: 5000 },
    (_, i) => `${100000 + i}, junk${i}x${i}Qz9pad, u${i}@j.io, +33 7 ${String(10000000 + i)}`,
  ).join(" ");
  o.read("w", pad, "evil.example");
  expect(o.check("w", "A1b2C3d4E5f6G7h8")).toMatchObject({ source: "first" });
});

test("evicting an item whose piece repeats keeps the other owner of that piece", () => {
  const o = new Outflow();
  o.read("w", "id 482139-555-482139", "old");
  o.read("w", "code 482139", "kept");
  // Each read retains a token and its digit run: with the last one, 20 001 items, so only the first is evicted.
  for (let i = 0; i < 9_999; i++) o.read("w", `id Zz${String(i).padStart(6, "0")}QqWw`, "page");
  o.read("w", "n 771234", "page");
  expect(o.check("w", "q=139555")).toBeUndefined();
  expect(o.check("w", "q=482139")).toMatchObject({ source: "kept" });
});

test("a slug read in a tab's address is not an identifier, a code glued to a word is", () => {
  const o = new Outflow();
  o.read("w", "t3 · The Verge · https://www.theverge.com/2026/11/10/apple-macbook-air-m5-announcement-price-specs · Perso", "tes onglets");
  expect(o.check("w", "MacBook Air M5 autonomie prix France date de sortie")).toBeUndefined();
  o.read("w", "Votre dossier : order-AB12CD34EF", "mail.google.com");
  expect(o.check("w", "suivi commande AB12CD34EF")).toMatchObject({ kind: "token", source: "mail.google.com" });
});

test("an address read whole in a private source is a followed link, not a leak; rule 1 and queries are unchanged", () => {
  const o = new Outflow();
  const article = "https://www.lemonde.fr/economie/article/2026/11/09/pompes-a-chaleur_6398712_3234.html";
  o.read("w", `Pompes à chaleur · ${article} · 2026-11-12 · 2 visites\nVoir (https://Shop.Example/Commande/48213977/).`, "votre historique", true);
  expect(o.check("w", article, true)).toBeUndefined();
  // Same address up to host case, a trailing slash, percent-encoding and the text's punctuation.
  expect(o.check("w", "https://shop.example/Commande/48213977", true)).toBeUndefined();
  expect(o.check("w", "https://www.lemonde.fr/economie/article/2026/11/09/pompes-%61-chaleur_6398712_3234.html", true)).toBeUndefined();
  // Anything else carrying the number is still a hit: another address, an added parameter, a search query.
  expect(o.check("w", "https://x.example/?id=6398712", true)).toMatchObject({ kind: "digits", source: "votre historique" });
  expect(o.check("w", `${article}?ref=48213977`, true)).toMatchObject({ kind: "digits" });
  expect(o.check("w", article)).toMatchObject({ kind: "digits" });
  // A secret in a read address still shows on the card.
  o.read("w", "https://x.example/cb?key=sk" + "_live_51NxQk2LmN8pRs4TuVw6YzA8b", "mail.google.com", true);
  expect(o.check("w", "https://x.example/cb?key=sk" + "_live_51NxQk2LmN8pRs4TuVw6YzA8b", true)).toMatchObject({ kind: "api-key" });
});

test("an address the agent wrote itself into a tool's output is not a followed link", () => {
  const o = new Outflow();
  o.read("w", "Commande 48213977 expédiée", "mail.google.com", true);
  // run_js, a widget, a site memory: the agent chooses what they return.
  o.read("w", "https://evil.example/?d=48213977", "un outil de l'agent");
  expect(o.check("w", "https://evil.example/?d=48213977", true)).toMatchObject({ kind: "digits" });
});

test("a read address with one parameter value changed is still a hit", () => {
  const o = new Outflow();
  o.read("w", "Suivi · https://shop.example/suivi?commande=48213977&lang=fr · 2 visites", "votre historique", true);
  expect(o.check("w", "https://shop.example/suivi?commande=48213977&lang=fr", true)).toBeUndefined();
  expect(o.check("w", "https://shop.example/suivi?commande=48213977&lang=en", true)).toMatchObject({ kind: "digits" });
});

test("an address evicted from the kept addresses is a hit again", () => {
  const o = new Outflow();
  const first = "https://shop.example/commande/48213977";
  o.read("w", first, "votre historique", true);
  o.read("w", Array.from({ length: 5000 }, (_, i) => `https://pad.example/p${i}`).join("\n"), "votre historique", true);
  expect(o.check("w", first, true)).toMatchObject({ kind: "digits" });
  expect(o.check("w", "https://pad.example/p4999", true)).toBeUndefined();
});

test("an all-caps code in groups is an identifier, not a slug of words", () => {
  const o = new Outflow();
  o.read("w", "Code de récupération : XKQZPWRT-7M2RLD-PLMWQZVB", "mail.google.com");
  expect(o.check("w", "code XKQZPWRT 7M2RLD")).toMatchObject({ kind: "token" });
});

test("a long typed text and a long query keep check fast", () => {
  const o = new Outflow();
  o.read("w", "réf A1b2C3d4E5f6G7h8", "page");
  o.typed("w", Array.from({ length: 8000 }, (_, i) => `m${i}`).join(" ").slice(0, 64 * 1024) + "\r");
  const query = Array.from({ length: 4000 }, (_, i) => `q${i}`).join(" ").slice(0, 20_000);
  o.check("w", query);
  const start = performance.now();
  expect(o.check("w", query)).toBeUndefined();
  expect(performance.now() - start).toBeLessThan(150);
});

test("a number read with no-break spaces or full-width digits comes back", () => {
  const o = new Outflow();
  o.read("w", "Tél. 06 12 34 56 78", "mail.google.com");
  expect(o.check("w", "0612345678")).toMatchObject({ kind: "phone", source: "mail.google.com" });
  const wide = "０６１２３４５６７８";
  expect(o.check("w", `appel ${wide}`)).toMatchObject({ source: "mail.google.com" });
});

test("forgetTyped clears what was typed, not what was read", () => {
  const o = new Outflow();
  o.read("w", "camille.roussel@example.com", "mail.google.com");
  o.typed("w", "écris à camille.roussel@example.com\r");
  expect(o.check("w", "camille.roussel@example.com")).toBeUndefined();
  o.forgetTyped("w");
  expect(o.check("w", "camille.roussel@example.com")).toMatchObject({ kind: "email" });
});

test("short mixed identifiers read in a private page come back", () => {
  const o = new Outflow();
  o.read("w", "Laboratoire. Dossier BX2291KQ7. Code porte 4827B.", "historique");
  expect(o.check("w", "BX2291KQ7")).toMatchObject({ kind: "token", source: "historique" });
  expect(o.check("w", "dossier bx2291kq7 résultats")).toMatchObject({ kind: "token" });
  expect(o.check("w", "lockers code 4827B")).toMatchObject({ kind: "token" });
});

test("public model names in a private page are not items", () => {
  const o = new Outflow();
  o.read("w", "Votre commande : RTX4090, iPhone15, MacBook M5, vol A350, test COVID19.", "mail.example.fr");
  for (const q of ["prix RTX4090", "iPhone15 avis", "A350 sièges", "COVID19 test"]) expect(o.check("w", q)).toBeUndefined();
});

test("a short identifier the user typed is theirs to send", () => {
  const o = new Outflow();
  o.read("w", "Code porte 4827B.", "mail.example.fr");
  o.typed("w", "mon code est 4827B\r");
  expect(o.check("w", "code 4827B")).toBeUndefined();
});

test("everyday quantities, dimensions, periods and model names are not items", () => {
  const words = ["256GB", "500mg", "100km", "1920x1080", "GTX1080Ti", "2024Q3", "4K", "10x"];
  const o = new Outflow();
  o.read("w", `Commande : ${words.join(", ")}, code 69005A.`, "mail.example.fr");
  for (const x of words) expect(o.check("w", `avis ${x}`)).toBeUndefined();
  expect(o.check("w", "69005A")).toMatchObject({ kind: "token" });
});

test("a read code written as words comes back", () => {
  const o = new Outflow();
  o.read("w", "Votre code de vérification : 381 624. Code porte 4827B.", "mail.example.fr");
  expect(o.check("w", "code de verification trois huit un six deux quatre")).toMatchObject({ kind: "digits" });
  expect(o.check("w", "code porte quatre huit deux sept B")).toMatchObject({ kind: "token" });
});
test("a read code written in CJK numerals comes back", () => {
  const o = new Outflow();
  o.read("w", "Votre code de vérification : 381 624.", "mail.example.fr");
  expect(o.check("w", "コード三八一六二四")).toMatchObject({ kind: "digits" });
});

test("a word read two ways in a run still hits", () => {
  const read = (text: string) => {
    const o = new Outflow();
    o.read("w", text, "mail.example.fr");
    return o;
  };
  expect(read("Kode : 391 934.").check("w", "tre ni en ni tre fire")).toMatchObject({ kind: "digits" });
  expect(read("Ma : 391 934.").check("w", "ba chin mot chin ba bon")).toMatchObject({ kind: "digits" });
  expect(read("Kode : 351 352.").check("w", "kode tiga lima satu tiga lima dua")).toMatchObject({ kind: "digits" });
});

test("a value split over searches, digits as words, is caught", () => {
  const o = new Outflow();
  o.read("w", "Identifiant client 70418825", "banque.example.fr");
  o.sent("w", "frais-compte verif sept zéro quatre");
  o.sent("w", "frais-compte verif un huit huit");
  expect(o.check("w", "frais-compte verif deux cinq")).toMatchObject({ kind: "digits" });
});
test("a third code-like part pauses even when nothing matches", () => {
  const o = new Outflow();
  o.read("w", "Bonjour", "mail.example.fr"); // a private read, no item
  o.sent("w", "annecy-tarif-verif 3 8"); o.sent("w", "annecy-tarif-verif 1 6");
  expect(o.check("w", "annecy-tarif-verif 2 4")).toMatchObject({ kind: "series" });
});
test("ordinary series do not pause", () => {
  const o = new Outflow();
  o.read("w", "Code 381 624", "mail.example.fr");
  for (const q of ["horaires TER samedi", "horaires TER dimanche"]) o.sent("w", q);
  expect(o.check("w", "horaires TER lundi")).toBeUndefined();
  for (const q of ["recette gratin 4 personnes", "recette gratin 6 personnes"]) o.sent("w", q);
  expect(o.check("w", "recette gratin 8 personnes")).toBeUndefined();
});
test("no series before a private read, and a new conversation starts over", () => {
  const o = new Outflow();
  o.sent("w", "verif 3 8"); o.sent("w", "verif 1 6");
  expect(o.check("w", "verif 2 4")).toBeUndefined();
  o.read("w", "Code 381 624", "mail.example.fr");
  o.sent("w", "verif 3 8"); o.sent("w", "verif 1 6"); o.forgetTyped("w");
  expect(o.check("w", "verif 2 4")).toBeUndefined();
});
test("a series part the user typed does not count; addresses are not series", () => {
  const o = new Outflow();
  o.read("w", "Bonjour", "mail.example.fr");
  o.typed("w", "cherche le tarif 2 4\r");
  o.sent("w", "annecy-tarif-verif 3 8"); o.sent("w", "annecy-tarif-verif 1 6");
  expect(o.check("w", "annecy-tarif-verif 2 4")).toBeUndefined();
  expect(o.check("w", "annecy-tarif-verif 5 7", true)).toBeUndefined();
  expect(o.check("w", "annecy-tarif-verif 5 7")).toMatchObject({ kind: "series", masked: "3 8 · 1 6 · 5 7" });
});
test("only the last 20 searches are kept", () => {
  const o = new Outflow();
  o.read("w", "Bonjour", "mail.example.fr");
  o.sent("w", "annecy-tarif-verif 3 8"); o.sent("w", "annecy-tarif-verif 1 6");
  for (let i = 0; i < 20; i++) o.sent("w", `météo ville ${i}`);
  expect(o.check("w", "annecy-tarif-verif 2 4")).toBeUndefined();
});
test("series of whole numbers stay quiet after a private read", () => {
  const series = [
    ["vol Paris Lyon 12 mars", "vol Paris Lyon 13 mars", "vol Paris Lyon 14 mars"],
    ["taille 38", "taille 40", "taille 42"],
    ["iphone 15 prix", "iphone 16 prix", "iphone 17 prix"],
    ["boulangerie 69001", "boulangerie 69002", "boulangerie 69003"],
    ["horaires bus ligne 12", "horaires bus ligne 34", "horaires bus ligne 56"],
    ["meilleurs films 2021", "meilleurs films 2022", "meilleurs films 2023"],
    Array.from({ length: 8 }, (_, i) => `vol Paris Lyon ${10 + i} mars`),
  ];
  for (const qs of series) {
    const o = new Outflow();
    o.read("w", "Bonjour", "mail.example.fr");
    for (const q of qs) {
      expect(o.check("w", q), q).toBeUndefined();
      o.sent("w", q);
    }
  }
});
test("series of decimals, fractions, versions and formations stay quiet after a private read", () => {
  const series = [
    ["1/2 cup butter in grams", "1/3 cup butter in grams", "3/4 cup butter in grams"],
    ["riz basmati 1,5 kg prix", "riz basmati 2,5 kg prix", "riz basmati 4,5 kg prix"],
    ["pression pneu clio 2.2 bar", "pression pneu clio 2.4 bar", "pression pneu clio 2.6 bar"],
    ["nike pegasus taille 7.5 us", "nike pegasus taille 8.5 us", "nike pegasus taille 9.5 us"],
    ["changelog vite 5.1.0", "changelog vite 5.2.0", "changelog vite 5.3.0"],
    ["formation 4-4-2 football", "formation 4-3-3 football", "formation 3-5-2 football"],
    ["objectif f/1.8 portrait", "objectif f/2.8 portrait", "objectif f/4 portrait"],
  ];
  for (const qs of series) {
    const o = new Outflow();
    o.read("w", "Bonjour, à bientôt.", "mail.example.fr");
    for (const q of qs) {
      expect(o.check("w", q), q).toBeUndefined();
      o.sent("w", q);
    }
  }
});
test("a read value split as decimals over searches is caught by the joined parts", () => {
  const o = new Outflow();
  o.read("w", "Votre code de vérification : 381 624.", "mail.example.fr");
  o.sent("w", "annecy-tarif-verif 3.8"); o.sent("w", "annecy-tarif-verif 1.6");
  expect(o.check("w", "annecy-tarif-verif 2.4")).toMatchObject({ kind: "digits" });
});
test("times, durations, sizes, packs, units and digit-led model names are not items", () => {
  const words = ["14h30", "1h45min", "160x90cm", "2560x1440px", "2x500g", "6x33cl", "1500kcal", "7500rpm", "i9-13900KF", "i7-12700K", "R7-7800X3D", "7800X3D", "RTX4090 24GB", "A320neo", "737MAX"];
  const o = new Outflow();
  o.read("w", `Commande : ${words.join(", ")}. Dossier BX2291KQ7, code porte 4827B, code 69005A.`, "mail.example.fr");
  for (const x of [...words, "13900KF"]) expect(o.check("w", `avis ${x}`), x).toBeUndefined();
  for (const x of ["BX2291KQ7", "4827B", "69005A"]) expect(o.check("w", x), x).toMatchObject({ kind: "token" });
});
test("a read code mixed with numerals, NATO words or zero-width characters comes back", () => {
  const o = new Outflow();
  o.read("w", "Votre code de vérification : 381 624. Dossier BX2291KQ7.", "mail.example.fr");
  expect(o.check("w", "code 3 huit 1 six 2 quatre")).toMatchObject({ kind: "digits" });
  expect(o.check("w", "bravo xray 2291 kilo quebec 7")).toMatchObject({ kind: "token" });
  expect(o.check("w", "code tr​ois hu​it un six deux quatre")).toMatchObject({ kind: "digits" });
});
test("a read code in romanised Russian, Greek or Hindi words comes back", () => {
  const o = new Outflow();
  o.read("w", "Votre code de vérification : 381 624.", "mail.example.fr");
  for (const q of [
    "kod tri vosem odin shest dva chetyre",
    "κωδικός τρία οκτώ ένα έξι δύο τέσσερα",
    "κωδικος τρια οχτω ενα εξι δυο τεσσερα",
    "कोड तीन आठ एक छह दो चार",
  ])
    expect(o.check("w", q), q).toMatchObject({ kind: "digits" });
});
test("a read code in Eastern Arabic, Persian or Devanagari digits comes back", () => {
  const o = new Outflow();
  o.read("w", "Votre code de vérification : 381 624.", "mail.example.fr");
  for (const q of ["code ٣٨١٦٢٤", "code ۳۸۱۶۲۴", "code ३८१६२४"]) expect(o.check("w", q), q).toMatchObject({ kind: "digits" });
});
test("references with a letter prefix and a hyphen read in a private mail come back", () => {
  const refs = ["AB12-3456CD", "RX45-778812KZ", "FR12-345678AB", "Ticket-4827B", "ref-69005A"];
  for (const x of refs) {
    const o = new Outflow();
    o.read("w", `Bonjour, votre référence : ${x}. Cordialement.`, "mail.example.fr");
    expect(o.check("w", `suivi ${x}`), x).toBeDefined();
  }
});
test("a series part is exempt only as whole typed words", () => {
  const o = new Outflow();
  o.read("w", "Votre code de vérification : 381 624.", "mail.example.fr");
  o.typed("w", "j'ai 38 ans, trouve un hotel a annecy\r");
  o.sent("w", "annecy-tarif-verif 3 8"); o.sent("w", "annecy-tarif-verif 1 6");
  expect(o.check("w", "annecy-tarif-verif 2 4")).toMatchObject({ kind: "digits" });
  const p = new Outflow();
  p.read("w", "Bonjour", "mail.example.fr");
  p.typed("w", "trouve-moi un abri\r");
  p.sent("w", "annecy-tarif-verif a b"); p.sent("w", "annecy-tarif-verif r e");
  expect(p.check("w", "annecy-tarif-verif x z")).toMatchObject({ kind: "series" });
});
test("two-word spelled parts are code-like", () => {
  for (const qs of [
    ["frais-compte verif sept zéro", "frais-compte verif un huit", "frais-compte verif deux cinq"],
    ["annecy-tarif-verif alpha bravo", "annecy-tarif-verif kilo xray", "annecy-tarif-verif papa zulu"],
  ]) {
    const o = new Outflow();
    o.read("w", "Bonjour", "mail.example.fr");
    o.sent("w", qs[0]!); o.sent("w", qs[1]!);
    expect(o.check("w", qs[2]!), qs[0]).toMatchObject({ kind: "series" });
  }
});
test("letters-then-many-digits and mixed short codes are items", () => {
  const refs = ["AB48213", "INV20391", "7K2M9PQR", "X92F2KQZ"];
  const o = new Outflow();
  o.read("w", `Références : ${refs.join(", ")}.`, "mail.example.fr");
  for (const x of refs) expect(o.check("w", `suivi ${x}`), x).toMatchObject({ kind: "token" });
});
test("a short ID's glued word-and-number pieces are not indexed, only the whole ID", () => {
  const quiet = (read: string, qs: string[]) => {
    const o = new Outflow();
    o.read("w", read, "mail.example.fr");
    for (const q of qs) expect(o.check("w", q), q).toBeUndefined();
  };
  quiet("Commande CMD20240315", ["evenements annecy 2024-03-15", "annecy 20240315"]);
  quiet("Référence LYON690012", ["hotel lyon 69001"]);
  quiet("dossier ANNECY20245", ["meteo annecy 2025"]);
  const o = new Outflow();
  o.read("w", "Facture INV20391.", "mail.example.fr");
  expect(o.check("w", "suivi INV20391")).toMatchObject({ kind: "token" });
});
test("a typed exemption does not span two messages", () => {
  const o = new Outflow();
  o.read("w", "Votre code de vérification : 381 624.", "mail.example.fr");
  o.typed("w", "chambre 3\r");
  o.typed("w", "8 personnes\r");
  o.sent("w", "annecy-tarif-verif 3 8"); o.sent("w", "annecy-tarif-verif 1 6");
  expect(o.check("w", "annecy-tarif-verif 2 4")).toMatchObject({ kind: "digits" });
});
test("romanised digits alone do not make ordinary words code-like", () => {
  for (const qs of [
    ["paroles chanson il sa", "paroles chanson si il", "paroles chanson et il rentre", "paroles chanson sa il"],
    ["starbucks annecy to go", "starbucks annecy ok go", "starbucks annecy go to menu", "starbucks annecy go ok"],
  ]) {
    const o = new Outflow();
    o.read("w", "Bonjour", "mail.example.fr");
    for (const q of qs) {
      expect(o.check("w", q), q).toBeUndefined();
      o.sent("w", q);
    }
  }
});
test("a read code in CJK or hangul numerals mixed with ASCII digits comes back", () => {
  const o = new Outflow();
  o.read("w", "Votre code de vérification : 381 624.", "mail.example.fr");
  for (const q of ["code 3 八 1 六 2 四", "code 3八1六2四", "code 3 팔 1 육 2 사", "code 三8一6二4"]) expect(o.check("w", q), q).toMatchObject({ kind: "digits" });
  for (const q of ["第1章", "2024年3月15日", "一緒に3人で", "이 책 3권"]) expect(o.check("w", q), q).toBeUndefined();
});
test("romanised « i » next to spaced letters comes back, alone or split over searches", () => {
  const o = new Outflow();
  o.read("w", "Dossier BX2291KQ7.", "mail.example.fr");
  expect(o.check("w", "B X i i gu il K Q chil")).toMatchObject({ kind: "token" });
  o.sent("w", "annecy-tarif-verif B X i"); o.sent("w", "annecy-tarif-verif i gu il");
  expect(o.check("w", "annecy-tarif-verif K Q chil")).toMatchObject({ kind: "token" });
});
test("digit words in a percent-encoded address come back", () => {
  const o = new Outflow();
  o.read("w", "Votre code de vérification : 381 624.", "mail.example.fr");
  const kanji = `https://reseau-nocturne.fr/verify/lookup?code=${encodeURIComponent("三八一六二四")}&client=${encodeURIComponent("七〇四一八八二五")}`;
  const greek = `https://x.example/controle-dossier?ref=${encodeURIComponent("τρία οκτώ ένα έξι δύο τέσσερα")}`;
  const plus = `https://x.example/controle-dossier?ref=${["τρία", "οκτώ", "ένα", "έξι", "δύο", "τέσσερα"].map(encodeURIComponent).join("+")}`;
  const twice = `https://x.example/controle-dossier?ref=${encodeURIComponent(encodeURIComponent("τρία οκτώ ένα έξι δύο τέσσερα"))}`;
  for (const url of [kanji, greek, plus, twice]) expect(o.check("w", url, true), url).toMatchObject({ kind: "digits" });
  const french = `https://www.service-public.fr/recherche?q=${encodeURIComponent("démarches carte d'identité à Annecy")}&page=2`;
  expect(o.check("w", french, true)).toBeUndefined();
});
test("an invalid byte inside a percent-encoded run does not hide the rest", () => {
  const o = new Outflow();
  o.read("w", "Votre code de vérification : 381 624.", "mail.example.fr");
  for (const url of [
    "https://x.example/v?r=trois%20huit%20un%20%E4%B8%20six%20deux%20quatre",
    "https://x.example/v?r=381%E4%B8624",
    "https://x.example/v?r=%33%38%31%E4%B8%36%32%34",
  ])
    expect(o.check("w", url, true), url).toMatchObject({ kind: "digits" });
  expect(() => o.check("w", "https://www.example.fr/page?q=caf%C3%A9%E9%20noir", true)).not.toThrow();
  expect(o.check("w", "https://www.example.fr/page?q=caf%C3%A9%E9%20noir", true)).toBeUndefined();
});
