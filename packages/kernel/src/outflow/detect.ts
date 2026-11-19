export type SecretKind = "api-key" | "private-key" | "jwt" | "card" | "iban" | "nir" | "random";

export interface Secret {
  kind: SecretKind;
  value: string;
}

const VARIANTS_MAX = 32;
// Separators people type inside long numbers; `+` is a space in a query string.
const SEP = "[ .+-]?";

const API_KEY =
  /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9_-]{20,})/g;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
// Card networks start with 2 to 6; a phone or order number starting otherwise is not a card.
const CARD = new RegExp(`(?<![0-9A-Za-z])[2-6](?:${SEP}\\d){11,18}(?![0-9A-Za-z])`, "g");
const IBAN = /(?<![0-9A-Za-z])[A-Z]{2}\d{2}(?:[ +]?[A-Z0-9]){11,30}(?![0-9A-Za-z])/g;
const NIR = new RegExp(
  `(?<![0-9A-Za-z])[12]${SEP}\\d{2}${SEP}\\d{2}${SEP}(?:\\d{2}|2[AB])${SEP}\\d{3}${SEP}\\d{3}${SEP}\\d{2}(?![0-9A-Za-z])`,
  "g",
);
const TOKEN = /[A-Za-z0-9_-]{24,}/g;
// Google document ids are long and random-looking but name a document, not a credential.
const GOOGLE_DOC_ID = /\b(?:docs|drive)\.google\.com\/(?:[^\s/?#]+\/)*d\/[A-Za-z0-9_-]+/g;

const compact = (s: string) => s.replace(/[ .+-]/g, "");

const mod97 = (digits: string) => [...digits].reduce((r, d) => (r * 10 + Number(d)) % 97, 0);

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]) * (i % 2 ? 2 : 1);
    sum += d > 9 ? d - 9 : d;
  }
  return sum % 10 === 0;
}

const ibanValid = (iban: string) =>
  iban.length >= 15 &&
  iban.length <= 34 &&
  mod97((iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55))) === 1;

function nirValid(nir: string): boolean {
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
      return run;
    }
  });
}

/** `text`, its URL decodings (3 at most) and, for each, its base64, base64url and hex decodings, in original case. */
function decodings(text: string): string[] {
  const forms = [text];
  for (let last = text, i = 0; i < 3; i++) {
    const next = urlDecode(last);
    if (next === last) break;
    forms.push((last = next));
  }
  const out = new Set<string>();
  for (const form of forms) {
    out.add(form);
    // Node's base64 decoder accepts both alphabets; two passes so a `/` before a base64url segment does not misalign it.
    for (const segment of [/[A-Za-z0-9+/]{16,}={0,2}/g, /[A-Za-z0-9_-]{16,}={0,2}/g])
      out.add(form.replace(segment, (s) => printable(Buffer.from(s, "base64")) ?? s));
    out.add(form.replace(/[0-9a-fA-F]{16,}/g, (s) => printable(Buffer.from(s, "hex")) ?? s));
  }
  return [...out];
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
  for (const m of text.matchAll(CARD)) if (luhnValid(compact(m[0]))) found.push({ kind: "card", value: compact(m[0]) });
  for (const m of text.matchAll(IBAN)) if (ibanValid(compact(m[0]))) found.push({ kind: "iban", value: compact(m[0]) });
  for (const m of text.matchAll(NIR)) if (nirValid(compact(m[0]))) found.push({ kind: "nir", value: compact(m[0]) });
  return found;
}

function random(text: string): string[] {
  return [...text.replace(GOOGLE_DOC_ID, " ").matchAll(TOKEN)]
    .map((m) => m[0])
    .filter((t) => /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && entropy(t) >= 4.0)
    // A token that decodes to text is encoding, judged by its decoded variant.
    .filter((t) => printable(Buffer.from(t, "base64")) === undefined);
}

/** Secrets in `text` or in any of its decodings, each kind + value once. */
export function findSecrets(text: string): Secret[] {
  const all = decodings(text);
  const found = all.flatMap(specific);
  for (const token of all.flatMap(random))
    if (!found.some((s) => s.value.includes(token))) found.push({ kind: "random", value: token });
  const seen = new Set<string>();
  return found.filter((s) => !seen.has(`${s.kind}\n${s.value}`) && !!seen.add(`${s.kind}\n${s.value}`));
}

export function mask(value: string): string {
  return value.length < 10 ? `${value.slice(0, 2)}••••` : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
