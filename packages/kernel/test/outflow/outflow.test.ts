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
  const o = new Outflow();
  o.typed("w", "\x1bP1$r0;1m\x1b\\h\x1b_apc\x07i\x1b^pm\x1b\\\x1bXsos\x1b\\!");
  expect(o.lastMessage("w")).toBe("hi!");
});

test("the message being typed is capped to its latest 64 KB", () => {
  const o = new Outflow();
  o.typed("w", "x".repeat(200_000) + "fin");
  const last = o.lastMessage("w")!;
  expect(last.length).toBe(64 * 1024);
  expect(last.endsWith("fin")).toBe(true);
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
  o.read("w", `Pompes à chaleur · ${article} · 2026-11-12 · 2 visites\nVoir (https://Shop.Example/Commande/48213977/).`, "ton historique", true);
  expect(o.check("w", article, true)).toBeUndefined();
  // Same address up to host case, a trailing slash, percent-encoding and the text's punctuation.
  expect(o.check("w", "https://shop.example/Commande/48213977", true)).toBeUndefined();
  expect(o.check("w", "https://www.lemonde.fr/economie/article/2026/11/09/pompes-%61-chaleur_6398712_3234.html", true)).toBeUndefined();
  // Anything else carrying the number is still a hit: another address, an added parameter, a search query.
  expect(o.check("w", "https://x.example/?id=6398712", true)).toMatchObject({ kind: "digits", source: "ton historique" });
  expect(o.check("w", `${article}?ref=48213977`, true)).toMatchObject({ kind: "digits" });
  expect(o.check("w", article)).toMatchObject({ kind: "digits" });
  // A secret in a read address still shows on the card.
  o.read("w", "https://x.example/cb?key=sk_live_51NxQk2LmN8pRs4TuVw6YzA8b", "mail.google.com", true);
  expect(o.check("w", "https://x.example/cb?key=sk_live_51NxQk2LmN8pRs4TuVw6YzA8b", true)).toMatchObject({ kind: "api-key" });
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
  o.read("w", "Suivi · https://shop.example/suivi?commande=48213977&lang=fr · 2 visites", "ton historique", true);
  expect(o.check("w", "https://shop.example/suivi?commande=48213977&lang=fr", true)).toBeUndefined();
  expect(o.check("w", "https://shop.example/suivi?commande=48213977&lang=en", true)).toMatchObject({ kind: "digits" });
});

test("an address evicted from the kept addresses is a hit again", () => {
  const o = new Outflow();
  const first = "https://shop.example/commande/48213977";
  o.read("w", first, "ton historique", true);
  o.read("w", Array.from({ length: 5000 }, (_, i) => `https://pad.example/p${i}`).join("\n"), "ton historique", true);
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
  expect(o.lastMessage("w")).toBeUndefined();
});
