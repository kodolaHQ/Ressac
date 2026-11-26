import {
  API_KEY,
  cardSpans,
  ibanSpans,
  JWT,
  NIR,
  nirValid,
  PRIVATE_KEY,
  randomTokens,
} from "../outflow/detect.js";
import { ascii, fold } from "../outflow/spelled.js";
import { gaps, originalSpan, projections, type Projection } from "./projections.js";

export type LabelType = "code" | "iban" | "carte" | "tel" | "email" | "adresse" | "nom" | "id" | "cle" | "secu" | "motdepasse" | "masque" | "date";
export type Zone = "sources" | "web";
/** Masked in both zones; the other types only in the sources. */
export const HIGH_RISK: ReadonlySet<LabelType> = new Set<LabelType>(["iban", "carte", "secu", "id", "cle", "code"]);
export type Found = { type: LabelType; start: number; end: number; canonical: string };

type Hit = [start: number, end: number, type: LabelType, canonical: string];

const CONTEXT_WINDOW = 40;
// Matched on folded text (no accents, lower case). A postal or promo code is no secret; « access_token= » names a URL
// parameter, whose value the URL masking already hides, not a code shown to the user; « %2Fa » is an escaped `/a`, no 2FA.
// German compounds end in « code » (Bestätigungscode); Spanish says « código », « clave », « verificación ».
const CODE_CONTEXT =
  /(?<!\p{L})(?:code(?! (?:postal|promo))|(?:bestatigungs|sicherheits|verifizierungs|zugangs|einmal|anmelde|freischalt|pruf)code|passcode|verification|verificacion|verify|otp|pin|secret|(?<![_-])token(?![_=])|(?<!%)2fa|authenti(?:fication|cation)|mot de passe|a usage unique|codigo(?! postal)|clave|contrasena|kennwort|passwort|einmalpasswort)(?!\p{L})/u;
// 4 to 8 digits, maybe grouped (381 624), whole: not glued to a letter or digit, not a price (2 340,12 €).
const URL_HOST = /\bhttps?:\/\/[^\s/?#<>"'`]+/gi;
// A code of capitals and digits (X7K9P2, QX4-7BR, X7K-9P2-QR4): 5 to 16 of them with at least one of each, maybe two
// inner `-`. No start after a `%` (« %2F127 » is URL encoding), nor after a letter, digit or `-`, so each run is tried
// once. shortcut: lower-case codes are left out, add them if a sender uses them.
const CODE_MIXED = /(?<![\p{L}\p{N}%-])(?=[A-Z0-9-]{0,18}?\d)(?=[A-Z0-9-]{0,18}?[A-Z])[A-Z0-9]{2,16}(?:-[A-Z0-9]{2,8}){0,2}(?![\p{L}\p{N}]|-[\p{L}\p{N}])/gu;
// Letters then digits or digits then letters is a technical name (ES2022, SHA256, RTX4090, 1080P): a code interleaves them.
const TECH_NAME = /^[A-Z]{1,4}\d+$|^\d+[A-Z]{1,3}$/;
const mixedCode = (v: string) => v.length >= 5 && v.length <= 16 && !TECH_NAME.test(v);
// Not after `digit/`: a date's year (14/03/2027) is no code. Not after `%`: a run glued to an escape (« %3A62179 ») is
// URL encoding; the percent projection reads the code an escape hides (« %20482913 » → « 482913 »).
const CODE_DIGITS = /(?<![\p{L}\p{N}%]|\d[ ./-])\d(?:[ .-]?\d){3,7}(?![\p{L}\p{N}]|[ .-]\d|[.,]\d|\s*€)/gu;
// Separators: one space or tab, or `.` `-` `+` (a GET form's space) `/` `_`, maybe spaced. A date (14/03/1990) has too few digits.
const TEL_FR = /(?<![\p{N}+])(?:0[1-9]|\(0[1-9]\))(?:(?:[ \t]?[.+/_-][ \t]?|[ \t])?\d{2}){4}(?!\p{N})/gu;
// A US number written the US way, area code in brackets or the three groups joined by « - » or « . » (a run of 10
// digits is an order number as often); area code and exchange never start with 0 or 1.
const TEL_US = /(?<![\p{N}+.-])(?:\([2-9]\d{2}\)[ \t]?|[2-9]\d{2}[.-])[2-9]\d{2}[.-]\d{4}(?!\p{N}|[.-]\d)/gu;
// A UK number without +44: 11 digits from 01, 02, 03 or 07 in the usual groups (020 7946 0958, 0121 496 0000,
// 07700 900123). Not in one run: 11 digits from 0 are an order or account number as often. A French number has 10.
const TEL_UK = /(?<![\p{N}+])0[1237](?:\d[ \t]\d{4}[ \t]\d{4}|\d{2}[ \t]\d{3}[ \t]\d{4}|\d{3}[ \t]\d{6})(?!\p{N})/gu;
// No country code starts with 0: « 00042178306 » (an account number) is no phone. « 00 33 6… » is spaced after 00.
const TEL_INTL = /(?<![\p{N}+])(?:\+|00[ .-]?)[1-9](?:(?:[ \t]?[.+/_-][ \t]?|[ \t])?(?:\(0\)[ .-]?)?\d){7,14}(?!\p{N})/gu;
// A French account number (11 digits) after an account word on its line: typed `id`, in the sources only.
// shortcut: French length only, add other countries' lengths if their banks show in the sources.
const ACCOUNT = /(?<![\p{L}\p{N}+])\d{11}(?![\p{L}\p{N}])/gu;
const ACCOUNT_CONTEXT = /(?<!\p{L})(?:compte|livret|account)(?!\p{L})[^\n]{0,30}$/u;
// Bounded parts and no start inside a run of address characters: linear on a long token without `@`.
const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]{1,64})@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g;
const PASSWORD = /(?<!\p{L})(?:mot de passe|password|mdp)\s{0,8}:\s{0,8}(\S{1,128})/dgiu;
// The number may be spaced in groups of digits (« 1903 1234 5678 »): `identityNumber` checks its length.
const IDENTITY =
  /(?<![\p{L}\p{N}])(?:passeport|passport|cni|carte(?:[ \t]+\p{L}{1,20}){0,3}?[ \t]+d['’ ]?identit[eé]|pi[eè]ce d['’ ]?identit[eé]|id card|identity card|document number|permis)(?!\p{L})[^\n\d]{0,30}?(?<![A-Za-z0-9])((?=[A-Za-z0-9]*\d|[A-Za-z]{1,3}[ \t]\d)[A-Za-z0-9]{2,20}(?:[ \t][A-Za-z0-9]{2,6}){0,4})(?![A-Za-z0-9])/dgiu;
/**
 * The identity number at the head of a match, or undefined: its chunks while each holds a digit or is in capitals
 * (« AB 123 456 », not « for 10 years »), without trailing letter chunks; 6 to 20 characters, and when spaced, 9 or a
 * letter (a spaced date « 12 03 2027 » is no identity number).
 */
function identityNumber(v: string): string | undefined {
  const chunks = v.split(/[ \t]/);
  let k = 0;
  while (k < chunks.length && (/\d/.test(chunks[k]!) || chunks[k] === chunks[k]!.toUpperCase())) k++;
  while (k > 0 && !/\d/.test(chunks[k - 1]!)) k--;
  const s = chunks.slice(0, k).join("");
  if (!/\d/.test(s) || s.length > 20 || s.length < (k > 1 && !/[A-Za-z]/.test(s) ? 9 : 6)) return undefined;
  // One separator character between chunks: the kept text is as long as the chunks joined by one space.
  return v.slice(0, chunks.slice(0, k).join(" ").length);
}
// The display name of a `Nom <adresse>` header: at a line start, after `:` `,` `;` or a time (a quote line's « at 10:12 AM »,
// « à 10h12 »), up to 5 words, or a whole quoted string (Outlook's « "Ferrand, Lucie" »), maybe with a `(note)` after it.
// Groups 1-3: the quoted name; 4: the bare one; 5: the domain. Bounded, and no lookbehind: a long run of spaces would make one quadratic.
const NAME_HEADER =
  /(?:^|[\n:,;]|\d{1,2}[:h]\d{2}(?:[ \t]?[AaPp]\.?[Mm]\.?)?)[ \t]{0,8}(?:"([\p{L}\p{M}'’., \t-]{1,80})"|'([\p{L}\p{M}’., \t-]{1,80})'|«[ \t\u00a0]?([\p{L}\p{M}'’.,-]{1,40}(?:[ \t]{1,4}[\p{L}\p{M}'’.,-]{1,40}){0,4})[ \t\u00a0]?»|(\p{L}[\p{L}\p{M}'’.-]{0,40}(?:[ \t]{1,4}\p{L}[\p{L}\p{M}'’.-]{0,40}){0,4}))(?:[ \t]{1,4}\([^()<>\n]{0,40}\))?[ \t]{0,4}<[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9.-]{1,253})/dgu;
// Words that make a display name an organisation's, accents and case aside. Short on purpose: a person named « Poste »
// would be shown. shortcut: French and a few English words, add others when the sources show more languages.
export const ORG_WORDS = new Set([
  "banque", "bank", "credit", "caisse", "assurance", "assurances", "mutuelle", "impots", "tresor", "urssaf", "mairie",
  "service", "services", "support", "equipe", "team", "societe", "sas", "sarl", "groupe", "agence", "boutique",
  "colis", "poste", "livraison", "noreply", "no-reply", "notifications", "newsletter", "client", "clients",
]);
/** Letters and digits only, lower case, no accents: « Banque Ardoise » and « banque-ardoise » compare equal. */
const bare = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const ARTICLES = new Set(["la", "le", "les", "l"]);
// Common French first names, accents dropped (copied from the B3 utility bench's list): a name whose first word is the
// sender's domain label but holds one of these is a surname written first (« Martin Lucie » <l@martin.fr>), a person.
// One name is left out on purpose (test/no-owner-name.test.ts). shortcut: about 120 names, add others if a person's name written surname first shows in clear.
const FIRST_NAMES = new Set(("jean pierre michel andre philippe alain jacques bernard rene louis patrick nicolas daniel christian francois christophe " +
  "eric frederic laurent stephane david olivier thierry julien sebastien pascal dominique gerard marcel paul antoine maxime alexandre " +
  "guillaume vincent romain hugo lucas nathan leo gabriel arthur jules raphael adam mathieu benoit cedric fabrice yves henri georges " +
  "marie jeanne francoise monique catherine nathalie isabelle sylvie anne martine christine sophie valerie sandrine celine stephanie " +
  "nicole veronique chantal sandra aurelie emilie julie camille laura sarah manon emma lea chloe ines jade louise alice lina zoe " +
  "helene caroline elodie audrey melanie virginie patricia brigitte josiane danielle juliette charlotte pauline marion lucie odile " +
  "nadia bastien marc karine agnes emmanuelle beatrice margaux").split(" "));
const plain = (w: string) => w.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * A header's display name that looks like an organisation's, not a person's: a label of the sender's domain (but its
 * last), as the whole name or its first word (« Free Mobile » <x@free.fr>; « Camille Exemple » <x@exemple.fr> stays); a one-word acronym of up to 5 characters (DGFiP); or an organisation
 * word at its head (« Banque Ardoise », « La Poste »), unless two capitalised words follow, a person's name
 * (« Service Lucie Ferrand »). A person writing from a company domain stays a name, and so does « Marie Banque ».
 */
function organisation(name: string, domain: string): boolean {
  const labels = domain.toLowerCase().split(".").slice(0, -1).map(bare);
  const parts = name.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean).map((w) => bare(w));
  if (labels.includes(bare(name)) || (labels.includes(parts[0]!) && !parts.slice(1).some((w) => FIRST_NAMES.has(w)))) return true;
  const words = name.split(/[ \t]+/);
  if (words.length === 1 && name.length <= 5 && [...name].filter((c) => /\p{Lu}/u.test(c)).length >= Math.max(2, name.length - 1)) return true;
  const head = ARTICLES.has(plain(words[0]!).replace(/['’]$/, "")) && words.length > 1 ? 1 : 0;
  if (!ORG_WORDS.has(plain(words[head]!))) return false;
  const rest = words.slice(head + 1);
  return !(rest.length >= 2 && rest.every((w) => /^\p{Lu}/u.test(w) && !ORG_WORDS.has(plain(w))));
}

/** NFKC, digits of any script as ASCII. */
const plainDigits = (s: string) => s.normalize("NFKC").replace(/(?![0-9])\p{Nd}/gu, ascii);

/** The form a value is compared in: one canonical string per value of a type. */
export function canonical(type: LabelType, raw: string): string {
  const s = plainDigits(raw);
  switch (type) {
    case "iban":
    case "carte":
    case "secu":
      return s.replace(/[^\p{L}\p{N}]/gu, "").toUpperCase();
    case "tel": {
      const t = s.replace(/\(0\)/, "");
      const d = t.replace(/\D/g, "");
      if (t.trimStart().startsWith("+")) return "+" + d;
      if (d.startsWith("00")) return "+" + d.slice(2);
      // 11 digits from 0: a UK number (TEL_UK); 10 not from 0: a US one (TEL_US).
      if (d.startsWith("0")) return (d.length === 11 ? "+44" : "+33") + d.slice(1);
      return d.length === 10 ? "+1" + d : "+" + d;
    }
    case "email":
      // The domain is case-insensitive too; the same local part at two domains is two values.
      return s.toLowerCase();
    case "nom":
      // « Ferrand, Lucie » is Outlook's surname first: stored as « lucie ferrand », the name matcher finds both orders.
      if (/^[^,]+,[^,]+$/.test(raw)) return canonical("nom", raw.split(",").reverse().join(" "));
      return raw.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
    default:
      return raw;
  }
}

/**
 * The digit strings a phone is written in, from its canonical form: international, 00, for +33 the 0, 330 and 9-digit
 * ones, for +1 the 10 digits, for +44 the 0 one (the national forms TEL_US and TEL_UK read).
 */
export function telDigitForms(canonicalTel: string): string[] {
  const intl = canonicalTel.slice(1);
  const fr = intl.startsWith("33") ? intl.slice(2) : undefined;
  const national = intl.length === 11 && intl.startsWith("1") ? [intl.slice(1)] : intl.startsWith("44") ? ["0" + intl.slice(2)] : [];
  return [intl, "00" + intl, ...(fr ? ["0" + fr, "330" + fr, fr] : []), ...national];
}

// A French RIB in its four pieces, as banks print it: bank (5 digits), branch (5), account (11, maybe with letters), key (2),
// with up to 40 non-digits between them (their names, a line break). Kept only when the RIB key is right (1 in 97 by
// chance), the account holds a digit and a bank word comes before: postcodes and a heading in capitals are no RIB.
const RIB = /(?<!\p{N})(\d{5})(?!\p{N})\D{1,40}?(?<!\p{N})(\d{5})(?!\p{N})\D{1,40}?(?<![\p{L}\p{N}])(?=[A-Z]*\d)([0-9A-Z]{11})(?![\p{L}\p{N}])\D{1,40}?(?<!\p{N})(\d{2})(?!\p{N})/dgu;
const BANK_CONTEXT = /(?<!\p{L})(?:rib|banque|bank|guichet|compte|cle|bic|iban|virement)(?!\p{L})/u;
const BANK_WINDOW = 80;
// An account's letters count as digits in the RIB key (A and J are 1, B, K and S are 2…).
const ribDigits = (account: string) => account.replace(/[A-Z]/g, (c) => String(((c.charCodeAt(0) - 65) % 9) + 1 + (c >= "S" ? 1 : 0)));
const mod97 = (digits: string) => [...digits].reduce((r, d) => (r * 10 + Number(d)) % 97, 0);

/** The four pieces of each RIB in `t` whose key is right, typed `iban` and all canonical as that RIB's IBAN. */
function ribPieces(t: string): Hit[] {
  const out: Hit[] = [];
  for (const m of t.matchAll(RIB)) {
    const [bank, branch, account, key] = [m[1]!, m[2]!, m[3]!, m[4]!];
    if (!BANK_CONTEXT.test(fold(t.slice(Math.max(0, m.index - BANK_WINDOW), m.indices![2]![0])))) continue;
    if ((89 * Number(bank) + 15 * Number(branch) + 3 * mod97(ribDigits(account)) + Number(key)) % 97 !== 0) continue;
    const bban = bank + branch + account + key;
    const check = 98 - mod97((bban + "FR00").replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55)));
    const iban = "FR" + String(check).padStart(2, "0") + bban;
    for (let g = 1; g <= 4; g++) out.push([m.indices![g]![0], m.indices![g]![1], "iban", iban]);
  }
  return out;
}

const nearCode = (t: string, start: number, end: number) =>
  CODE_CONTEXT.test(fold(t.slice(Math.max(0, start - CONTEXT_WINDOW), end + CONTEXT_WINDOW)));

const CARD_CONTEXT = /(?<!\p{L})(?:carte|card|cb|visa|mastercard|amex|kreditkarte|tarjeta)(?!\p{L})/u;

/**
 * The numbers a checksum vouches for (IBAN, RIB, card, social security number) in `t`. `gapped`: `t` is the gaps
 * projection, where a table's cells read as one number: a card there (Luhn passes 1 in 10) needs a card word nearby.
 */
function checksummed(t: string, gapped: boolean): Hit[] {
  const out: Hit[] = [];
  for (const [start, end, v] of ibanSpans(t)) out.push([start, end, "iban", v]);
  out.push(...ribPieces(t));
  for (const [start, end, v] of cardSpans(t))
    if (!gapped || CARD_CONTEXT.test(fold(t.slice(Math.max(0, start - CONTEXT_WINDOW), end + CONTEXT_WINDOW)))) out.push([start, end, "carte", v]);
  for (const m of t.matchAll(NIR)) {
    const v = canonical("secu", m[0]);
    if (nirValid(v)) out.push([m.index, m.index + m[0].length, "secu", v]);
  }
  return out;
}

/** Every finding in one projected text `t` (digits already ASCII), in `t`'s offsets. */
function scan(t: string, zone: Zone): Hit[] {
  const out = checksummed(t, false);
  // A secret of a known shape (an API key, a private key, a token): « clé masquée », not an identity number.
  for (const re of [API_KEY, PRIVATE_KEY, JWT]) for (const m of t.matchAll(re)) out.push([m.index, m.index + m[0].length, "cle", m[0]]);
  for (const token of new Set(randomTokens(t)))
    for (let i = t.indexOf(token); i >= 0; i = t.indexOf(token, i + token.length)) out.push([i, i + token.length, "id", token]);
  for (const m of t.matchAll(IDENTITY)) {
    const v = identityNumber(m[1]!);
    const start = m.indices![1]![0];
    if (v) out.push([start, start + v.length, "id", v.replace(/[ \t]/g, "")]);
  }
  // A URL's host and port are never a code; its path, query and fragment may carry one (`/verify/482913`, `?code=…`).
  const addresses = [...t.matchAll(URL_HOST)].map((m) => [m.index, m.index + m[0].length] as const);
  for (const m of t.matchAll(CODE_DIGITS)) {
    const end = m.index + m[0].length;
    if (addresses.some(([a, b]) => m.index >= a && m.index < b)) continue;
    // A postcode before its city on the same line (69005 Lyon), unless a code word comes right before the number.
    const postcode =
      m[0].length === 5 && /^[ \t]+\p{Lu}/u.test(t.slice(end, end + 3)) && !CODE_CONTEXT.test(fold(t.slice(Math.max(0, m.index - 20), m.index)));
    if (!postcode && nearCode(t, m.index, end)) out.push([m.index, end, "code", m[0].replace(/\D/g, "")]);
  }
  for (const m of t.matchAll(CODE_MIXED)) {
    const end = m.index + m[0].length;
    const v = m[0].replace(/-/g, "");
    if (mixedCode(v) && !addresses.some(([a, b]) => m.index >= a && m.index < b) && nearCode(t, m.index, end))
      out.push([m.index, end, "code", v]);
  }
  if (zone === "web") return out;
  for (const re of [TEL_FR, TEL_INTL, TEL_US, TEL_UK]) for (const m of t.matchAll(re)) out.push([m.index, m.index + m[0].length, "tel", canonical("tel", m[0])]);
  for (const m of t.matchAll(ACCOUNT)) if (ACCOUNT_CONTEXT.test(fold(t.slice(Math.max(0, m.index - CONTEXT_WINDOW), m.index)))) out.push([m.index, m.index + 11, "id", m[0]]);
  for (const m of t.matchAll(EMAIL)) out.push([m.index, m.index + m[1]!.length, "email", canonical("email", m[0])]);
  for (const m of t.matchAll(PASSWORD)) out.push([...m.indices![1]!, "motdepasse", m[1]!]);
  for (const m of t.matchAll(NAME_HEADER)) {
    const g = [1, 2, 3, 4].find((i) => m[i] !== undefined)!;
    // A quoted run may hold padding spaces and no letter at all (« " , " »): trimmed, and a name needs a letter.
    const raw = m[g]!.trim();
    const start = m.indices![g]![0] + m[g]!.indexOf(raw);
    if (/\p{L}/u.test(raw) && !organisation(raw, m[5]!)) out.push([start, start + raw.length, "nom", canonical("nom", raw)]);
  }
  return out;
}

/** Codes written in words: each numeral run of 4 to 8 digits near a code word of the original text. */
function spelledCodes(p: Projection, text: string): Hit[] {
  const out: Hit[] = [];
  for (const m of p.text.matchAll(/\d+/g)) {
    const [start, end] = originalSpan(p, m.index, m.index + m[0].length);
    if (m[0].length >= 4 && m[0].length <= 8 && nearCode(text, start, end)) out.push([start, end, "code", m[0]]);
  }
  return out;
}

/**
 * Overlapping spans merged into their union, in text order, each union carrying its longest member (ties keep the
 * first given): a span dropped beside a longer one would leave its own digits in clear next to the label.
 */
export function longest<T extends { start: number; end: number }>(spans: T[]): T[] {
  const sorted = spans.map((s, i) => ({ s, i })).filter(({ s }) => s.end > s.start).sort((a, b) => a.s.start - b.s.start || a.i - b.i);
  const out: T[] = [];
  for (let k = 0; k < sorted.length; ) {
    let best = sorted[k]!;
    let end = best.s.end;
    const start = best.s.start;
    for (k++; k < sorted.length && sorted[k]!.s.start < end; k++) {
      const c = sorted[k]!;
      const [lc, lb] = [c.s.end - c.s.start, best.s.end - best.s.start];
      if (lc > lb || (lc === lb && c.i < best.i)) best = c;
      end = Math.max(end, c.s.end);
    }
    out.push({ ...best.s, start, end });
  }
  return out;
}

/**
 * Every value to mask in `text`, found on every projection, spans in `text`, overlaps kept. The
 * web zone gets the high-risk types only. The digits-only projection is not scanned here: it glues unrelated numbers
 * (a line number and a price) into false cards and codes; it serves the variant matcher of known values.
 */
export function findAll(text: string, zone: Zone): Found[] {
  const found = new Map<string, Found>();
  const projs = projections(text).filter((p) => p.kind !== "digits");
  for (const p of [...projs, ...projs.filter((p) => p.kind !== "numerals").flatMap(gaps)]) {
    const t = p.kind === "numerals" ? "" : p.text.replace(/(?![0-9])\p{Nd}/gu, (c) => (c.length === 1 ? ascii(c) : c));
    // Across gaps, only numbers a checksum vouches for: two lines' numbers glued are no code nor phone.
    const hits = p.kind === "numerals" ? spelledCodes(p, text) : p.kind === "gaps" ? checksummed(t, true) : scan(t, zone);
    for (const [s, e, type, canonical] of hits) {
      if (zone === "web" && !HIGH_RISK.has(type)) continue;
      const [start, end] = p.kind === "numerals" ? [s, e] : originalSpan(p, s, e);
      found.set(`${type}\n${start}\n${end}`, { type, start, end, canonical });
    }
  }
  return [...found.values()];
}

/** `findAll` with overlapping finds merged into their union, typed as the longest. */
export const detect = (text: string, zone: Zone): Found[] => longest(findAll(text, zone));
