import { ascii } from "../outflow/spelled.js";
import { numerals } from "./numerals.js";

export type Projection = { kind: "nfkc" | "percent" | "escapes" | "digits" | "numerals" | "folded"; text: string; start: Int32Array; end: Int32Array };

/** Collects projected text with the original span of each UTF-16 unit. */
class Builder {
  text = "";
  private s: number[] = [];
  private e: number[] = [];
  push(str: string, start: number, end: number) {
    this.text += str;
    for (let i = 0; i < str.length; i++) (this.s.push(start), this.e.push(end));
  }
  done(kind: Projection["kind"]): Projection {
    return { kind, text: this.text, start: Int32Array.from(this.s), end: Int32Array.from(this.e) };
  }
}

const ESCAPES = /(?:%[0-9A-Fa-f]{2})+/g;
const UTF8 = new TextDecoder();
const ENCODER = new TextEncoder();
const DECODE_PASSES = 3;

const identity = (text: string): Projection => {
  const n = text.length;
  return { kind: "nfkc", text, start: Int32Array.from({ length: n }, (_, i) => i), end: Int32Array.from({ length: n }, (_, i) => i + 1) };
};

/** Bytes consumed by one U+FFFD of the decoder: the lead byte and the continuation bytes that follow it, or 3 for a real U+FFFD. */
function invalidLength(bytes: Uint8Array, pos: number): number {
  if (bytes[pos] === 0xef && bytes[pos + 1] === 0xbf && bytes[pos + 2] === 0xbd) return 3;
  const lead = bytes[pos]!;
  const want = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead < 0xf0 ? 3 : lead >= 0xc2 && lead < 0xe0 ? 2 : 1;
  let n = 1;
  while (n < want && (bytes[pos + n]! & 0xc0) === 0x80) n++;
  return n;
}

/** `src` normalized to NFKC per code point; spans compose through `src`. */
function nfkc(src: Projection): Projection {
  const b = new Builder();
  let i = 0;
  for (const ch of src.text) {
    b.push(ch.normalize("NFKC"), src.start[i]!, src.end[i + ch.length - 1]!);
    i += ch.length;
  }
  return b.done("nfkc");
}

/** `src` with its escapes decoded once. */
function percentPass(src: Projection): Projection {
  const b = new Builder();
  const text = src.text;
  let at = 0;
  const plain = (to: number) => {
    for (const ch of text.slice(at, to)) {
      b.push(ch, src.start[at]!, src.end[at + ch.length - 1]!);
      at += ch.length;
    }
  };
  for (const m of text.matchAll(ESCAPES)) {
    plain(m.index);
    const bytes = Uint8Array.from(m[0].matchAll(/%(..)/g), (x) => parseInt(x[1]!, 16));
    let pos = 0;
    for (const ch of UTF8.decode(bytes)) {
      const n = ch === "\ufffd" ? invalidLength(bytes, pos) : ENCODER.encode(ch).length;
      b.push(ch, src.start[at + pos * 3]!, src.end[at + (pos + n) * 3 - 1]!);
      pos += n;
    }
    at += m[0].length;
  }
  plain(text.length);
  return b.done("percent");
}

/** `src` percent-decoded until it stops changing, at most 3 times like `urlDecoded`, then normalized. */
function percent(text: string): Projection {
  let p = identity(text);
  for (let i = 0, d; i < DECODE_PASSES && (d = percentPass(p)).text !== p.text; i++) p = d;
  return { ...nfkc(p), kind: "percent" };
}

// JSON `\uXXXX` and `\/`, numeric HTML references. Named entities (`&eacute;`) are left out: textContent already decodes
// them, and raw HTML only reaches the agent through the dev tools, refused on a carrier tab.
const CODE_ESCAPES = /\\u([0-9A-Fa-f]{4})|\\\/|&#(?:([0-9]+)|[xX]([0-9A-Fa-f]+));/g;
const MAX_CODE_POINT = 0x10ffff;
const codePointOf = (m: RegExpMatchArray) => (m[1] ? parseInt(m[1], 16) : m[2] ? parseInt(m[2], 10) : m[3] ? parseInt(m[3], 16) : 0x2f);

/**
 * Whether `text` holds an escape the decoder changes: any `\uXXXX` or numeric reference up to U+10FFFF, and `\/` only
 * beside a digit (« 14\/03\/1990 »). A page whose only escapes are URL slashes (`https:\/\/`) pays no projection.
 */
function worthEscapes(text: string): boolean {
  if (!text.includes("\\") && !text.includes("&#")) return false;
  for (const m of text.matchAll(CODE_ESCAPES)) {
    if (m[0] !== "\\/") {
      if (codePointOf(m) <= MAX_CODE_POINT) return true;
    } else if (/\p{Nd}/u.test(text[m.index - 1] ?? "") || /\p{Nd}/u.test(text[m.index + 2] ?? "")) return true;
  }
  return false;
}

/** `src` with its JSON and numeric HTML escapes decoded once; each decoded unit spans its whole escape. */
function escapesPass(src: Projection): Projection {
  const b = new Builder();
  let at = 0;
  const plain = (to: number) => {
    for (; at < to; at++) b.push(src.text[at]!, src.start[at]!, src.end[at]!);
  };
  for (const m of src.text.matchAll(CODE_ESCAPES)) {
    const cp = codePointOf(m);
    if (cp > MAX_CODE_POINT) continue;
    plain(m.index);
    // A `\u` is one UTF-16 unit: a surrogate pair's halves each keep their own escape, and nfkc joins their spans.
    b.push(m[1] ? String.fromCharCode(cp) : String.fromCodePoint(cp), src.start[at]!, src.end[at + m[0].length - 1]!);
    at += m[0].length;
  }
  plain(src.text.length);
  return b.done("escapes");
}

/** `text` with its JSON and numeric HTML escapes decoded until it stops changing, at most 3 times, then normalized. */
function escapes(text: string): Projection {
  let p = identity(text);
  for (let i = 0, d; i < DECODE_PASSES && (d = escapesPass(p)).text !== p.text; i++) p = d;
  return { ...nfkc(p), kind: "escapes" };
}

/** The digits of `src` (already NFKC), digits of any script read as ASCII. */
function digits(src: Projection): Projection {
  const b = new Builder();
  let i = 0;
  for (const ch of src.text) {
    if (/\p{Nd}/u.test(ch)) b.push(ascii(ch), src.start[i]!, src.end[i + ch.length - 1]!);
    i += ch.length;
  }
  return b.done("digits");
}

/** The numeral runs of `src.text` as a projection, spans mapped back through `src`. */
function numeralsProjection(src: Projection): Projection | undefined {
  const runs = numerals(src.text).map((r) => ({ digits: r.digits, span: originalSpan(src, r.start, r.end) }));
  if (!runs.length) return undefined;
  const b = new Builder();
  runs.forEach((r, i) => {
    if (i) b.push(" ", runs[i - 1]!.span[1], r.span[0]);
    b.push(r.digits, ...r.span);
  });
  return b.done("numerals");
}

/** Text projections the detectors scan: always nfkc and digits; percent, escapes and numerals when they apply. */
export function projections(text: string): Projection[] {
  const n = nfkc(identity(text));
  const out = [n, digits(n)];
  const srcs = [identity(text)];
  if (/%[0-9A-Fa-f]{2}/.test(text)) {
    const p = percent(text);
    out.push(p, digits(p));
    srcs.push(p);
  }
  if (worthEscapes(text)) {
    const p = escapes(text);
    out.push(p, digits(p));
    srcs.push(p);
  }
  for (const src of srcs) {
    const np = numeralsProjection(src);
    if (np) out.push(np);
  }
  return out;
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;
// One code point of an NFKC text, folded (design § 6.2 steps 2-4): ignorables dropped, marks dropped, lower case, ligatures spelled out.
// Known limit: an ignorable used as the only word separator (« Camille\u200bAubrac ») joins the two words, so no form matches.
const foldSlow = (ch: string) =>
  IGNORABLE.test(ch) ? "" : ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/œ/g, "oe").replace(/æ/g, "ae").replace(/ß/g, "ss");
// Memoized: a page repeats few distinct characters, and the folded projection runs on every sources read (design § 6.7).
const FOLDED_CHARS = new Map<string, string>();
const MAX_FOLDED_CHARS = 4096;
const foldChar = (ch: string) => {
  let f = FOLDED_CHARS.get(ch);
  if (f === undefined) {
    f = foldSlow(ch);
    if (FOLDED_CHARS.size < MAX_FOLDED_CHARS) FOLDED_CHARS.set(ch, f);
  }
  return f;
};

/** `src` (already NFKC) folded: each run of chars that are neither letter nor digit becomes one space, none at the ends. */
function foldedOf(src: Projection): Projection {
  const b = new Builder();
  let i = 0;
  let gap: [number, number] | null = null;
  for (const ch of src.text) {
    const [s, e] = [src.start[i]!, src.end[i + ch.length - 1]!];
    i += ch.length;
    for (const c of foldChar(ch)) {
      if (!WORD_CHAR.test(c)) gap = gap ? [gap[0], e] : [s, e];
      else {
        if (gap && b.text) b.push(" ", ...gap);
        gap = null;
        b.push(c, s, e);
      }
    }
  }
  return b.done("folded");
}

/** `s` folded for the passport (design § 6.2): the same folding as `foldedProjections`, so a form and a text compare. */
export function foldWords(s: string): string {
  return foldedOf(nfkc(identity(s))).text;
}

/**
 * The folded projections the passport is searched in (sources zone only): of nfkc, and of percent and escapes when present.
 * `built`: `projections(text)`, when the caller has it, so nfkc and percent are not built twice.
 */
export function foldedProjections(text: string, built?: Projection[]): Projection[] {
  const srcs = built?.filter((p) => p.kind === "nfkc" || p.kind === "percent" || p.kind === "escapes") ?? [
    nfkc(identity(text)),
    ...(/%[0-9A-Fa-f]{2}/.test(text) ? [percent(text)] : []),
    ...(worthEscapes(text) ? [escapes(text)] : []),
  ];
  return srcs.map(foldedOf);
}

/** The span in the original string of projected chars `[from, to)`. */
export function originalSpan(p: Projection, from: number, to: number): [number, number] {
  return [p.start[from]!, p.end[to - 1]!];
}
