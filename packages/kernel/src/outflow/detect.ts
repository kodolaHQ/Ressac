export type SecretKind = "api-key" | "private-key" | "jwt" | "card" | "iban" | "nir" | "random";

export interface Secret {
  kind: SecretKind;
  value: string;
}

const VARIANTS_MAX = 32;
// Each decoding yields two variants (lowercased, without separators).
const DECODINGS_MAX = VARIANTS_MAX / 2;
// Separators people type inside long numbers, French pages' `/` `_` `,` included; `+` is a space in a query string.
const SEPS = "[ .+/_,-]";
const SEP = `${SEPS}?`;

export const API_KEY =
  /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-][A-Za-z0-9_.-]{18,}[A-Za-z0-9_-]|shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}|do[opr]_v1_[a-f0-9]{64})/g;
// Header only: looking for the matching END made many headers without one quadratic.
export const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
export const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
// Digit groups joined by one separator each, e.g. "4970 1012 3456 7893 03".
const DIGIT_CHAIN = new RegExp(`\\d+(?:${SEPS}\\d+)*`, "g");
// Groupings cards are printed in; a single contiguous group is also accepted.
const CARD_SHAPES = ["4,6,4", "4,6,5", "4,4,4,4", "4,4,4,4,3"];
// No trailing boundary: a BIC, city or year often follows, so the country's length cuts the candidate.
export const IBAN = new RegExp(`(?<![0-9A-Za-z])[A-Z]{2}\\d{2}(?:${SEP}[A-Z0-9]){11,30}`, "gi");
// IBAN length per country, built from a string so country codes are not identifiers.
export const IBAN_LENGTHS = new Map(
  (
    "AD24 AT20 BE16 BG22 CH21 CY28 CZ24 DE22 DK18 EE20 ES24 FI18 FR27 GB22 GI23 GR27 HR21 HU28 IE22 IS26 IT27 LI21 " +
    "LT20 LU20 LV21 MC27 MT31 NL18 NO15 PL28 PT25 RO24 SE24 SI19 SK24 SM27 VA22"
  )
    .split(" ")
    .map((e) => [e.slice(0, 2), Number(e.slice(2))] as const),
);
export const NIR = new RegExp(
  `(?<![0-9A-Za-z])[12]${SEP}\\d{2}${SEP}\\d{2}${SEP}(?:\\d{2}|2[AB])${SEP}\\d{3}${SEP}\\d{3}${SEP}\\d{2}(?![0-9A-Za-z])`,
  "gi",
);
const TOKEN = /[A-Za-z0-9_-]{24,}/g;
// Google document ids are long and random-looking but name a document, not a credential.
// Path depth bounded: an unbounded `(?:…\/)*` is quadratic on a long run of host names.
const GOOGLE_DOC_ID = /\b(?:docs|drive)\.google\.com\/(?:[^\s/?#]+\/){0,4}d\/[A-Za-z0-9_-]+/g;

const compact = (s: string) => s.replace(new RegExp(SEPS, "g"), "");
/** Compatibility forms folded (full-width digits, no-break spaces) and runs of spaces made one, so a number reads one way. */
export const plain = (s: string) => s.normalize("NFKC").replace(/[^\S\r\n]+/g, " ");

const mod97 = (digits: string) => [...digits].reduce((r, d) => (r * 10 + Number(d)) % 97, 0);

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]) * (i % 2 ? 2 : 1);
    sum += d > 9 ? d - 9 : d;
  }
  return sum % 10 === 0;
}

/** Issuer prefix with the lengths it issues. Visa's 13-digit cards are no longer issued and match too many ids. */
function issued(d: string): boolean {
  const [p2, p4] = [Number(d.slice(0, 2)), Number(d.slice(0, 4))];
  if (d[0] === "4") return d.length === 16 || d.length === 19;
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return d.length === 16;
  if (p2 === 34 || p2 === 37) return d.length === 15;
  if (p4 === 6011 || p2 === 65) return d.length >= 16 && d.length <= 19;
  return false;
}

/** Where a value is written in a text ([start, end)) and its canonical form. */
export type Span = [start: number, end: number, value: string];

/** Card numbers: at each digit group, the first issued, Luhn-valid window printed in a card grouping. */
export function cardSpans(t: string): Span[] {
  const out: Span[] = [];
  for (const chain of t.matchAll(DIGIT_CHAIN)) {
    const groups = [...chain[0].matchAll(/\d+/g)];
    for (let i = 0; i < groups.length; ) {
      let taken = 0;
      for (let n = 1; n <= 5 && i + n <= groups.length && !taken; n++) {
        const w = groups.slice(i, i + n);
        const seps = new Set(w.slice(1).map((g, k) => chain[0].slice(w[k]!.index + w[k]![0].length, g.index)));
        const shaped = n === 1 || (CARD_SHAPES.includes(w.map((g) => g[0].length).join()) && seps.size === 1);
        const d = w.map((g) => g[0]).join("");
        if (shaped && issued(d) && luhnValid(d)) {
          const last = w[n - 1]!;
          out.push([chain.index + w[0]!.index, chain.index + last.index + last[0].length, d]);
          taken = n;
        }
      }
      i += taken || 1;
    }
  }
  return out;
}

/** IBANs, cut at their country's length (a BIC or a city often follows); the scan goes on after each one found. */
export function ibanSpans(t: string): Span[] {
  const out: Span[] = [];
  const re = new RegExp(IBAN);
  for (let m; (m = re.exec(t)); ) {
    const len = IBAN_LENGTHS.get(m[0].slice(0, 2).toUpperCase()) ?? 0;
    let k = 0;
    for (let n = 0; k < m[0].length && n < len; k++) if (/[0-9A-Za-z]/.test(m[0][k]!)) n++;
    const v = m[0].slice(0, k).replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    if (len && v.length === len && ibanValid(v)) {
      out.push([m.index, m.index + k, v]);
      re.lastIndex = m.index + k;
    } else re.lastIndex = m.index + 1;
  }
  return out;
}

export const ibanValid = (iban: string) =>
  iban.length >= 15 &&
  iban.length <= 34 &&
  mod97((iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))) === 1;

export function nirValid(nir: string): boolean {
  const body = nir.slice(0, 13).replace("2A", "19").replace("2B", "18");
  return 97 - mod97(body) === Number(nir.slice(13));
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}

/** The bytes as text when at least 90 % of them are printable ASCII, else undefined. */
function printable(bytes: Buffer): string | undefined {
  if (bytes.length === 0) return undefined;
  let ok = 0;
  for (const b of bytes) if ((b >= 0x20 && b < 0x7f) || b === 9 || b === 10 || b === 13) ok++;
  return ok / bytes.length >= 0.9 ? bytes.toString("utf8") : undefined;
}

function urlDecode(s: string): string {
  return s.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      // One invalid byte must not keep the whole run encoded: valid sequences decode, each invalid byte becomes U+FFFD.
      return UTF8.decode(Uint8Array.from(run.slice(1).split("%"), (h) => parseInt(h, 16)));
    }
  });
}
const UTF8 = new TextDecoder();

/** `s` percent-decoded until it stops changing, at most 3 times like `decodings`. */
export function urlDecoded(s: string): string {
  for (let i = 0, d; i < 3 && (d = urlDecode(s)) !== s; i++) s = d;
  return s;
}

const decodePasses = [
  // Node's base64 decoder accepts both alphabets; two passes so a `/` before a base64url segment does not misalign it.
  (form: string) => form.replace(/[A-Za-z0-9+/]{16,}={0,2}/g, (s) => printable(Buffer.from(s, "base64")) ?? s),
  (form: string) => form.replace(/[A-Za-z0-9_-]{16,}={0,2}/g, (s) => printable(Buffer.from(s, "base64")) ?? s),
  (form: string) => form.replace(/[0-9a-fA-F]{16,}/g, (s) => printable(Buffer.from(s, "hex")) ?? s),
];

/**
 * `text` and its decodings in original case, breadth first: up to 3 URL decodings and 2 rounds of base64/hex, in any
 * order (base64 of a URL-encoded text, hex of base64…), 16 at most.
 */
function decodings(text: string): string[] {
  const out = [text];
  const queue = [{ form: text, url: 0, rounds: 0 }];
  for (let node; (node = queue.shift()) && out.length < DECODINGS_MAX; ) {
    const next = node.url < 3 ? [{ form: urlDecode(node.form), url: node.url + 1, rounds: node.rounds }] : [];
    if (node.rounds < 2)
      for (const pass of decodePasses) next.push({ form: pass(node.form), url: node.url, rounds: node.rounds + 1 });
    for (const child of next)
      if (out.length < DECODINGS_MAX && !out.includes(child.form)) {
        out.push(child.form);
        queue.push(child);
      }
  }
  return out;
}

/** Every decoding of `text` lowercased, plus each without the separators ` .-`, at most 32. */
export function variants(text: string): string[] {
  const out = new Set<string>();
  for (const d of decodings(text)) out.add(d.toLowerCase()).add(d.replace(/[ .-]/g, "").toLowerCase());
  return [...out].slice(0, VARIANTS_MAX);
}

function specific(text: string): Secret[] {
  const found: Secret[] = [];
  for (const m of text.matchAll(API_KEY)) found.push({ kind: "api-key", value: m[0] });
  for (const m of text.matchAll(PRIVATE_KEY)) found.push({ kind: "private-key", value: m[0] });
  for (const m of text.matchAll(JWT)) found.push({ kind: "jwt", value: m[0] });
  for (const [, , value] of cardSpans(text)) found.push({ kind: "card", value });
  for (const [, , value] of ibanSpans(text)) found.push({ kind: "iban", value });
  for (const m of text.matchAll(NIR)) {
    const nir = compact(m[0]).toUpperCase();
    if (nirValid(nir)) found.push({ kind: "nir", value: nir });
  }
  return found;
}

// A part between `-` or `_` that reads as a word (Lisbon, des, SIM): a slug is made of them, a random string is not.
// Capitals up to 5 (SIM, HTML): a longer all-caps run is a code more often than an acronym.
const WORD = /^(?:[A-Za-z][a-z]+|[A-Z]{2,5})$/;
/**
 * `token` without its word parts. What is left of a readable slug (Samsung-Galaxy-S25-256-Go) is too short to be a
 * secret or an identifier; a secret padded with words is left whole, and a token without a word part is unchanged.
 */
export function opaque(token: string): string {
  const parts = token.split(/[-_]/);
  const kept = parts.filter((p) => !WORD.test(p));
  return kept.length === parts.length ? token : kept.join("-");
}

export function randomTokens(text: string): string[] {
  return [...text.replace(GOOGLE_DOC_ID, " ").matchAll(TOKEN)]
    .map((m) => m[0])
    .filter((t) => {
      const o = opaque(t);
      return o.length >= 24 && /[a-z]/.test(o) && /[A-Z]/.test(o) && /\d/.test(o) && entropy(o) >= 4.0;
    })
    // A token that decodes to text is encoding, judged by its decoded variant.
    .filter((t) => printable(Buffer.from(t, "base64")) === undefined);
}

/** Secrets in `text` or in any of its decodings, each kind + value once. */
export function findSecrets(text: string): Secret[] {
  const all = [...new Set(decodings(text).map(plain))];
  const found = all.flatMap(specific);
  for (const token of all.flatMap(randomTokens))
    if (!found.some((s) => s.value.includes(token))) found.push({ kind: "random", value: token });
  const seen = new Set<string>();
  return found.filter((s) => !seen.has(`${s.kind}\n${s.value}`) && !!seen.add(`${s.kind}\n${s.value}`));
}

/** At most half of `value` shown: a quarter at each end, at most 4 characters each. */
export function mask(value: string): string {
  const n = Math.min(4, Math.floor(value.length / 4));
  return n ? `${value.slice(0, n)}••••${value.slice(-n)}` : "••••";
}
