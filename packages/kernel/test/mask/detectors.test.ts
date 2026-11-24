import { describe, expect, it } from "vitest";
import { canonical, detect, type LabelType } from "../../src/mask/detectors.js";
import { API_KEY, CARD, CODE, IBAN, NIR, PASSPORT, PHONE, TOKEN } from "./values.js";

const spaced4 = (s: string) => s.replace(/(.{4})(?=.)/g, "$1 ");
const types = (text: string, zone: "sources" | "web" = "sources") => detect(text, zone).map((f) => f.type);
const found = (text: string, zone: "sources" | "web" = "sources") => detect(text, zone).map((f) => [f.type, text.slice(f.start, f.end), f.canonical]);

describe("detect", () => {
  const samples: [LabelType, string, string, string][] = [
    ["iban", `RIB : ${spaced4(IBAN)} BIC`, spaced4(IBAN), IBAN],
    ["carte", `carte ${spaced4(CARD)} exp`, spaced4(CARD), CARD],
    ["secu", `sécu ${NIR.slice(0, 1)} ${NIR.slice(1, 3)} ${NIR.slice(3, 5)} ${NIR.slice(5, 7)} ${NIR.slice(7, 10)} ${NIR.slice(10, 13)} ${NIR.slice(13)}`, "", NIR],
    ["id", `ma clé ${API_KEY} merci`, API_KEY, API_KEY],
    ["id", `jeton ${TOKEN} fin`, TOKEN, TOKEN],
    ["id", `passeport n° ${PASSPORT} délivré`, PASSPORT, PASSPORT],
    ["code", `Votre code de vérification : ${CODE}.`, CODE, CODE],
    ["code", `code à usage unique 381 624`, "381 624", "381624"],
    ["code", `code : trois cent quatre-vingt-un six cent vingt-quatre`, "trois cent quatre-vingt-un six cent vingt-quatre", CODE],
    ["tel", `Tél. 06 12 34 56 78`, "06 12 34 56 78", "+33612345678"],
    ["tel", `call +33 (0)6 12 34 56 78 now`, "+33 (0)6 12 34 56 78", "+33612345678"],
    ["tel", `0033 6 12 34 56 78`, "0033 6 12 34 56 78", "+33612345678"],
    ["tel", `appelle le 00 33 6 12 34 56 78`, "00 33 6 12 34 56 78", "+33612345678"],
    ["tel", `bureau 00 44 20 7946 0958`, "00 44 20 7946 0958", "+442079460958"],
    ["email", `écris à T.Exemple@Exemple.fr demain`, "T.Exemple", "t.exemple@exemple.fr"],
    ["motdepasse", `mot de passe : hunter2! puis`, "hunter2!", "hunter2!"],
  ];
  for (const [type, text, span, canon] of samples)
    it(`finds ${type} once in « ${text.slice(0, 24)} »`, () => {
      const f = detect(text, "sources");
      expect(f.map((x) => x.type)).toEqual([type]);
      if (span) expect(text.slice(f[0]!.start, f[0]!.end)).toBe(span);
      expect(f[0]!.canonical).toBe(canon);
    });

  it("finds a Nom <adresse> header name in the sources", () => {
    expect(found("De : Camille Exemple <t.exemple@exemple.fr>")).toEqual([
      ["nom", "Camille Exemple", "camille exemple"],
      ["email", "t.exemple", "t.exemple@exemple.fr"],
    ]);
  });

  it("a header's display name that looks like an organisation is no person's name", () => {
    const names = (text: string) => found(text).filter(([t]) => t === "nom").map(([, v]) => v);
    // The sender's own domain label, case, accents and separators aside.
    expect(names("De : Banque Ardoise <alertes@banque-ardoise.fr>")).toEqual([]);
    expect(names("De : Lumen Maison <commandes@mail.lumenmaison.fr>")).toEqual([]);
    expect(names("De : Éléa Café <bonjour@elea-cafe.fr>")).toEqual([]);
    // An all-caps acronym.
    expect(names("De : DGFiP <ne-pas-repondre@dgfip.finances.gouv.fr>")).toEqual([]);
    expect(names("De : DGFIP <contact@exemple.fr>")).toEqual([]);
    // A common organisation word.
    expect(names("De : Colis Rapide <suivi@cr-livraison.fr>")).toEqual([]);
    expect(names("De : Service Clients Vertel <x@vertel.fr>")).toEqual([]);
    expect(names("De : Impôts <x@exemple.fr>")).toEqual([]);
    expect(names("De : Mutuelle du Lac <x@exemple.fr>")).toEqual([]);
    expect(names("De : La Poste <x@exemple.fr>")).toEqual([]);
    expect(names("De : Crédit Agricole <x@exemple.fr>")).toEqual([]);
    expect(names("De : EDF <x@exemple.fr>")).toEqual([]);
    // A domain label that is a whole word of the name.
    expect(names("De : Amazon.fr <a@amazon.fr>")).toEqual([]);
    expect(names("De : Free Mobile <x@free.fr>")).toEqual([]);
    expect(names("De : Free Mobile <x@mobile.free.fr>")).toEqual([]);
    expect(names("De : Amazon Prime <x@amazon.fr>")).toEqual([]);
  });

  it("a person's name in a header stays a name, from a company domain too", () => {
    const names = (text: string) => found(text).filter(([t]) => t === "nom").map(([, v]) => v);
    // An organisation word clears a name only at its head, or alone: never a person's surname.
    for (const n of ["Marie Banque", "Lucie Poste", "Julien Client", "Camille Colis", "Jean Team", "Paul Credit", "Service Lucie Ferrand"])
      expect(names(`De : ${n} <x@exemple.fr>`)).toEqual([n]);
    // One word in capitals longer than an acronym is a surname.
    expect(names("De : DUPONT <x@exemple.fr>")).toEqual(["DUPONT"]);
    expect(names("De : MARTIN <x@exemple.fr>")).toEqual(["MARTIN"]);
    // A surname written first, at the person's own domain.
    expect(names("De : Martin Lucie <l@martin.fr>")).toEqual(["Martin Lucie"]);
    expect(names("De : Dupont Marie <m@dupont.fr>")).toEqual(["Dupont Marie"]);
    expect(names("De : Lucie Ferrand <lucie.ferrand@exemple.fr>")).toEqual(["Lucie Ferrand"]);
    expect(names("De : Julien Marceau <jmarceau@banque-ardoise.fr>")).toEqual(["Julien Marceau"]);
    expect(names("À : JULIEN MARCEAU <jm@exemple.fr>")).toEqual(["JULIEN MARCEAU"]);
  });

  it("leaves the traps alone", () => {
    for (const text of [
      "69005 Lyon",
      "code postal 69005 Lyon",
      "code promo : deux mois offerts",
      "commande " + "7340" + "123456" + " expédiée",
      "total 2 340,12 €",
      "un deux trois quatre",
    ])
      expect(types(text), text).toEqual([]);
  });

  it("finds a 5-digit code before a sentence start, a capital or a line break, and keeps a postcode clear", () => {
    const code = "482" + "13";
    const mail = `Votre code de vérification :\n${code}\nCe code expire dans 10 minutes.`;
    expect(found(mail)).toEqual([["code", code, code]]);
    expect(found(`Your verification code is ${code} Do not share it`, "web")).toEqual([["code", code, code]]);
    expect(types("code : 12345 Lyon")).toEqual(["code"]);
    expect(types("12345 Lyon")).toEqual([]);
  });

  it("types a bank account number as an id, never as a phone (the B3 bank page's shape)", () => {
    // bench/security/B3/profiles.mjs: 11 digits with leading zeros, after « Compte courant n° » or « Livret A n° ».
    const account = "000421" + "78306";
    expect(found(`Compte courant n° ${account} — solde : 3 214,57 €`)).toEqual([["id", account, account]]);
    expect(found(`Livret A n° ${"000583" + "16590"} — solde : 8 305,00 €`)).toEqual([["id", "00058316590", "00058316590"]]);
    // No context word: no shape (an order or parcel number of 11 digits stays clear), and never a phone.
    expect(types(`réf. ${account}`)).toEqual([]);
    // Shown in the web zone only to the sources.
    expect(types(`Compte courant n° ${account}`, "web")).toEqual([]);
    // A phone beside the word « compte » stays a phone.
    expect(found("Compte : 06 12 34 56 78")).toEqual([["tel", "06 12 34 56 78", "+33612345678"]]);
    expect(found("compte +44 20 7946 0958")).toEqual([["tel", "+44 20 7946 0958", "+442079460958"]]);
  });

  it("returns only high-risk types in the web zone", () => {
    const text = `Tél. ${PHONE}, mail a.b@c.fr, mot de passe : x1, code ${CODE}, IBAN ${IBAN}`;
    expect(types(text, "sources").sort()).toEqual(["code", "email", "iban", "motdepasse", "tel"]);
    expect(types(text, "web").sort()).toEqual(["code", "iban"]);
  });

  it("never takes a URL's host or port for a code; a code in its path or query beside a code word stays one", () => {
    // A « Code » link beside its address (a search result): the host and port are no secret.
    for (const url of ["http://127.0.0.1:55349/code.html", "https://example.com:8443/x"]) expect(found(`Code — ${url}`, "web")).toEqual([]);
    const code = "482" + "913";
    expect(found(`Votre code : https://exemple.fr/verifier?code=${code}`, "web")).toEqual([["code", code, code]]);
    expect(found(`Votre code : https://exemple.fr/verify/${code}`, "web")).toEqual([["code", code, code]]);
    // Over-masking an ordinary number in a path beside a code word is accepted (SECURITY.md): it fails safe.
    expect(found("Code — https://git.example.com/pull/123456", "web")).toEqual([["code", "123456", "123456"]]);
  });

  it("finds a code written in fullwidth digits and maps its span", () => {
    const text = "😀 ﬁ code ３８１６２４ fin";
    const [f] = detect(text, "web");
    expect(text.slice(f!.start, f!.end)).toBe("３８１６２４");
    expect(f!.canonical).toBe(CODE);
  });
});

describe("canonical", () => {
  it("normalizes each type", () => {
    expect(canonical("iban", spaced4(IBAN).toLowerCase())).toBe(IBAN);
    expect(canonical("carte", CARD.replace(/(\d{4})(?=\d)/g, "$1-"))).toBe(CARD);
    for (const t of ["06 12 34 56 78", "+33 6 12 34 56 78", "0033 6 12 34 56 78", "+33 (0)6 12 34 56 78", "06.12.34.56.78"])
      expect(canonical("tel", t), t).toBe("+33612345678");
    expect(canonical("email", "T.Exemple@exemple.fr")).toBe("t.exemple@exemple.fr");
    expect(canonical("nom", "  Hélène   Dupré ")).toBe("helene dupre");
    expect(canonical("code", "381624")).toBe("381624");
  });
});

describe("detect, obfuscated separators", () => {
  const spanned = (text: string, zone: "sources" | "web") => detect(text, zone).map((f) => [f.type, text.slice(f.start, f.end)]);
  // Mailers put these between digits so phones do not auto-link numbers.
  for (const [name, inv] of [["U+200B", "​"], ["U+200C", "‌"], ["U+200D", "‍"], ["U+2060", "⁠"], ["soft hyphen", "­"]])
    it(`an ${name} between digits hides no card, code or IBAN, in both zones`, () => {
      const card = CARD.match(/.{4}/g)!.join(inv);
      const code = [...CODE].join(inv);
      const ib = IBAN.match(/.{1,4}/g)!.join(inv);
      for (const zone of ["web", "sources"] as const) {
        expect(spanned(`carte ${card} exp`, zone)).toEqual([["carte", card]]);
        expect(spanned(`Votre code de vérification : ${code}`, zone)).toEqual([["code", code]]);
        expect(spanned(`IBAN ${ib} BIC`, zone)).toEqual([["iban", ib]]);
      }
    });

  it("spaced dashes in an IBAN or card are one value", () => {
    const ib = IBAN.match(/.{1,4}/g)!.join(" - ");
    const card = CARD.match(/.{4}/g)!.join(" - ");
    expect(spanned(`IBAN ${ib} BIC`, "web")).toEqual([["iban", ib]]);
    expect(spanned(`carte ${card} exp`, "web")).toEqual([["carte", card]]);
  });

  it("finds a phone written with +, /, _, spaced dashes, tabs or (06)", () => {
    for (const tel of ["06+12+34+56+78", "06/12/34/56/78", "06_12_34_56_78", "06 - 12 - 34 - 56 - 78", "06\t12\t34\t56\t78", "(06) 12 34 56 78"])
      expect(found(`Tél : ${tel}`), tel).toEqual([["tel", tel, "+33612345678"]]);
    expect(found("https://x.fr/recherche?tel=06+12+34+56+78&nom=x")).toEqual([["tel", "06+12+34+56+78", "+33612345678"]]);
    expect(found("https://x.fr/?tel=%2B33+6+12+34+56+78")).toEqual([["tel", "%2B33+6+12+34+56+78", "+33612345678"]]);
  });

  it("dates, versions, prices and order numbers stay no phone", () => {
    for (const t of ["né le 14/03/1990 à Lyon", "version 10.2.3.4 du 01/02/2024", "total 1 234,56 €", "commande n° 2024/11/24-0042", "le 01/02/2024 à 12:30"])
      expect(types(t), t).toEqual([]);
  });
});

describe("detect, common wordings (swarm findings 2-5)", () => {
  const spanned = (text: string, zone: "sources" | "web" = "sources") => detect(text, zone).map((f) => [f.type, text.slice(f.start, f.end)]);
  const code = "482" + "913";

  it("finds a one-time code after the common code wordings, in both zones", () => {
    for (const text of [
      `Your one-time passcode is ${code}.`,
      `Use ${code} to verify your email address.`,
      `Votre mot de passe temporaire est ${code}`,
      `Authentification forte : ${code}`,
      `Your 2FA code: ${code}`,
      `Your login token is ${code}`,
    ])
      for (const zone of ["sources", "web"] as const) expect(spanned(text, zone), `${zone}: ${text}`).toEqual([["code", code]]);
  });

  it("finds a code of capitals and digits near a code word, in both zones", () => {
    for (const [text, value] of [
      ["Votre code de vérification : X7K9P2", "X7K9P2"],
      ["Your Slack confirmation code is QX4-7BR", "QX4-7BR"],
      ["Steam Guard code: F7K2Q", "F7K2Q"],
    ] as const)
      for (const zone of ["sources", "web"] as const) expect(spanned(text, zone), `${zone}: ${text}`).toEqual([["code", value]]);
  });

  it("leaves code words without a code-like value next to them alone", () => {
    for (const text of [
      "Each token is a word piece; a 2FA app makes login safer.",
      "GET /user?access_token=x&page=2 401",
      "Verify your address before you publish.",
      "Le mot de passe temporaire expire le 14/03/2027.",
      "Authentification forte : activez-la dans vos réglages.",
      "code postal 69005 Lyon",
      "Your verification code expires in 10 minutes.",
      "Use the code ABCDEF to get started",
      "commande AB12345 expédiée le 3 mars",
      "total 2 340,12 € TTC",
    ])
      expect(types(text, "web"), text).toEqual([]);
  });

  it("finds an identity number after the official and English wordings, spaced too, in both zones", () => {
    for (const [text, value] of [
      ["Carte nationale d'identité n° 190312345678", "190312345678"],
      ["Passport number: 19AB12345", "19AB12345"],
      ["Pièce d'identité : 19AB12345", "19AB12345"],
      ["ID card number 19AB12345", "19AB12345"],
      ["Document number: 19AB12345", "19AB12345"],
      ["CNI : 1903 1234 5678", "1903 1234 5678"],
    ] as const)
      for (const zone of ["sources", "web"] as const) expect(spanned(text, zone), `${zone}: ${text}`).toEqual([["id", value]]);
  });

  it("an identity word before a date or a short number finds no identity number", () => {
    for (const text of ["Passeport valable jusqu'au 12 03 2027", "Passport renewal takes 15 days", "carte d'identité perdue le 14/03/2020"])
      expect(types(text, "web"), text).toEqual([]);
  });

  it("finds the whole display name of the common sender headers", () => {
    const names = (text: string) => found(text).filter(([t]) => t === "nom").map(([, v, c]) => [v, c]);
    const mail = "<lucie.ferrand@exemple.fr>";
    expect(names(`De : "Ferrand, Lucie" ${mail}`)).toEqual([["Ferrand, Lucie", "lucie ferrand"]]);
    expect(names(`On Mon, Nov 24, 2026 at 10:12 AM Lucie Ferrand ${mail} wrote:`)).toEqual([["Lucie Ferrand", "lucie ferrand"]]);
    expect(names(`Le 24/11/2026 à 10:12 Lucie Ferrand ${mail} a écrit :`)).toEqual([["Lucie Ferrand", "lucie ferrand"]]);
    expect(names(`Le 24 nov. 2026 à 10h12, Lucie Ferrand ${mail} a écrit :`)).toEqual([["Lucie Ferrand", "lucie ferrand"]]);
    expect(names(`De : Lucie Ferrand (perso) ${mail}`)).toEqual([["Lucie Ferrand", "lucie ferrand"]]);
    expect(names(`De : 'Lucie Ferrand' ${mail}`)).toEqual([["Lucie Ferrand", "lucie ferrand"]]);
    expect(names(`De : « Lucie Ferrand » ${mail}`)).toEqual([["Lucie Ferrand", "lucie ferrand"]]);
    expect(names(`De : "Lucie O'Brien" ${mail}`)).toEqual([["Lucie O'Brien", "lucie o'brien"]]);
    // A quoted organisation stays clear; a quoted address is no name.
    expect(names(`De : "Banque Ardoise" <alertes@banque-ardoise.fr>`)).toEqual([]);
    expect(names(`De : "lucie.ferrand@exemple.fr" ${mail}`)).toEqual([]);
  });

  it("finds a card with an invisible character in one gap only, in both zones", () => {
    const [a, b, c, d] = CARD.match(/.{4}/g)!;
    for (const inv of ["​", "­", "&#8203;"])
      for (const zone of ["sources", "web"] as const) {
        const card = `${a} ${b}${inv}${c} ${d}`;
        expect(spanned(`Carte ${card} exp`, zone), `${zone}: ${JSON.stringify(card)}`).toEqual([["carte", card]]);
      }
  });

  it("stays linear on 50 kB adversarial strings", () => {
    for (const s of [
      "code " + "A1".repeat(25_000),
      "code " + "A1-".repeat(17_000),
      "passport " + "1 ".repeat(25_000),
      "carte " + "nationale ".repeat(5_000),
      ": \"" + "Lucie, ".repeat(7_000),
      "10:12 " + "Lucie ".repeat(8_000),
      ": « " + "a ".repeat(25_000),
      "1​".repeat(25_000),
    ]) {
      const t0 = performance.now();
      detect(s, "sources");
      expect(performance.now() - t0, s.slice(0, 12)).toBeLessThan(2000);
    }
  });
});
