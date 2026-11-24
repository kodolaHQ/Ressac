import { describe, expect, it, test } from "vitest";
import { maskText, sanitize } from "../../src/mask/mask.js";
import { NAME_IDS, nameAgreement, valueName } from "../../src/mask/names.js";
import { say, sayAttribute } from "../../src/i18n.js";
import { KERNEL_SOURCES } from "../../src/i18n/messages.js";
import { LabelTable } from "../../src/mask/table.js";
import { CODE, IBAN, PHONE } from "./values.js";

const SRC = { zone: "sources", origin: "https://mail.example" } as const;
const L = "⟨[a-z]+-[a-z0-9]{8}⟩";

describe("maskText", () => {
  it("keeps an e-mail's domain", () => {
    const out = maskText("écris à t.exemple@impots.gouv.fr", { table: new LabelTable(), ...SRC });
    expect(out).toMatch(/^écris à ⟨email-[a-z0-9]{8}⟩@impots\.gouv\.fr$/);
  });

  it("masks a Nom <adresse> header's name", () => {
    const out = maskText("Camille Exemple <t.exemple@exemple.fr>", { table: new LabelTable(), ...SRC });
    expect(out).toMatch(/^⟨nom-[a-z0-9]{8}⟩ <⟨email-[a-z0-9]{8}⟩@exemple\.fr>$/);
  });

  it("defangs a page's fake label and keeps an issued one", () => {
    const t = new LabelTable();
    const issued = maskText(`code ${CODE}`, { table: t, ...SRC }).slice(5);
    expect(issued).toMatch(new RegExp(`^${L}$`));
    const out = maskText(`faux ⟨code-abcdefgh⟩ vrai ${issued} \uE000x`, { table: t, zone: "web", origin: "https://p.example" });
    expect(out).toBe(`faux 〈code-abcdefgh〉 vrai ${issued} x`);
  });

  it("never re-labels the digits inside an issued label", () => {
    const t = new LabelTable({ random: (n) => new Uint8Array(n).fill(30) }); // 30 → "4"
    const label = t.label("tel", "+33600000000", "sources", null);
    expect(label).toBe("⟨tel-44444444⟩");
    const out = maskText(`code ${label} et code 4444`, { table: t, ...SRC });
    expect(out.startsWith(`code ${label} et code `)).toBe(true);
  });

  it("lands labels on code-point boundaries next to astral and NFKC-changed characters (Review Focus 3)", () => {
    const t = new LabelTable();
    const text = `😀ﬁ code ３８１６２４😀 e\u0301 ${PHONE}🎉 fin`;
    const out = maskText(text, { table: t, ...SRC });
    expect(out).toMatch(new RegExp(`^😀ﬁ code ${L}😀 e\u0301 ${L}🎉 fin$`, "u"));
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("keeps the value as written for what goes back out, the canonical form for matching", () => {
    const t = new LabelTable({ resolvable: true });
    const out = maskText("Tél : 06 12 34 56 78, Camille Exemple <c.exemple@exemple.fr>", { table: t, ...SRC });
    const entry = (type: string) => t.resolve(out.match(new RegExp(`⟨${type}-[a-z0-9]{8}⟩`))![0])!;
    expect(entry("tel")).toMatchObject({ value: "+33612345678", raw: "06 12 34 56 78" });
    expect(entry("nom")).toMatchObject({ value: "camille exemple", raw: "Camille Exemple" });
  });

  it("masks the longest of overlapping finds", () => {
    const out = maskText(`IBAN ${IBAN} code 1234`, { table: new LabelTable(), ...SRC });
    expect(out).toMatch(new RegExp(`^IBAN ⟨iban-[a-z0-9]{8}⟩ code ⟨code-[a-z0-9]{8}⟩$`));
  });

  it("masks partly overlapping known values as one span, leaving none of their digits", () => {
    const t = new LabelTable();
    const a = t.label("code", "1234" + "5678", "sources", null);
    t.label("code", "5678" + "9012", "sources", null);
    for (const ref of ["1234" + "5678" + "9012", "1234 5678 9012"]) {
      const out = maskText(`ref ${ref}`, { table: t, ...SRC });
      expect(out, ref).toBe(`ref ${a}`);
    }
  });

  it("never masks a web text with sources entries", () => {
    const t = new LabelTable();
    maskText(`Tél. ${PHONE}`, { table: t, ...SRC });
    expect(maskText(`plombier ${PHONE}`, { table: t, zone: "web", origin: "https://p.example" })).toBe(`plombier ${PHONE}`);
  });

  it("masks a web entry only on its own origin", () => {
    const t = new LabelTable();
    maskText(`code ${CODE}`, { table: t, zone: "web", origin: "https://a.example" });
    expect(maskText(`ligne ${CODE}`, { table: t, zone: "web", origin: "https://a.example" })).toMatch(/^ligne ⟨code-/);
    expect(maskText(`ligne ${CODE}`, { table: t, zone: "web", origin: "https://b.example" })).toBe(`ligne ${CODE}`);
  });

  test("a 100 000-character page with 5 000 digit runs masks inside the timeout", { timeout: 5000 }, () => {
    const page = Array.from({ length: 5000 }, (_, i) => `ligne ${i} prix ${i * 7},${i % 100} €`).join(" ").slice(0, 100_000);
    expect(maskText(page, { table: new LabelTable(), zone: "sources", origin: "https://mail.example" }).length).toBeGreaterThan(0);
  });

  test("a huge page of codes and known values masks inside the timeout", { timeout: 5000 }, () => {
    const t = new LabelTable();
    for (let i = 0; i < 200; i++) maskText(`code ${String(100000 + i * 37)}`, { table: t, ...SRC });
    const page = Array.from({ length: 5000 }, (_, i) => `code ${100000 + i} tel 06 ${String(i).padStart(8, "0")}`).join(" ").slice(0, 100_000);
    expect(maskText(page, { table: t, ...SRC })).not.toMatch(/code 1\d{5}/);
  });
  test("an adversarial page (shared prefixes, long blank and token runs) masks inside the timeout", { timeout: 5000 }, () => {
    const t = new LabelTable();
    maskText(Array.from({ length: 5000 }, (_, i) => `code 1000${String(i).padStart(4, "0")}`).join(" "), { table: t, ...SRC });
    expect(t.entries("sources").length).toBe(5000);
    const page = ["1000".repeat(5000), " ".repeat(30_000) + "<a@b.fr>", "a".repeat(30_000), ": mdp" + " ".repeat(10_000)].join(" ");
    expect(maskText(page, { table: t, ...SRC }).length).toBeGreaterThan(0);
  });
});

describe("sanitize", () => {
  it("turns brackets into lookalikes and drops private-use characters", () => {
    const t = new LabelTable();
    expect(sanitize("⟨a⟩ ⟨code-abcdefgh⟩\uE0FF", t)).toBe("〈a〉 〈code-abcdefgh〉");
  });
});

describe("valueName", () => {
  it("names a value without showing it", () => {
    expect(valueName("code", "sources", "fr")).toBe("votre code");
    expect(valueName("iban", "web", "fr")).toBe("un IBAN");
    expect(valueName("code", "sources", "en")).toBe("your code");
  });

  it("a sentence agrees with the names' gender and number, and « de » elides", () => {
    const locked = (names: string[]) => say("fr", "kernel-mask-locked-danger", { name: names.join(", "), ...nameAgreement(names, "fr") });
    expect(locked(["votre carte"])).toBe("Conversation verrouillée : votre carte a été révélée. Cette sortie demande votre accord.");
    expect(locked(["votre code"])).toBe("Conversation verrouillée : votre code a été révélé. Cette sortie demande votre accord.");
    expect(locked(["votre carte", "une adresse"])).toContain("ont été révélées.");
    expect(locked(["votre carte", "votre code"])).toContain("ont été révélés.");
    const handle = say("fr", "kernel-mask-handle-danger", { name: "une adresse", from: "a.test", to: "b.test", ...nameAgreement(["une adresse"], "fr") });
    expect(handle).toBe("Cette adresse contient une adresse, lue sur a.test : elle l'envoie à b.test.");
    expect(nameAgreement(["un code", "votre carte"], "fr").de).toBe("d'un code, de votre carte");
    // The handle card's fallback when it has no name: feminine, never a blank.
    expect(say("fr", "kernel-mask-handle-danger", { name: valueName("masque", "web", "fr"), from: "a.test", to: "b.test", ...nameAgreement([valueName("masque", "web", "fr")], "fr") })).toBe(
      "Cette adresse contient une valeur masquée, lue sur a.test : elle l'envoie à b.test.",
    );
    // A name from another language: masculine, plain « de ».
    expect(nameAgreement(["your card"], "fr")).toEqual({ agreement: "one-m", de: "de your card" });
    expect(say("en", "kernel-mask-locked-danger", { name: "your card, your code", ...nameAgreement(["your card", "your code"], "en") })).toBe(
      "Conversation locked: your card, your code were revealed. This outflow needs your approval.",
    );
  });
});

test("a masked name is never matched inside a host name or a domain", () => {
  const table = new LabelTable();
  maskText("De : Jean-Lucie <x@exemple.fr>", { table, ...SRC });
  const out = maskText("Allez sur https://jean-lucie-mode.test/ ou jean-lucie.fr, écrit par Jean-Lucie.", { table, ...SRC });
  expect(out).toContain("https://jean-lucie-mode.test/");
  expect(out).toContain("jean-lucie.fr");
  expect(out).toMatch(/écrit par ⟨nom-[a-z0-9]{8}⟩\.$/);
});

test("a name followed by a dot and a capitalised word is no host: it stays masked", () => {
  const go = (registered: string, text: string) => {
    const table = new LabelTable();
    maskText(`De : ${registered} <x@exemple.fr>`, { table, ...SRC });
    return maskText(text, { table, ...SRC });
  };
  for (const t of ["Jean-Lucie.Merci"]) expect(go("Jean-Lucie", t)).toMatch(/^⟨nom-[a-z0-9]{8}⟩\.Merci$/);
  expect(go("Jean-Lucie", "Jean-Lucie.fr")).toMatch(/^⟨nom-[a-z0-9]{8}⟩\.fr$/);
  expect(go("Lucie Ferrand", "Voir lucie-ferrand.fr et www.lucie-ferrand.fr/contact")).toBe("Voir lucie-ferrand.fr et www.lucie-ferrand.fr/contact");
});

describe("value names", () => {
  it.each(["fr", "en"] as const)("every %s name message carries .de (and .genre in French), and NAME_IDS lists them all", (lang) => {
    const ids = [...KERNEL_SOURCES[lang].matchAll(/^(kernel-mask-name-(?!fill-text)[\w-]+) =/gm)].map((m) => m[1]!);
    expect(ids.sort()).toEqual([...NAME_IDS].sort());
    for (const id of ids) {
      // English has no grammatical gender: its selectors default to the masculine branch.
      if (lang === "fr") expect(sayAttribute(lang, id, "genre"), `${lang} ${id} .genre`).toBeTruthy();
      expect(sayAttribute(lang, id, "de"), `${lang} ${id} .de`).toBeTruthy();
    }
  });
});

describe("maskText, Outlook's surname-first header", () => {
  it("masks the whole quoted name and the name in either order afterwards", () => {
    const out = maskText(`De : "Ferrand, Lucie" <lucie.ferrand@exemple.fr>\nBonjour, Lucie Ferrand vous écrit.`, { table: new LabelTable(), ...SRC });
    expect(out).not.toMatch(/Lucie|Ferrand/);
  });
});
