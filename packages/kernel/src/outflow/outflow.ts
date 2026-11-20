import { say } from "../i18n.js";
import { findSecrets, mask, opaque, plain, variants, type SecretKind } from "./detect.js";

export interface OutflowHit {
  kind: SecretKind | "email" | "phone" | "digits" | "token";
  masked: string;
  source?: string;
}

/** Each kind as the user reads it in a pause or a refusal, in their language. */
export const outflowLabel = (locale: string, kind: OutflowHit["kind"]): string => say(locale, `kernel-outflow-kind-${kind}`);

interface Item {
  kind: OutflowHit["kind"];
  value: string;
  norm: string;
  source: string;
}

interface Win {
  /** Read items by normalised form, oldest first. */
  read: Map<string, Item>;
  /**
   * Piece → items containing it: 6-char pieces of digit items, 8-char pieces of the others, short items whole. Most
   * pieces belong to one item, stored bare: a Set per piece cost three times the memory.
   */
  shingles: Map<string, Item | Set<Item>>;
  /** Pieces in `shingles`, counted per item. */
  pieces: number;
  /** Lengths of the short items indexed whole, with their count. */
  shortLengths: Map<number, number>;
  /** Whole addresses seen in reads, normalised, oldest first: opening one is following a link, not composing. */
  urls: Set<string>;
  typedItems: Set<string>;
  /** Normalised submitted messages, newest last. */
  typedText: string;
  buffer: string;
  last?: string;
  paste: boolean;
  /** Start of an escape sequence cut at the end of the previous chunk. */
  carry: string;
}

// Memory follows the indexed pieces: measured 21.6 MB of heap for 160 000 distinct pieces (Node 22), so 140 000
// pieces stay near 19 MB per window, under the 20 MB budget.
const READ_MAX = 20_000;
const PIECES_MAX = 140_000;
// Bounds one long item's share of the index; a long secret is still caught whole by rule 1.
const ITEM_PIECES_MAX = 256;
// One read keeps new items in text order, up to a tenth of the window per kind: padding of one kind never uses
// another kind's budget, and the five kinds together fill at most half the window, so one read never flushes it.
// shortcut: padding of the same kind before an item in one read (2 000 items or 14 000 pieces) still hides it; a hard
// memory bound needs a limit somewhere, revisit if reads get split per source.
const READ_KIND_MAX = READ_MAX / 10;
const READ_KIND_PIECES_MAX = PIECES_MAX / 10;
const TYPED_ITEMS_MAX = 5000;
const TYPED_MAX = 64 * 1024;
const CARRY_MAX = 4096;
// Addresses over 500 characters are refused by the tools, so they are not kept: 5 000 stay under 5 MB.
const URLS_MAX = 5000;
const URL_LENGTH_MAX = 500;
const DIGIT_CHUNK = 6;
const TEXT_CHUNK = 8;

// Left boundary and bounded parts: without them a long run of local-part characters is matched from every position.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
const PHONE = /(?<!\d)0[1-9](?:[ .-]?\d{2}){4}(?!\d)|\+[1-9](?:[ .-]?\d){7,14}(?!\d)/g;
const DIGITS = /\d+(?:[ .-]\d+)*/g;
const TOKEN = /[A-Za-z0-9_-]{12,}/g;
// Dates are public, and pages are full of them: YYYY-MM-DD, YYYYMMDD, DD.MM.YYYY (DD/MM/YYYY never forms one run).
const [Y, M, D, S] = ["(?:19|20)\\d{2}", "(?:0[1-9]|1[0-2])", "(?:0[1-9]|[12]\\d|3[01])", "[ .-]"];
const DATE = new RegExp(`^(?:${Y}${S}?${M}${S}?${D}|${D}${S}${M}${S}${Y})$`);
// A date (or year-month) at the start of a run, as in "2024-11-19 12:30", is cut off and the rest judged alone.
const DATE_PREFIX = new RegExp(`^(?:${Y}${S}${M}(?:${S}${D})?|${D}${S}${M}${S}${Y})(?=${S}|$)`);
const GLUED_DATE = new RegExp(`^(?:${Y}${M}${D}|${D}${M}${Y})$`);

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;
/** An address as compared for « read whole »: scheme and host lowercased, percent-decoded, no trailing slash. */
function sameAddress(raw: string): string | undefined {
  try {
    const href = new URL(raw).href;
    let decoded = href;
    try {
      decoded = decodeURI(href);
    } catch {
      // A stray % stays as written.
    }
    return decoded.replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** Lowercase letters and digits only (plus `@`, which splits an e-mail): any separator can re-space a number. */
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}@]/gu, "");
/** Like `norm` but keeps `/`, to tell a match inside a path segment from one glued across segments. */
const softNorm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}@/]/gu, "");

/** Distinctive items in `text`, each normalised form once: secrets first, then the others in text order. */
function extract(raw: string): Omit<Item, "source">[] {
  const text = plain(raw);
  const others: { at: number; kind: Item["kind"]; value: string }[] = [];
  for (const m of text.matchAll(EMAIL)) others.push({ at: m.index, kind: "email", value: m[0] });
  for (const m of text.matchAll(PHONE)) others.push({ at: m.index, kind: "phone", value: m[0].replace(/\D/g, "") });
  for (const m of text.matchAll(DIGITS)) {
    let run = m[0];
    for (let date; (date = DATE_PREFIX.exec(run)); ) run = run.slice(date[0].length + 1);
    if (run.replace(/\D/g, "").length >= DIGIT_CHUNK && !DATE.test(run))
      others.push({ at: m.index, kind: "digits", value: run.replace(/\D/g, "") });
  }
  for (const m of text.matchAll(TOKEN)) {
    // Judged without its word parts: a slug with a model name in it (air-m5-announcement) is not an identifier.
    const o = opaque(m[0]);
    if (o.length >= TEXT_CHUNK && /[a-z]/i.test(o) && /\d/.test(o)) others.push({ at: m.index, kind: "token", value: m[0] });
  }
  others.sort((a, b) => a.at - b.at);
  const found = [...findSecrets(text), ...others].map(({ kind, value }) => ({ kind, value, norm: norm(value) }));
  const seen = new Set<string>();
  return found.filter((i) => i.norm && !seen.has(i.norm) && !!seen.add(i.norm));
}

const chunkSize = (norm: string) => (/^\d+$/.test(norm) ? DIGIT_CHUNK : TEXT_CHUNK);

function* pieces(norm: string, size: number) {
  for (let i = 0; i + size <= norm.length; i++) yield norm.slice(i, i + size);
}

const alternations = (piece: string) => piece.match(/\p{L}(?=\p{N})|\p{N}(?=\p{L})/gu)?.length ?? 0;

/** The pieces of a read item that may reveal it on their own, each once; a shorter item is its own piece. */
function* indexed(item: Pick<Item, "kind" | "norm">) {
  const size = chunkSize(item.norm);
  if (item.norm.length < size) {
    yield item.norm;
    return;
  }
  const at = item.norm.indexOf("@");
  // A piece made mostly of an e-mail's domain matches every address there, and the domain's own site.
  const lastStart = item.kind === "email" ? at - Math.min(4, at) : Infinity;
  let i = 0;
  const seen = new Set<string>();
  for (const p of pieces(item.norm, size)) {
    if (i++ > lastStart || seen.size >= ITEM_PIECES_MAX) break;
    // A word glued to a number (release2024) has one letter/digit switch; a random token's piece has more.
    if (item.kind === "token" && alternations(p) < 2) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    yield p;
  }
}

/**
 * What the agent read from private sources and what the user typed, per window, in memory only, so a search or an
 * address that carries private data out can be caught.
 */
export class Outflow {
  private wins = new Map<string, Win>();

  private win(id: string): Win {
    let w = this.wins.get(id);
    if (!w) {
      w = {
        read: new Map(),
        shingles: new Map(),
        pieces: 0,
        shortLengths: new Map(),
        urls: new Set(),
        typedItems: new Set(),
        typedText: "",
        buffer: "",
        paste: false,
        carry: "",
      };
      this.wins.set(id, w);
    }
    return w;
  }

  /**
   * `links`: the text shows the user's own links (history, bookmarks, tab list, a tab of theirs), so its addresses may
   * be followed. Never for a tool whose output the agent writes (run_js, a widget, a site memory): it would write an
   * address there, then open it unflagged. A list: only these addresses may be followed (the text's are not harvested).
   */
  read(win: string, text: string, source: string, links: boolean | readonly string[] = false): void {
    const w = this.win(win);
    // Punctuation of the sentence around it is not part of the address.
    const found = Array.isArray(links) ? links : links ? [...text.matchAll(URL_IN_TEXT)].map((m) => m[0].replace(/[).,;:!?»\]]+$/, "")) : [];
    for (const raw of found) {
      const url = raw.length <= URL_LENGTH_MAX + 8 ? sameAddress(raw) : undefined;
      if (!url || url.length > URL_LENGTH_MAX) continue;
      w.urls.delete(url);
      w.urls.add(url);
      if (w.urls.size > URLS_MAX) w.urls.delete(w.urls.values().next().value!);
    }
    const perKind = new Map<string, { items: number; pieces: number }>();
    for (const found of extract(text)) {
      const known = w.read.get(found.norm);
      if (known) {
        // Re-read: refresh its age and source, keep its index entries.
        w.read.delete(found.norm);
        known.source = source;
        w.read.set(found.norm, known);
        continue;
      }
      const item = { ...found, source };
      const ps = [...indexed(item)];
      const group = ["email", "phone", "digits", "token"].includes(item.kind) ? item.kind : "secret";
      const kind = perKind.get(group) ?? { items: 0, pieces: 0 };
      perKind.set(group, kind);
      if (kind.items >= READ_KIND_MAX || kind.pieces + ps.length > READ_KIND_PIECES_MAX) continue;
      kind.items++;
      kind.pieces += ps.length;
      w.pieces += ps.length;
      w.read.set(item.norm, item);
      this.countShort(w, item, 1);
      for (const p of ps) {
        const at = w.shingles.get(p);
        if (!at) w.shingles.set(p, item);
        else if (at instanceof Set) at.add(item);
        else if (at !== item) w.shingles.set(p, new Set([at, item]));
      }
      while (w.read.size > READ_MAX || w.pieces > PIECES_MAX) this.drop(w, w.read.values().next().value!);
    }
  }

  private drop(w: Win, item: Item): void {
    w.read.delete(item.norm);
    this.countShort(w, item, -1);
    for (const p of indexed(item)) {
      w.pieces--;
      const at = w.shingles.get(p);
      if (at === item) w.shingles.delete(p);
      else if (at instanceof Set && at.delete(item) && at.size === 1) w.shingles.set(p, at.values().next().value!);
    }
  }

  private countShort(w: Win, item: Item, delta: number): void {
    const n = item.norm.length;
    if (n >= chunkSize(item.norm)) return;
    const count = (w.shortLengths.get(n) ?? 0) + delta;
    if (count) w.shortLengths.set(n, count);
    else w.shortLengths.delete(n);
  }

  typed(win: string, data: string): void {
    const w = this.win(win);
    const s = w.carry + data;
    w.carry = "";
    for (let i = 0; i < s.length; ) {
      const c = s[i]!;
      if (c === "\x1b") {
        const end = escapeEnd(s, i);
        if (end === undefined) {
          // An escape never closed would otherwise grow without bound.
          w.carry = s.length - i > CARRY_MAX ? "" : s.slice(i);
          break;
        }
        const seq = s.slice(i, end);
        if (seq === "\x1b[200~") w.paste = true;
        else if (seq === "\x1b[201~") w.paste = false;
        i = end;
        continue;
      }
      i++;
      if (c === "\r" && !w.paste) this.submit(w);
      else if (c === "\r" || c === "\n") w.buffer += "\n";
      else if (c === "\x7f" || c === "\b") w.buffer = w.buffer.replace(/[\s\S]$/u, "");
      else if (c === "\x03" || c === "\x15") w.buffer = "";
      else if (c >= " " || c === "\t") w.buffer += c;
    }
    w.buffer = w.buffer.slice(-TYPED_MAX);
  }

  private submit(w: Win): void {
    const message = w.buffer.trim();
    w.buffer = "";
    if (!message) return;
    w.last = message;
    w.typedText = (w.typedText + "\n" + norm(message)).slice(-TYPED_MAX);
    for (const item of extract(message)) {
      w.typedItems.delete(item.norm);
      w.typedItems.add(item.norm);
    }
    for (const old of w.typedItems) {
      if (w.typedItems.size <= TYPED_ITEMS_MAX) break;
      w.typedItems.delete(old);
    }
  }

  lastMessage(win: string): string | undefined {
    const w = this.wins.get(win);
    // The message being typed is newer than the last one sent.
    return w?.buffer.trim() || w?.last;
  }

  /** `address`: `out` is an address the agent opens, not a search query. */
  check(win: string, out: string, address = false): OutflowHit | undefined {
    const w = this.wins.get(win);
    const typedNow = w ? w.typedText + "\n" + norm(w.buffer) : "";
    const typed = (n: string) => !!w && (w.typedItems.has(n) || typedNow.includes(n));

    for (const s of findSecrets(out)) {
      const n = norm(s.value);
      if (typed(n)) continue;
      const source = w?.read.get(n)?.source;
      return { kind: s.kind, masked: mask(s.value), ...(source ? { source } : {}) };
    }
    if (!w?.read.size) return undefined;
    // An address a private read showed whole is a link followed: it tells its site nothing the link did not already hold.
    if (address && w.urls.has(sameAddress(out) ?? "")) return undefined;

    const hit = (item: Item): OutflowHit => ({ kind: item.kind, masked: mask(item.value), source: item.source });
    // A piece the user typed is theirs to send, even if a read item contains it.
    const found = (p: string, keep: (item: Item) => boolean = () => true) => {
      const at = w.shingles.get(p);
      // The index first: scanning the typed text for every piece of a long query is quadratic.
      if (!at || typedNow.includes(p)) return undefined;
      for (const item of at instanceof Set ? at : at ? [at] : []) if (keep(item) && !typed(item.norm)) return item;
    };
    const sizes = new Set([DIGIT_CHUNK, TEXT_CHUNK, ...w.shortLengths.keys()]);
    for (const soft of new Set(variants(out).map(softNorm))) {
      for (const segment of new Set(soft.split("/")))
        for (const size of sizes)
          for (const p of pieces(segment, size)) {
            const item = found(p);
            if (item) return hit(item);
          }
      const glued = soft.replaceAll("/", "");
      if (glued === soft) continue;
      // Across segments only 8-char pieces count, and no date, or /2024/11/ would match a 202411. Accepted trade-off:
      // a digit item under 8 digits split by slashes (/482/1397) is missed, so URL paths stay quiet.
      for (const p of pieces(glued, TEXT_CHUNK)) {
        const digits = /^\d+$/.test(p);
        if (digits && GLUED_DATE.test(p)) continue;
        const item = found(p) ?? (digits ? found(p.slice(0, DIGIT_CHUNK), (i) => i.norm.includes(p)) : undefined);
        if (item) return hit(item);
      }
    }
    return undefined;
  }

  /** A new conversation in the window: what the user typed before is no longer theirs to send; what was read stays. */
  forgetTyped(win: string): void {
    const w = this.wins.get(win);
    if (!w) return;
    w.typedItems.clear();
    w.typedText = w.buffer = w.carry = "";
    delete w.last;
    w.paste = false;
  }

  forget(win: string): void {
    this.wins.delete(win);
  }
}

/** Index just past the escape sequence starting at `i`, or undefined if it is cut at the end of `s`. */
function escapeEnd(s: string, i: number): number | undefined {
  const kind = s[i + 1];
  if (kind === undefined) return undefined;
  if (kind === "[") {
    for (let j = i + 2; j < s.length; j++) {
      const code = s.charCodeAt(j);
      if (code >= 0x40 && code <= 0x7e) return j + 1;
    }
    return undefined;
  }
  // OSC, DCS, SOS, PM and APC carry a payload up to BEL or ST.
  if ("]PX^_".includes(kind)) {
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === "\x07") return j + 1;
      if (s[j] === "\x1b" && s[j + 1] === "\\") return j + 2;
    }
    return undefined;
  }
  if (kind === "O") return i + 2 < s.length ? i + 3 : undefined;
  return i + 2;
}
