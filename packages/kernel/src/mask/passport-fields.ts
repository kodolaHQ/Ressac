// The passport's field rules (design §§ 3, 6, 8.3, 9.2), pure: no Node import, the settings UI and chrome use it too.
import { IBAN_LENGTHS, ibanValid, nirValid } from "../outflow/detect.js";
import { canonical, detect, telDigitForms, type LabelType } from "./detectors.js";
import { foldWords } from "./projections.js";

export const PASSPORT_FIELDS = ["nom", "naissance", "proche", "adresse", "tel", "email", "iban", "piece", "secu", "plaque", "libre"] as const;
export type PassportField = (typeof PASSPORT_FIELDS)[number];
/** `given`/`family` for nom and proche; `text` for the others (naissance: YYYY-MM-DD). */
export type PassportValue = { given: string; family: string } | { text: string };
export type PassportEntry = {
  id: string;
  field: PassportField;
  value: PassportValue;
  variants: string[];
  origins: string[];
  how: "typed" | "click";
  from?: string;
  created: string;
  updated: string;
};

/** A passport's profile id: its file name in the Firefox profile, and its key in the kernel's store. */
export const PASSPORT_PROFILE = /^[A-Za-z0-9_-]{1,64}$/;
export const PASSPORT_LIMITS = { entries: 200, variants: 10, origins: 20, value: 300, variant: 200, forms: 64 } as const;

export const FIELD_LABEL: Record<PassportField, LabelType> = {
  nom: "nom",
  naissance: "date",
  proche: "nom",
  adresse: "adresse",
  tel: "tel",
  email: "email",
  iban: "iban",
  piece: "id",
  secu: "secu",
  plaque: "id",
  libre: "masque",
};

export const FIELD_GROUP: Record<PassportField, "identite" | "contact" | "banque" | "documents" | "autre"> = {
  nom: "identite",
  naissance: "identite",
  proche: "identite",
  adresse: "contact",
  tel: "contact",
  email: "contact",
  iban: "banque",
  piece: "documents",
  secu: "documents",
  plaque: "documents",
  libre: "autre",
};

/** A form searched in the folded projection; `initials`: offsets in `form` whose original char must be upper case. */
export type FoldedForm = { form: string; initials: number[] };
export type Forms = { folded: FoldedForm[]; digits: string[] };

const textOf = (e: PassportEntry) => ("text" in e.value ? e.value.text : "");
export const rawOf = (e: PassportEntry) => ("given" in e.value ? `${e.value.given.trim()} ${e.value.family.trim()}` : e.value.text);

const digitsOnly = (s: string) => /\d/.test(s) && /^[\d\s.,/_+()-]+$/.test(s);
const wordChars = (folded: string) => folded.replace(/ /g, "").length;
const MIN_FOLDED = 4;
const MIN_DIGITS = 6;

const PARTICLES = new Set(["de", "d", "du", "des", "le", "la", "van", "von", "di", "da"]);
const CIVILITIES = ["m", "mme", "mlle", "melle", "monsieur", "madame", "mademoiselle", "mr", "mrs", "ms"];

/** Design § 6.3 « Noms »: never a first name or a family name alone. */
function nameForms(given: string, family: string): FoldedForm[] {
  const all = foldWords(given);
  const first = foldWords(given.trim().split(/[\s,]+/)[0] ?? "");
  const family1 = foldWords(family);
  if (!first || !family1) return [];
  const parts = first.split(" ");
  const initials = [parts.map((p) => p[0]).join(" "), parts.map((p) => p[0]).join("")];
  const words = family1.split(" ");
  const families = [family1, ...(words.length > 1 && PARTICLES.has(words[0]!) ? [words.slice(1).join(" ")] : [])];
  const at = (offset: number, ini: string) => [...ini].flatMap((c, k) => (c === " " ? [] : [offset + k]));
  const out: FoldedForm[] = [];
  const plain = (form: string) => out.push({ form, initials: [] });
  for (const n of families) {
    [`${first} ${n}`, `${all} ${n}`, `${n} ${first}`, `${n} ${all}`].forEach(plain);
    for (const ini of initials) out.push({ form: `${ini} ${n}`, initials: at(0, ini) }, { form: `${n} ${ini}`, initials: at(n.length + 1, ini) });
    for (const c of CIVILITIES) plain(`${c} ${n}`);
  }
  return out;
}

const STREET_TYPES = [
  ["rue", "r"], ["avenue", "av", "ave"], ["boulevard", "bd", "bld", "boul"], ["place", "pl"], ["chemin", "ch", "chem"],
  ["allee", "all"], ["impasse", "imp"], ["route", "rte"], ["square", "sq"], ["cours", "crs"], ["faubourg", "fbg"],
  ["residence", "res"], ["passage", "pass"], ["esplanade", "esp"],
];
const NAME_WORDS = [["saint", "st"], ["sainte", "ste"], ["general", "gal"], ["marechal", "mal"], ["docteur", "dr"]];
const INDICES = [["bis", "b"], ["ter", "t"], ["quater", "q"]];
// On the folded street line: number [index] rest, or rest number [index] (Belgian order).
const NUMBER_FIRST = /^(\d+)( ?)(bis|ter|quater|b|t|q)? (.*\p{L}.*)$/u;
const NUMBER_LAST = /^(.*\p{L}.*) (\d+)( ?)(bis|ter|quater|b|t|q)?$/u;
const dedupe = <T>(xs: T[]) => [...new Set(xs)];

/**
 * Design § 6.3 « Adresse »: the street line only, in its writings, most like the written one first (a cap drops the
 * others). Never the postcode, the city or a street without its number. Only French abbreviations are known.
 */
function addressForms(text: string): string[] {
  const street = parseAddress(text).street;
  // The postcode and city line is never a form on its own (design § 6.3).
  if (!street) return [foldWords(text.split(/\r?\n/).find((l) => l.trim() && !POSTCODE_LINE.test(l.trim())) ?? "")];
  const f = foldWords(street);
  const first = NUMBER_FIRST.exec(f);
  const last = first ? null : NUMBER_LAST.exec(f);
  if (!first && !last) return [f];
  const [num, sep, index, rest] = first ? [first[1]!, first[2]!, first[3], first[4]!] : [last![2]!, last![3]!, last![4], last![1]!];
  const group = INDICES.find((g) => g.includes(index ?? ""));
  const numbers = dedupe([
    index ? `${num}${sep}${index}` : num,
    ...(group ? [`${num} ${group[0]}`, `${num}${group[0]}`, `${num} ${group[1]}`, `${num}${group[1]}`] : []),
  ]);
  const words = rest.split(" ");
  const type = STREET_TYPES.find((g) => g.includes(words[0]!));
  const types = type ? dedupe([words[0]!, ...type]) : [""];
  const nameWords = type ? words.slice(1) : words;
  const swap = (k: number) => nameWords.map((w) => NAME_WORDS.find((g) => g.includes(w))?.[k] ?? w).join(" ");
  const names = dedupe([nameWords.join(" "), swap(0), swap(1)]);
  const out: { form: string; changes: number }[] = [];
  for (const numberFirst of first ? [true, false] : [false, true])
    for (const n of numbers)
      for (const t of types)
        for (const nm of names) {
          const changes = +(n !== numbers[0]) + +(t !== types[0]) + +(nm !== names[0]) + +(numberFirst !== !!first);
          out.push({ form: (numberFirst ? [n, t, nm] : [t, nm, n]).filter(Boolean).join(" "), changes });
        }
  return out.sort((a, b) => a.changes - b.changes).map((x) => x.form);
}

const MONTHS_FR = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];
const MONTHS_FR_SHORT = ["janv", "fevr", "mars", "avr", "mai", "juin", "juil", "aout", "sept", "oct", "nov", "dec"];
const MONTHS_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Design § 6.3 « Date de naissance »: never without the year. */
function dateForms(text: string): Forms {
  const m = DATE.exec(text);
  if (!m) return { folded: [], digits: [] };
  const [, y, mm, dd] = m as unknown as [string, string, string, string];
  const [d, mo] = [String(Number(dd)), Number(mm) - 1];
  const days = d === "1" ? ["1er", "1"] : [d];
  const months = [MONTHS_FR[mo]!, MONTHS_FR_SHORT[mo]!, MONTHS_EN[mo]!.slice(0, 3)];
  const folded = [...days.flatMap((day) => months.map((month) => `${day} ${month} ${y}`)), `${MONTHS_EN[mo]} ${d} ${y}`, `${d} ${MONTHS_EN[mo]} ${y}`];
  return {
    folded: folded.map((form) => ({ form, initials: [] })),
    digits: [dd + mm + y, y + mm + dd, dd + mm + y.slice(2), d + String(mo + 1) + y],
  };
}

/** The value's own forms (design § 6.3), in priority order. */
function baseForms(e: PassportEntry): Forms {
  const t = textOf(e);
  const plain = (forms: string[]): Forms => ({ folded: forms.map((form) => ({ form, initials: [] })), digits: [] });
  switch (e.field) {
    case "nom":
    case "proche":
      return "given" in e.value ? { folded: nameForms(e.value.given, e.value.family), digits: [] } : plain([]);
    case "adresse":
      return plain(addressForms(t));
    case "naissance":
      return dateForms(t);
    case "tel":
      return { folded: [], digits: telDigitForms(canonical("tel", t)) };
    case "email":
      // The step-1 detector already masks the local part of any address in the sources.
      return plain([]);
    case "iban": {
      const v = canonical("iban", t);
      const bban = v.slice(4);
      const account = v.startsWith("FR") ? v.slice(14, 25) : "";
      return { folded: [], digits: [v.replace(/\D/g, ""), ...(/^\d+$/.test(bban) ? [bban] : []), ...(/^\d{11}$/.test(account) ? [account] : [])] };
    }
    case "secu": {
      const v = canonical("secu", t);
      return { folded: [], digits: /^\d{15}$/.test(v) ? [v, v.slice(0, 13)] : [] };
    }
    case "piece":
    case "plaque": {
      const f = foldWords(t);
      return plain([f, f.replace(/ /g, "")]);
    }
    case "libre":
      return digitsOnly(t) ? { folded: [], digits: [t.replace(/\D/g, "")] } : plain([foldWords(t)]);
  }
}

/** Design §§ 6.3-6.4: the value's forms then the user's variants as written, deduped, too short ones dropped, at most 64. */
export function passportForms(e: PassportEntry): Forms {
  const seen = new Set<string>();
  const keep = (f: Forms): Forms => ({
    folded: f.folded.filter((x) => wordChars(x.form) >= MIN_FOLDED && !seen.has(x.form) && seen.add(x.form)),
    digits: f.digits.filter((d) => d.length >= MIN_DIGITS && !seen.has(d) && seen.add(d)),
  });
  const variants = keep({
    folded: e.variants.filter((v) => !digitsOnly(v)).map((v) => ({ form: foldWords(v), initials: [] })),
    digits: e.variants.filter(digitsOnly).map((v) => v.replace(/\D/g, "")),
  });
  // The user's variants are never dropped (at most 10); the value's writings fill what is left.
  const base = keep(baseForms(e));
  const room = PASSPORT_LIMITS.forms - variants.folded.length - variants.digits.length;
  const folded = base.folded.slice(0, room);
  return { folded: [...folded, ...variants.folded], digits: [...base.digits.slice(0, room - folded.length), ...variants.digits] };
}

/** The label table key's canonical value (design § 6.6): step 1's when the type has one, else the folded value. */
export function canonicalOf(e: PassportEntry): string {
  if ("given" in e.value) return canonical("nom", rawOf(e));
  const t = e.value.text;
  return e.field === "tel" || e.field === "email" || e.field === "iban" || e.field === "secu" ? canonical(e.field, t) : foldWords(t);
}

const POSTCODE_LINE = /^(\d{5})\s+(\S.*)$/;
const NUMBERED = /^\d+\s*(?:bis|ter|quater|[btq])?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])\d+(?:\s*(?:bis|ter|quater|[btq]))?$/iu;

/** The street line (the first one starting or ending with a number), and a `NNNNN city` line, as written. */
export function parseAddress(text: string): { street: string | null; postcode: string | null; city: string | null } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pc = lines.find((l) => POSTCODE_LINE.test(l));
  const m = pc ? POSTCODE_LINE.exec(pc) : null;
  const street = lines.find((l) => l !== pc && NUMBERED.test(l) && /\p{L}/u.test(l)) ?? null;
  return { street, postcode: m?.[1] ?? null, city: m?.[2] ?? null };
}

export type ProblemCode = "iban-short" | "iban-key" | "secu-short" | "secu-key" | "tel" | "email" | "plate" | "date" | "name" | "address" | "piece" | "too-short" | "too-short-digits" | "duplicate" | "origin" | "full" | "variants-full" | "origins-full" | "long" | "malformed";
export type WarningCode = "one-word" | "email-domain";
export type Problem = { code: ProblemCode; at: "value" | "variant" | "origin"; index?: number };
export type Warning = { code: WarningCode; index?: number };

function validDate(t: string): boolean {
  const m = DATE.exec(t);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === t && Number(m[1]) >= 1900 && d.getTime() < Date.now();
}

/** Design §§ 6.3-6.4: digits only, at least 6; otherwise at least 4 letters or digits, one a letter (« 1234 € » is refused). */
const shortText = (s: string): ProblemCode | null =>
  digitsOnly(s)
    ? s.replace(/\D/g, "").length < MIN_DIGITS ? "too-short-digits" : null
    : wordChars(foldWords(s)) < MIN_FOLDED || !/\p{L}/u.test(s) ? "too-short" : null;
const oneWord = (s: string) => !digitsOnly(s) && !foldWords(s).includes(" ");

/** The value's own check (design § 9.2 « Validation »), or null when valid. */
function valueProblem(e: PassportEntry): ProblemCode | null {
  if ("given" in e.value) return /\p{L}/u.test(e.value.given) && /\p{L}/u.test(e.value.family) ? null : "name";
  const t = e.value.text.trim();
  const compact = t.replace(/[\s.-]/g, "").toUpperCase();
  switch (e.field) {
    case "naissance":
      return validDate(t) ? null : "date";
    case "adresse":
      return /\d/.test(t) && /\p{L}/u.test(t) ? null : "address";
    case "tel":
      return /^(?:0\d{9}|\+\d{8,15})$/.test(t.replace(/[\s.()-]/g, "")) ? null : "tel";
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? null : "email";
    case "iban":
      return compact.length !== IBAN_LENGTHS.get(compact.slice(0, 2)) ? "iban-short" : ibanValid(compact) ? null : "iban-key";
    case "secu":
      return !/^\d{5}(?:\d{2}|2[AB])\d{8}$/.test(compact) ? "secu-short" : nirValid(compact) ? null : "secu-key";
    case "piece":
      return /^[A-Z0-9]{6,20}$/.test(compact) ? null : "piece";
    case "plaque":
      return /^(?:[A-Z]{2}[- ]?\d{3}[- ]?[A-Z]{2}|\d{1,4} ?[A-Z]{1,3} ?(?:\d{2}|2A|2B))$/.test(t.toUpperCase()) ? null : "plate";
    default:
      return shortText(t);
  }
}

const strings = (x: unknown) => Array.isArray(x) && x.every((v) => typeof v === "string");
const isField = (x: unknown): x is PassportField => typeof x === "string" && (PASSPORT_FIELDS as readonly string[]).includes(x);

/** The entry has the shape its type says (it crosses the RPC boundary): checked before anything reads it, so nothing throws. */
function wellFormed(e: unknown): e is PassportEntry {
  if (typeof e !== "object" || e === null) return false;
  const { id, field, value, variants, origins } = e as Record<string, unknown>;
  if (typeof id !== "string" || !isField(field) || !strings(variants) || !strings(origins)) return false;
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return field === "nom" || field === "proche" ? typeof v.given === "string" && typeof v.family === "string" : typeof v.text === "string";
}

/**
 * Design § 9.2 « Validation », the same in the UI and in chrome. A malformed entry gets only `malformed`. `others`: the passport's other entries (an entry with
 * the same id is the one being edited, not compared). A warning never blocks a save.
 */
export function validateEntry(e: PassportEntry, others: readonly PassportEntry[]): { problems: Problem[]; warnings: Warning[] } {
  if (!wellFormed(e)) return { problems: [{ code: "malformed", at: "value" }], warnings: [] };
  const problems: Problem[] = [];
  const warnings: Warning[] = [];
  const rest = others.filter((o) => o.id !== e.id);
  if (rest.length >= PASSPORT_LIMITS.entries) problems.push({ code: "full", at: "value" });
  const valueCode = rawOf(e).length > PASSPORT_LIMITS.value ? "long" : valueProblem(e);
  if (valueCode) problems.push({ code: valueCode, at: "value" });
  else if (rest.some((o) => FIELD_LABEL[o.field] === FIELD_LABEL[e.field] && canonicalOf(o) === canonicalOf(e))) problems.push({ code: "duplicate", at: "value" });
  if (e.field === "email") warnings.push({ code: "email-domain" });
  if (e.field === "libre" && !valueCode && oneWord(textOf(e))) warnings.push({ code: "one-word" });
  if (e.variants.length > PASSPORT_LIMITS.variants) problems.push({ code: "variants-full", at: "variant" });
  e.variants.forEach((v, index) => {
    const code = v.length > PASSPORT_LIMITS.variant ? "long" : shortText(v);
    if (code) problems.push({ code, at: "variant", index });
    else if (oneWord(v)) warnings.push({ code: "one-word", index });
  });
  if (e.origins.length > PASSPORT_LIMITS.origins) problems.push({ code: "origins-full", at: "origin" });
  e.origins.forEach((o, index) => {
    if (cleanOrigin(o) !== o) problems.push({ code: "origin", at: "origin", index });
  });
  return { problems, warnings };
}

/**
 * A passport read from disk or replaced (outside the editor): entry i is checked against the entries kept before it,
 * so a duplicate keeps its first copy and a 201st entry drops only itself. A repeated id drops the later copy.
 */
export function validatePassport(entries: readonly PassportEntry[]): { kept: PassportEntry[]; dropped: { index: number; problems: Problem[] }[] } {
  const kept: PassportEntry[] = [];
  const dropped: { index: number; problems: Problem[] }[] = [];
  entries.forEach((e, index) => {
    const problems: Problem[] = kept.some((k) => k.id === e?.id) ? [{ code: "duplicate", at: "value" }] : validateEntry(e, kept).problems;
    if (problems.length) dropped.push({ index, problems });
    else kept.push(e);
  });
  return { kept, dropped };
}

const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/;

/** A « Remplissable sur » host from what the user typed: no scheme, no path, lower case; null when no valid host. */
export function cleanOrigin(input: string): string | null {
  const h = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#][^]*$/, "");
  return HOST.test(h) ? h : null;
}

const LOOPBACK = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;

/**
 * A page origin a « Remplissable sur » host covers (design § 8.1): `https://host`, and `https://www.host` when the host
 * has no `www.`; no http, no other subdomain. `test.localAddresses` (e2e only) also takes http on a loopback host:
 * callers set it from RESSAC_TEST_LOCAL_ADDRESSES, which a packaged build never honours (the host deletes RESSAC_TEST_*
 * at start, chrome reads it through `testEnv`).
 */
export function originMatches(host: string, origin: string, test: { localAddresses?: boolean } = {}): boolean {
  if (origin === `https://${host}` || (!host.startsWith("www.") && origin === `https://www.${host}`)) return true;
  return test.localAddresses === true && LOOPBACK.test(host) && origin === `http://${host}`;
}

const NUMBER_FIELDS: ReadonlySet<PassportField> = new Set(["iban", "tel", "secu", "piece", "plaque"]);

/** Design § 9.2 « la valeur masquée », for the settings row and the fill cards. */
export function maskedDisplay(e: PassportEntry): string {
  const t = textOf(e).trim();
  if (e.field === "email") return `${[...t][0] ?? ""}••••••${t.slice(t.indexOf("@"))}`;
  if (e.field === "naissance") return "••/••/••••";
  if (NUMBER_FIELDS.has(e.field)) {
    const last = t.replace(/[^\p{L}\p{N}]/gu, "").slice(-4);
    return `•••• ${last.slice(0, 2)} ${last.slice(2)}`;
  }
  return rawOf(e)
    .trim()
    .replace(/\s*\n\s*/g, ", ")
    .replace(/[\p{L}\p{N}\p{M}]+/gu, (w) => {
      const [c, ...more] = [...w];
      return (/\p{L}/u.test(c!) ? c : "•") + "•".repeat(more.length);
    });
}

export const PASSPORT_KINDS = ["prenoms", "nom_famille", "nom_complet", "naissance", "adresse", "adresse_voie", "code_postal", "ville", "tel", "email", "iban", "secu", "piece", "plaque"] as const;
export type PassportKind = (typeof PASSPORT_KINDS)[number];

const KIND_FIELD: Record<PassportKind, PassportField> = {
  prenoms: "nom",
  nom_famille: "nom",
  nom_complet: "nom",
  naissance: "naissance",
  adresse: "adresse",
  adresse_voie: "adresse",
  code_postal: "adresse",
  ville: "adresse",
  tel: "tel",
  email: "email",
  iban: "iban",
  secu: "secu",
  piece: "piece",
  plaque: "plaque",
};

/** A YYYY-MM-DD date as DD/MM/YYYY (design § 8.3); any other text as is. */
export const dayFirst = (date: string): string => date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3/$2/$1");

/** What a fill by kind writes (design § 8.3): a date as YYYY-MM-DD in a date input, DD/MM/YYYY elsewhere; null when the entry has none. */
export function valueForKind(e: PassportEntry, kind: PassportKind, inputType: string): string | null {
  if (KIND_FIELD[kind] !== e.field) return null;
  if ("given" in e.value) return kind === "prenoms" ? e.value.given.trim() : kind === "nom_famille" ? e.value.family.trim() : rawOf(e);
  const t = e.value.text;
  switch (kind) {
    case "naissance":
      return inputType === "date" ? t : dayFirst(t);
    case "adresse_voie":
      return parseAddress(t).street;
    case "code_postal":
      return parseAddress(t).postcode;
    case "ville":
      return parseAddress(t).city;
    default:
      return t;
  }
}

/** A word written all in capitals (two letters at least): « AUBRAC », never « La » or « J. ». */
const allCaps = (w: string) => /\p{L}.*\p{L}/u.test(w) && w === w.toUpperCase() && w !== w.toLowerCase();

/**
 * A name's given and family parts: a run of words in capitals is the family name, otherwise the last word is; the
 * particles before it go with it (« de La Tour »). The rest is the given name. A name all in capitals ends on its family name.
 */
export function splitName(text: string): { given: string; family: string } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  let at = words.findIndex(allCaps);
  let end = at + 1;
  if (at < 0 || words.every(allCaps)) [at, end] = [words.length - 1, words.length];
  else while (end < words.length && allCaps(words[end]!)) end++;
  // A particle joins the family name while a given word is left.
  while (at > 0 && at - 1 + words.length - end > 0 && PARTICLES.has(foldWords(words[at - 1]!))) at--;
  return { given: [...words.slice(0, at), ...words.slice(end)].join(" "), family: words.slice(at, end).join(" ") };
}

// Fields a value is guessed as by its shape, and the detector type that must find it whole (none: its check alone).
const SHAPES: [PassportField, LabelType | null][] = [["iban", "iban"], ["secu", "secu"], ["tel", "tel"], ["email", null], ["plaque", null], ["naissance", null]];
const CAPITALISED = /^\p{Lu}[\p{L}\p{M}'’.-]*$/u;

/**
 * The passport field `text` is, when it is exactly one value: a shape (detected whole, where a detector knows it), or
 * two to four capitalised words for a name (particles allowed inside). The value must pass `validateEntry`; else `libre`.
 */
export function guessField(text: string): PassportField {
  const t = text.trim();
  const valid = (field: PassportField, value: PassportValue) =>
    validateEntry({ id: "guess", field, value, variants: [], origins: [], how: "click", created: "", updated: "" }, []).problems.length === 0;
  const found = detect(t, "sources");
  const whole = found.length === 1 && found[0]!.start === 0 && found[0]!.end === t.length ? found[0]!.type : null;
  for (const [field, type] of SHAPES) if ((type === null || whole === type) && valid(field, { text: t })) return field;
  const words = t.split(/\s+/);
  const named = words.length >= 2 && words.length <= 4 && [words[0]!, words.at(-1)!].every((w) => CAPITALISED.test(w)) && words.every((w) => CAPITALISED.test(w) || PARTICLES.has(foldWords(w)));
  return named && valid("nom", splitName(t)) ? "nom" : "libre";
}
