import { beforeEach, describe, expect, it, vi } from "vitest";
import * as projections from "../../src/mask/projections.js";
import { maskText } from "../../src/mask/mask.js";
import { canonicalOf, rawOf, type PassportEntry, type PassportField, type PassportValue } from "../../src/mask/passport-fields.js";
import { PassportStore } from "../../src/mask/passport.js";
import { LabelTable } from "../../src/mask/table.js";
import { IBAN } from "./values.js";

// A pass-through spy: pins which zones build the folded projection (ruling F19).
vi.mock("../../src/mask/projections.js", async (original) => {
  const real = await original<typeof import("../../src/mask/projections.js")>();
  return { ...real, foldedProjections: vi.fn(real.foldedProjections) };
});
const folded = vi.mocked(projections.foldedProjections);

let n = 0;
const entry = (field: PassportField, value: PassportValue, extra: Partial<PassportEntry> = {}): PassportEntry => ({
  id: (++n).toString(16).padStart(16, "0"),
  field,
  value,
  variants: [],
  origins: [],
  how: "typed",
  created: "2026-11-23T10:00:00.000Z",
  updated: "2026-11-23T10:00:00.000Z",
  ...extra,
});

const TEL = "06" + "12" + "34" + "56" + "78";
const OTHER = "07" + "98" + "76" + "54" + "32";
const L = "⟨[a-z]+-[a-z0-9]{8}⟩";
const nameEntry = () => entry("nom", { given: "Camille", family: "Aubrac" }, { origins: ["boutique-exemple.test"] });
const proche = () => entry("proche", { given: "Julien", family: "Aubrac" });
const addressEntry = () => entry("adresse", { text: "14 rue des Tanneurs\n69005 Lyon" });
const tel = () => entry("tel", { text: TEL });
const naissance = () => entry("naissance", { text: "1990-03-14" });
const marc = () => entry("nom", { given: "Marc", family: "Durand" }, { variants: ["Marc"] });

function store(...p1: PassportEntry[]): PassportStore {
  const s = new PassportStore();
  s.replace("p1", p1.length ? p1 : [nameEntry(), proche(), addressEntry(), tel(), naissance(), marc()]);
  s.replace("p2", [entry("nom", { given: "Lucie", family: "Ferrand" })]);
  return s;
}
const SRC = (table: LabelTable) => ({ table, zone: "sources" as const, origin: "https://mail.example" });
const WEB = (table: LabelTable, origin = "https://news.example") => ({ table, zone: "web" as const, origin });
const sources = (text: string, s = store()) => maskText(text, SRC(new LabelTable({ passport: s })));
const labelsIn = (s: string) => s.match(new RegExp(L, "g")) ?? [];

beforeEach(() => {
  folded.mockClear();
});

describe("the passport in the sources zone", () => {
  it("gives every writing of a name its one label, and leaves a lone first name or an organisation alone", () => {
    // Punctuation folds like a space: « Aubrac. Camille » would read as the reversed name, hence « Puis ».
    const out = sources("AUBRAC Camille, C. Aubrac, Mme Aubrac et Camille Aubrac. Puis Camille chez Aubrac Immobilier.");
    const ls = labelsIn(out);
    expect(ls).toHaveLength(4);
    expect(new Set(ls).size).toBe(1);
    expect(ls[0]).toMatch(/^⟨nom-/);
    expect(out.endsWith(". Puis Camille chez Aubrac Immobilier.")).toBe(true);
  });

  it("masks a one-word variant as a word, never inside another word (ruling F18)", () => {
    const out = sources("Marc au Marché avec Marcel.");
    expect(out).toMatch(new RegExp(`^${L} au Marché avec Marcel\\.$`));
  });

  it("masks the street line under its abbreviations, never the postcode and city", () => {
    expect(sources("Livré au 14, r. des Tanneurs, 69005 Lyon")).toMatch(new RegExp(`^Livré au ⟨adresse-[a-z0-9]{8}⟩, 69005 Lyon$`));
  });

  it("masks every profile's passport", () => {
    expect(sources("Signé : Lucie Ferrand")).toMatch(new RegExp(`^Signé : ⟨nom-[a-z0-9]{8}⟩$`));
  });

  it("gives a header's display name the passport label, and keeps the local part an e-mail", () => {
    const out = sources("De : Camille Aubrac <camille.aubrac@x.fr>\nC. Aubrac");
    const m = out.match(new RegExp(`^De : (${L}) <⟨email-[a-z0-9]{8}⟩@x\\.fr>\\n(${L})$`));
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
    // Written surname first, the header's detector would key it otherwise: the passport's span wins the tie.
    const reversed = sources("De : AUBRAC Camille <c@x.fr>\nC. Aubrac").match(new RegExp(`^De : (${L}) <⟨email-[a-z0-9]{8}⟩@x\\.fr>\\n(${L})$`));
    expect(reversed![1]).toBe(reversed![2]);
  });

  it("leaves a detector span of another type to the detector, and labels the passport parts outside it (§ 6.6)", () => {
    const st = store(nameEntry(), addressEntry(), entry("libre", { text: "dossier Tanneurs" }));
    const EM = "⟨email-[a-z0-9]{8}⟩";
    const NAME_LABEL = "⟨nom-[a-z0-9]{8}⟩";
    for (const [text, want] of <[string, string][]>[
      ["Aubrac camille.x@ex.fr", `^${NAME_LABEL} ${EM}@ex\\.fr$`],
      ["Camille aubrac.c@ex.fr", `^${NAME_LABEL} ${EM}@ex\\.fr$`],
      ["Signé Aubrac camille@gmail.com", `^Signé ${NAME_LABEL} ${EM}@gmail\\.com$`],
      ["C. Aubrac camille@ex.fr", `^${NAME_LABEL} ${EM}@ex\\.fr$`],
      ["dossier tanneurs@ex.fr", `^⟨masque-[a-z0-9]{8}⟩ ${EM}@ex\\.fr$`],
      ["14 rue des tanneurs@ex.fr", `^⟨adresse-[a-z0-9]{8}⟩ ${EM}@ex\\.fr$`],
      ["04 78 12 34 14 rue des Tanneurs", "^⟨tel-[a-z0-9]{8}⟩ ⟨adresse-[a-z0-9]{8}⟩$"],
      ["Camille Aubrac <camille.aubrac@x.fr>", `^${NAME_LABEL} <${EM}@x\\.fr>$`],
    ])
      expect(sources(text, st), text).toMatch(new RegExp(want));
  });

  it("gives a passport phone the detector's label for the same number in another spelling", () => {
    const t = new LabelTable({ passport: store() });
    const a = maskText(`Tél ${TEL.replace(/(\d\d)(?=\d)/g, "$1 ")}`, SRC(t));
    const b = maskText(`Appeler le +33 ${TEL.slice(1, 2)} ${TEL.slice(2).replace(/(\d\d)(?=\d)/g, "$1.")}`, SRC(t));
    expect(labelsIn(a)).toHaveLength(1);
    expect(labelsIn(b)).toEqual(labelsIn(a));
  });

  it("drops a lower-case initial and a name inside a host", () => {
    expect(sources("vu c Aubrac hier")).toBe("vu c Aubrac hier");
    expect(sources("voir camille-aubrac.fr")).toBe("voir camille-aubrac.fr");
  });

  it("masks a digit form only between non-digits", () => {
    expect(sources("né le 14/03/1990 à Lyon")).toMatch(new RegExp(`^né le ⟨date-[a-z0-9]{8}⟩ à Lyon$`));
    expect(sources("réf 2140319905")).toBe("réf 2140319905");
    expect(sources("né le 14 mars 1990")).toMatch(new RegExp(`^né le ⟨date-[a-z0-9]{8}⟩$`));
  });

  it("masks real page text like its plain form (Review Focus 1)", () => {
    const s = store();
    const t = new LabelTable({ passport: s });
    const plain = maskText("Camille Aubrac", SRC(t));
    const street = maskText("14 rue des Tanneurs", SRC(t));
    for (const page of ["AUBRAC Camille", "A\u0301ubrac Camille", "Aubrac\u00a0Camille", "Aubrac\u200b Camille", "Camille\u202fAubrac"])
      expect(maskText(page, SRC(t)), JSON.stringify(page)).toBe(plain);
    for (const page of ["14,\nrue des Tanneurs", "14 rue des Tanneurs", "14\u00a0rue des\u00a0Tanneurs"]) expect(maskText(page, SRC(t)), JSON.stringify(page)).toBe(street);
    // A typographic apostrophe folds like any separator.
    const ap = store(entry("nom", { given: "Jeanne", family: "d'Arc-Aubrac" }));
    const ta = new LabelTable({ passport: ap });
    expect(maskText("Jeanne d’Arc-Aubrac", SRC(ta))).toBe(maskText("Jeanne d'Arc-Aubrac", SRC(ta)));
    expect(labelsIn(maskText("Jeanne d’Arc-Aubrac", SRC(ta)))).toHaveLength(1);
  });

  it("keeps a removed entry masked in a table that issued its label, in clear in a fresh one", () => {
    const a = addressEntry();
    const s = store(nameEntry(), a);
    const t = new LabelTable({ passport: s });
    const label = maskText("au 14 rue des Tanneurs", SRC(t));
    s.replace("p1", [nameEntry()]);
    expect(maskText("au 14 rue des Tanneurs", SRC(t))).toBe(label);
    expect(maskText("au 14 rue des Tanneurs", SRC(new LabelTable({ passport: s })))).toBe("au 14 rue des Tanneurs");
  });

  it("rebuilds its search when the store changes", () => {
    const s = store(nameEntry());
    const t = new LabelTable({ passport: s });
    expect(maskText("au 14 rue des Tanneurs", SRC(t))).toBe("au 14 rue des Tanneurs");
    s.replace("p1", [nameEntry(), addressEntry()]);
    expect(maskText("au 14 rue des Tanneurs", SRC(t))).toMatch(new RegExp(`^au ⟨adresse-[a-z0-9]{8}⟩$`));
  });

  it("marks the table touched", () => {
    const t = new LabelTable({ passport: store() });
    expect(t.touched).toBe(false);
    maskText("rien", WEB(t));
    expect(t.touched).toBe(true);
  });

  // A reread on the same table finds the name as a known value too: it must keep yielding to the e-mail detector.
  it("keeps a header's e-mail label on a second read with the same table", () => {
    const t = new LabelTable({ passport: store() });
    const header = "De : Julien Aubrac <julien.aubrac@x.fr> — 8 nov.";
    const shape = new RegExp(`^De : (⟨nom-[a-z0-9]{8}⟩) <(⟨email-[a-z0-9]{8}⟩)@x\\.fr> — 8 nov\\.$`);
    const first = maskText(header, SRC(t)).match(shape);
    const second = maskText(header, SRC(t)).match(shape);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.slice(1)).toEqual(first!.slice(1));
  });

  it("keeps the e-mail label when the name was read before and the local part is another one", () => {
    const t = new LabelTable({ passport: store() });
    maskText("Salut Julien Aubrac.", SRC(t));
    expect(maskText("De : Julien Aubrac <julien.durand@x.fr>", SRC(t))).toMatch(new RegExp(`^De : ⟨nom-[a-z0-9]{8}⟩ <⟨email-[a-z0-9]{8}⟩@x\\.fr>$`));
  });

  it("never matches a writing across an address's brackets, nor joins two lines that each hold one", () => {
    expect(sources("Mme Aubrac\nCamille Aubrac")).toMatch(new RegExp(`^${L}\\n${L}$`));
    // « Aubrac <camille » is not the reversed name: the local part stays the e-mail's.
    expect(sources("Mme Aubrac <camille@x.fr>")).toMatch(new RegExp(`^⟨nom-[a-z0-9]{8}⟩ <⟨email-[a-z0-9]{8}⟩@x\\.fr>$`));
    // The same on a reread: the known name's regex never crosses a line either.
    for (const [text, shape] of <[string, string][]>[
      ["Mme Aubrac\nCamille Aubrac", `^${L}\\n${L}$`],
      ["Mme Aubrac\nJulien Aubrac", `^${L}\\n${L}$`],
      ["De : Mme Aubrac\nCamille Aubrac <camille.aubrac@x.fr>", `^De : ${L}\\n${L} <⟨email-[a-z0-9]{8}⟩@x\\.fr>$`],
    ]) {
      const t = new LabelTable({ passport: store() });
      const first = maskText(text, SRC(t));
      expect(first, JSON.stringify(text)).toMatch(new RegExp(shape));
      expect(maskText(text, SRC(t)), JSON.stringify(text)).toBe(first);
    }
    // A name the detector found on one line is found again wrapped over two, on every later read (not a passport entry).
    for (const [header, wrapped] of [
      ["De : Paul Mercier <p@x.fr>", "Paul\nMercier"],
      ["De : Jean-Pierre Morel <jp@x.fr>", "Jean-\nPierre Morel"],
    ]) {
      const t = new LabelTable({ passport: store() });
      const name = maskText(header!, SRC(t)).match(new RegExp(`^De : (⟨nom-[a-z0-9]{8}⟩) <`))?.[1];
      expect(name, header).toBeDefined();
      expect(maskText(wrapped!, SRC(t)), JSON.stringify(wrapped)).toBe(name);
      expect(maskText(wrapped!, SRC(t)), JSON.stringify(wrapped)).toBe(name);
      expect(maskText(`Bonjour Paul\n${wrapped}`, SRC(t))).toBe(`Bonjour Paul\n${name}`);
    }
    // A writing wrapped over two lines alone is still one.
    expect(sources("Camille\nAubrac")).toMatch(new RegExp(`^⟨nom-[a-z0-9]{8}⟩$`));
  });
});

describe("escaped writings (JSON and numeric HTML escapes)", () => {
  const heloise = () => store(entry("nom", { given: "Héloïse", family: "Marçais" }));
  const u = (s: string) => [...s].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const N = `⟨nom-[a-z0-9]{8}⟩`;

  it.each([
    ['{"name":"H\\u00e9lo\\u00efse Mar\\u00e7ais"}', "partly \\u"],
    [`{"name":"${u("Héloïse Marçais")}"}`, "fully \\u"],
    ['{"name":"H&#233;lo&#xEF;se Mar&#xe7;ais"}', "numeric HTML"],
  ])("masks a passport name written %j (%s), the label covering the whole escaped run", (text) => {
    expect(sources(text, heloise())).toMatch(new RegExp(`^\\{"name":"${N}"\\}$`));
  });

  it("masks an escaped IBAN in both zones and an escaped phone in the sources, as their percent forms", () => {
    const esc = (v: string) => v.replace(/\d/g, (d) => "\\u003" + d);
    const pct = (v: string) => v.replace(/\d/g, (d) => "%3" + d);
    for (const zone of ["sources", "web"] as const) {
      const ctx = () => ({ table: new LabelTable({ passport: store() }), zone, origin: "https://mail.example" });
      expect(maskText(`IBAN ${esc(IBAN)}`, ctx())).toMatch(/^IBAN ⟨iban-[a-z0-9]{8}⟩$/);
      const phone = maskText(`Tél ${esc(OTHER)}`, ctx());
      expect(/^Tél ⟨tel-[a-z0-9]{8}⟩$/.test(phone)).toBe(/^Tél ⟨tel-/.test(maskText(`Tél ${pct(OTHER)}`, ctx())));
      if (zone === "sources") expect(phone).toMatch(/^Tél ⟨tel-[a-z0-9]{8}⟩$/);
    }
    // Only the separators escaped: the value is still found, as before the cost filter.
    for (const zone of ["sources", "web"] as const) {
      const ctx = () => ({ table: new LabelTable({ passport: store() }), zone, origin: "https://mail.example" });
      expect(maskText(`IBAN ${IBAN.match(/.{1,4}/g)!.join("&#160;")}`, ctx())).toMatch(/^IBAN ⟨iban-[a-z0-9]{8}⟩$/);
    }
    expect(sources(`Tél ${OTHER.match(/../g)!.join("&#32;")}`)).toMatch(/^Tél ⟨tel-[a-z0-9]{8}⟩$/);
    expect(sources(`Tél ${TEL.match(/../g)!.join("\\u002d")}`)).toMatch(/^Tél ⟨tel-[a-z0-9]{8}⟩$/);
    for (const t of ["Camille\\u0020Aubrac", "Camille &#32; Aubrac", "Camille &#160; Aubrac", "Camille &#32;Aubrac", "Camille\n&#32;Aubrac"])
      expect(sources(t), JSON.stringify(t)).toMatch(/^⟨nom-[a-z0-9]{8}⟩$/);
    // The passport's own phone, escaped, in the sources.
    expect(sources(`Tél ${esc(TEL)}`)).toMatch(/^Tél ⟨tel-[a-z0-9]{8}⟩$/);
  });

  it("keeps the labels after an escaped emoji in place", () => {
    expect(sources("\\uD83D\\uDE00 H\\u00e9lo\\u00efse Mar\\u00e7ais !", heloise())).toMatch(new RegExp(`^\\\\uD83D\\\\uDE00 ${N} !$`));
  });

  it("never masks it in the web zone", () => {
    const text = '{"name":"H\\u00e9lo\\u00efse Mar\\u00e7ais"}';
    expect(maskText(text, WEB(new LabelTable({ passport: heloise() })))).toBe(text);
  });
});

describe("the passport in the web zone", () => {
  const text = "AUBRAC Camille, C. Aubrac, au 14, r. des Tanneurs, né le 14/03/1990, Lucie Ferrand.";

  it("never masks it, and never builds the folded projection (ruling F19)", () => {
    expect(maskText(text, WEB(new LabelTable({ passport: store() })))).toBe(text);
    expect(folded).not.toHaveBeenCalled();
  });

  it("searches a filled entry by its passport forms, on its origin only (ruling F3)", () => {
    const s = store();
    const d = s.entries("p1").find((e) => e.field === "naissance")!;
    const t = new LabelTable({ passport: s });
    const label = t.label("date", canonicalOf(d), "web", "https://boutique.example", rawOf(d), { profile: "p1", id: d.id });
    expect(maskText("Né le 14/03/1990.", WEB(t, "https://boutique.example"))).toBe(`Né le ${label}.`);
    expect(maskText("Né le 14 mars 1990.", WEB(t, "https://boutique.example"))).toBe(`Né le ${label}.`);
    expect(maskText("Né le 14/03/1990.", WEB(t))).toBe("Né le 14/03/1990.");
  });

  it("never lets a filled name span an address's brackets on its origin", () => {
    const s = store();
    const d = s.entries("p1").find((e) => e.field === "nom")!;
    const t = new LabelTable({ passport: s });
    const label = t.label("nom", canonicalOf(d), "web", "https://boutique.example", rawOf(d), { profile: "p1", id: d.id });
    expect(maskText("Pour Aubrac <camille@boutique.example>", WEB(t, "https://boutique.example"))).toBe("Pour Aubrac <camille@boutique.example>");
    expect(maskText("Pour Camille Aubrac.", WEB(t, "https://boutique.example"))).toBe(`Pour ${label}.`);
  });
});
