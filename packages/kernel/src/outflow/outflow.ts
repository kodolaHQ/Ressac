import { findSecrets, mask, variants, type SecretKind } from "./detect.js";

export interface OutflowHit {
  kind: SecretKind | "email" | "phone" | "digits" | "token";
  masked: string;
  source?: string;
}

interface Item {
  kind: OutflowHit["kind"];
  value: string;
  norm: string;
  source: string;
}

interface Win {
  /** Read items by normalised form, oldest first. */
  read: Map<string, Item>;
  /** Shingle → items containing it: 6-char pieces of digit items, 8-char pieces of the others. */
  shingles: Map<string, Set<Item>>;
  /** Read items shorter than their shingle, matched whole. */
  short: Set<Item>;
  typedItems: Set<string>;
  /** Normalised submitted messages, newest last. */
  typedText: string;
  buffer: string;
  last?: string;
  paste: boolean;
  /** Start of an escape sequence cut at the end of the previous chunk. */
  carry: string;
}

const READ_MAX = 5000;
const TYPED_MAX = 64 * 1024;
const CARRY_MAX = 4096;
const DIGIT_CHUNK = 6;
const TEXT_CHUNK = 8;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?<!\d)0[1-9](?:[ .-]?\d{2}){4}(?!\d)|\+[1-9](?:[ .-]?\d){7,14}(?!\d)/g;
const DIGITS = /\d+(?:[ .-]\d+)*/g;
const TOKEN = /[A-Za-z0-9_-]{12,}/g;

/** Lowercase without the separators people re-space numbers with. */
const norm = (s: string) => s.toLowerCase().replace(/[ .+-]/g, "");

/** Distinctive items in `text`, each normalised form once, secrets first. */
function extract(text: string): Omit<Item, "source">[] {
  const found: Omit<Item, "source">[] = findSecrets(text).map((s) => ({ ...s, norm: norm(s.value) }));
  const add = (kind: Item["kind"], value: string) => found.push({ kind, value, norm: norm(value) });
  for (const [m] of text.matchAll(EMAIL)) add("email", m);
  for (const [m] of text.matchAll(PHONE)) add("phone", m.replace(/\D/g, ""));
  for (const [m] of text.matchAll(DIGITS)) if (m.replace(/\D/g, "").length >= DIGIT_CHUNK) add("digits", m.replace(/\D/g, ""));
  for (const [m] of text.matchAll(TOKEN)) if (/[a-z]/i.test(m) && /\d/.test(m)) add("token", m);
  const seen = new Set<string>();
  return found.filter((i) => i.norm && !seen.has(i.norm) && !!seen.add(i.norm));
}

const chunkSize = (norm: string) => (/^\d+$/.test(norm) ? DIGIT_CHUNK : TEXT_CHUNK);

function* pieces(norm: string, size: number) {
  for (let i = 0; i + size <= norm.length; i++) yield norm.slice(i, i + size);
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
        short: new Set(),
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

  read(win: string, text: string, source: string): void {
    const w = this.win(win);
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
      w.read.set(item.norm, item);
      const size = chunkSize(item.norm);
      if (item.norm.length < size) w.short.add(item);
      for (const p of pieces(item.norm, size)) {
        const set = w.shingles.get(p);
        if (set) set.add(item);
        else w.shingles.set(p, new Set([item]));
      }
      if (w.read.size > READ_MAX) this.drop(w, w.read.values().next().value!);
    }
  }

  private drop(w: Win, item: Item): void {
    w.read.delete(item.norm);
    w.short.delete(item);
    for (const p of pieces(item.norm, chunkSize(item.norm))) {
      const set = w.shingles.get(p);
      set?.delete(item);
      if (set?.size === 0) w.shingles.delete(p);
    }
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
      if (w.typedItems.size <= READ_MAX) break;
      w.typedItems.delete(old);
    }
  }

  lastMessage(win: string): string | undefined {
    const w = this.wins.get(win);
    // The message being typed is newer than the last one sent.
    return w?.buffer.trim() || w?.last;
  }

  check(win: string, out: string): OutflowHit | undefined {
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

    const hit = (item: Item): OutflowHit => ({ kind: item.kind, masked: mask(item.value), source: item.source });
    for (const v of new Set(variants(out).map(norm))) {
      for (const item of w.short) if (v.includes(item.norm) && !typed(item.norm)) return hit(item);
      for (const size of [DIGIT_CHUNK, TEXT_CHUNK])
        for (const p of pieces(v, size)) {
          const items = w.shingles.get(p);
          // A piece the user typed is theirs to send, even if a read item contains it.
          if (!items || typedNow.includes(p)) continue;
          for (const item of items) if (!typed(item.norm)) return hit(item);
        }
    }
    return undefined;
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
  if (kind === "]") {
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === "\x07") return j + 1;
      if (s[j] === "\x1b" && s[j + 1] === "\\") return j + 2;
    }
    return undefined;
  }
  if (kind === "O") return i + 2 < s.length ? i + 3 : undefined;
  return i + 2;
}
