import { say } from "../i18n.js";
import { digitWord, rewrite, spelled } from "./spelled.js";
import { findSecrets, mask, opaque, plain, urlDecoded, variants, type SecretKind } from "./detect.js";

export interface OutflowHit {
  kind: SecretKind | "email" | "phone" | "digits" | "token" | "series" | "clicks" | "name";
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
  /** Where it was read: `<tab>\n<origin>` per read (empty parts when unknown), so a check can leave out a tab's own reads. */
  from: Set<string>;
  group: Group;
  /** Its pieces in `shingles`. */
  size: number;
}

type Group = "digits" | "token" | "phone" | "email" | "secret";
// Lowest value first: digits and tokens fill ordinary pages, secrets are rare and worth the most. A group's weight
// divides its share when the window picks what to evict.
const GROUPS: readonly Group[] = ["digits", "token", "phone", "email", "secret"];
const WEIGHT: Record<Group, number> = { digits: 1, token: 1, phone: 2, email: 2, secret: 4 };
const groupOf = (kind: Item["kind"]): Group => (GROUPS.includes(kind as Group) ? (kind as Group) : "secret");
/** Items of one group, oldest first, with their pieces. */
type Slot = { items: Set<Item>; pieces: number };
const slotOf = (m: Map<Group, Slot>, g: Group): Slot => m.get(g) ?? m.set(g, { items: new Set(), pieces: 0 }).get(g)!;

/** A tab and its origin: a check for a script on that tab leaves out what was read there (`check`'s `except`). */
export type ReadPlace = { tab?: string; origin?: string | null };
const placeKey = (p: ReadPlace = {}) => `${p.tab ?? ""}\n${p.origin ?? ""}`;
// Bounds an item's places: past it, an item counts as read on an unknown place, so as read elsewhere for every tab.
const PLACES_MAX = 8;

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
  /** The read items per group, for eviction by value. */
  groups: Map<Group, Slot>;
  /** Lengths of the short items indexed whole, with their count. */
  shortLengths: Map<number, number>;
  /** Whole addresses seen in reads, normalised, oldest first: opening one is following a link, not composing. */
  urls: Set<string>;
  typedItems: Set<string>;
  /** Normalised submitted messages, newest last. */
  typedText: string;
  /** Submitted messages as words (lowercased, single spaces), newest last: a series part is exempt only as whole words. */
  typedWords: string;
  buffer: string;
  paste: boolean;
  /** Start of an escape sequence cut at the end of the previous chunk. */
  carry: string;
  /** A private read happened (even one with no item): searches from then on are kept to judge them as a series. */
  privateRead: boolean;
  /** Searches that went to the engine, lowercased with spaces collapsed, oldest first. */
  sent: string[];
  /** Per site (`clickSite`), the one-character pieces of the links followed there since the private read (`clickPiece`),
   *  oldest first; sites in order of last use. */
  clicks: Map<string, string[]>;
  /** Addresses of the links shown to the agent with their piece (`""`: a label that is none), newest last: a link opened
   *  by its address (`open_tab`, `navigate {url}`, `read_pages`) keeps the label it was shown with. */
  labels: Map<string, string>;
}

// Memory follows the indexed pieces: measured 6.6 MB of heap for 45 000 distinct pieces (Node 22, 32-character
// tokens), 8.8 MB per window with the addresses and labels full; kept across conversations, so sized for 8 GB Macs.
const READ_MAX = 6000;
const PIECES_MAX = 45_000;
// Bounds one long item's share of the index; a long secret is still caught whole by rule 1.
const ITEM_PIECES_MAX = 256;
// One read keeps its last items: per kind 2 000 items or 14 000 pieces, half the window in all, its lowest kind dropped
// first. Padding before an item never hides it, padding after it needs that much of its own kind, and one read never
// flushes more than half the window. Past the window, the oldest item goes from the group with the largest weighted
// share: ordinary pages (numbers, ids) push out their own kind, not a secret, e-mail or phone read earlier.
// shortcut: an item still goes after a window's share of later items of its own kind; a longer memory needs more heap.
const READ_KIND_MAX = 2000;
const READ_KIND_PIECES_MAX = 14_000;
const TYPED_ITEMS_MAX = 5000;
const TYPED_MAX = 64 * 1024;
const CARRY_MAX = 4096;
// Addresses over 500 characters are refused by the tools, so they are not kept: 2 000 measured at 1.2 MB.
const URLS_MAX = 2000;
const URL_LENGTH_MAX = 500;
// A series long enough to spell a code takes a few searches; the oldest of 20 is far past any split value, and
// comparing a query with 20 kept ones stays linear in its length.
const SERIES_MAX = 20;
// Sites whose followed pieces are kept, the least recently used dropped: a grid's site is the one the agent keeps going to.
const CLICK_SITES_MAX = 8;
// How many of a site's last pieces the pager shape judges: a 6-character code fits, and an old step stops carding.
const PAGER_SPAN = 8;
// Labels of the links shown, by address: 40 per read, so the last 50 reads; under 1 MB with addresses up to 500 characters.
const LABELS_MAX = 2000;
// A query is kept up to 500 characters: longer is prose, not a frame around a code.
const SENT_LENGTH_MAX = 500;
const DIGIT_CHUNK = 6;
const TEXT_CHUNK = 8;

// Left boundary and bounded parts: without them a long run of local-part characters is matched from every position.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
const PHONE = /(?<!\d)0[1-9](?:[ .-]?\d{2}){4}(?!\d)|\+[1-9](?:[ .-]?\d){7,14}(?!\d)/g;
const DIGITS = /\d+(?:[ .-]\d+)*/g;
const TOKEN = /[A-Za-z0-9_-]{12,}/g;
const SHORT_ID = /(?<![A-Za-z0-9])[A-Za-z0-9]{5,11}(?![A-Za-z0-9])/g;
// Public short words: quantities (256GB, 4x), times and durations (14h30, 1h45min), dimensions and packs (160x90cm,
// 6x33cl), year+quarter, model names (RTX4090, GTX1080Ti, A320neo, 737MAX, 7800X3D,
// 13900KF). Plain "b" is left out so 4827B stays an item.
const PUBLIC_SHORT = new RegExp(
  "^(?:\\d+(?:kb|mb|gb|tb|ko|mo|go|to|mg|g|kg|ml|cl|l|mm|cm|m|km|hz|khz|mhz|ghz|mah|wh|kwh|w|kw|v|ms|s|h|min|px|dpi|fps|mp|p|k|x|kcal|rpm)" +
    "|\\d{1,2}h\\d{2}(?:min)?|\\d+h\\d+min|(?:\\d+x)+\\d+(?:kb|mb|gb|tb|ko|mo|go|to|mg|g|kg|ml|cl|l|mm|cm|m|km|px)?" +
    "|(?:19|20)\\d\\d(?:Q[1-4]|H[12])|[a-z]{2,}\\d{1,4}(?:[a-z]{1,2})?|[a-z]?\\d+[a-z]{3,}|\\d{4}x3d|\\d{4,5}(?:kf|ks|hx))$",
  "i",
);
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
function extract(raw: string): Omit<Item, "source" | "from" | "group" | "size">[] {
  const text = plain(raw);
  const others: { at: number; kind: Item["kind"]; value: string }[] = [];
  for (const m of text.matchAll(EMAIL)) others.push({ at: m.index, kind: "email", value: m[0] });
  for (const m of text.matchAll(PHONE)) others.push({ at: m.index, kind: "phone", value: m[0].replace(/\D/g, "") });
  for (const m of text.matchAll(DIGITS)) {
    // A run glued to letters on both sides that starts with one digit (i9-13900KF) or is spaced is a model name: the
    // short-ID rule judges its parts. AB12-3456CD keeps its digits item.
    if (/^\d[ .-]|\d \d/.test(m[0]) && /\p{L}/u.test(text[m.index - 1] ?? "") && /\p{L}/u.test(text[m.index + m[0].length] ?? "")) continue;
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
  for (const m of text.matchAll(SHORT_ID)) {
    // B3: BX2291KQ7 and 4827B are identifiers; letters-then-digits (RTX4090, iPhone15) are public model names.
    const w = m[0];
    if ((w.match(/\d/g)?.length ?? 0) >= 3 && /[a-z]/i.test(w) && !PUBLIC_SHORT.test(w))
      others.push({ at: m.index, kind: "token", value: w });
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
    // A word glued to a number (release2024) has one letter/digit switch; a random token's piece has more. A short ID
    // whole (INV20391) was already judged by PUBLIC_SHORT, so it is kept; its pieces (cmd20240, 20240315) are not.
    if (item.kind === "token" && p !== item.norm && alternations(p) < 2) continue;
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
        groups: new Map(),
        shortLengths: new Map(),
        urls: new Set(),
        typedItems: new Set(),
        typedText: "",
        typedWords: "",
        buffer: "",
        paste: false,
        carry: "",
        privateRead: false,
        sent: [],
        clicks: new Map(),
        labels: new Map(),
      };
      this.wins.set(id, w);
    }
    return w;
  }

  /**
   * `links`: the text shows the user's own links (history, bookmarks, tab list, a tab of theirs), so its addresses may
   * be followed. Never for a tool whose output the agent writes (run_js, a widget, a site memory): it would write an
   * address there, then open it unflagged. A list: only these addresses may be followed (the text's are not harvested).
   * `shown`: the text as the agent got it, where the items are taken (a value it saw only as a label is no item: a
   * pause on a guess of it would confirm the guess); `text` still gives the addresses.
   */
  read(win: string, text: string, source: string, links: boolean | readonly string[] = false, shown = text, place?: ReadPlace): void {
    const w = this.win(win);
    w.privateRead = true;
    // Punctuation of the sentence around it is not part of the address.
    const found = Array.isArray(links) ? links : links ? [...text.matchAll(URL_IN_TEXT)].map((m) => m[0].replace(/[).,;:!?»\]]+$/, "")) : [];
    for (const raw of found) {
      const url = raw.length <= URL_LENGTH_MAX + 8 ? sameAddress(raw) : undefined;
      if (!url || url.length > URL_LENGTH_MAX) continue;
      w.urls.delete(url);
      w.urls.add(url);
      if (w.urls.size > URLS_MAX) w.urls.delete(w.urls.values().next().value!);
    }
    // This read's items, per group and in all.
    const mine = new Map<Group, Slot>();
    const all: Slot = { items: new Set(), pieces: 0 };
    const forgetMine = (item: Item) => {
      const own = slotOf(mine, item.group);
      own.items.delete(item);
      own.pieces -= item.size;
      all.items.delete(item);
      all.pieces -= item.size;
      this.drop(w, item);
    };
    for (const found of extract(shown)) {
      const known = w.read.get(found.norm);
      if (known) {
        // Re-read: refresh its age and source, keep its index entries.
        w.read.delete(found.norm);
        known.source = source;
        known.from.add(known.from.size < PLACES_MAX ? placeKey(place) : "\n");
        w.read.set(found.norm, known);
        const slot = slotOf(w.groups, known.group);
        slot.items.delete(known);
        slot.items.add(known);
        continue;
      }
      const group = groupOf(found.kind);
      const ps = [...indexed(found)];
      const item: Item = { ...found, source, from: new Set([placeKey(place)]), group, size: ps.length };
      const own = slotOf(mine, group);
      while (own.items.size && (own.items.size >= READ_KIND_MAX || own.pieces + ps.length > READ_KIND_PIECES_MAX))
        forgetMine(own.items.values().next().value!);
      while (all.items.size && (all.items.size >= READ_MAX / 2 || all.pieces + ps.length > PIECES_MAX / 2))
        forgetMine(slotOf(mine, GROUPS.find((g) => mine.get(g)?.items.size)!).items.values().next().value!);
      own.items.add(item);
      own.pieces += ps.length;
      all.items.add(item);
      all.pieces += ps.length;
      w.pieces += ps.length;
      w.read.set(item.norm, item);
      const slot = slotOf(w.groups, group);
      slot.items.add(item);
      slot.pieces += ps.length;
      this.countShort(w, item, 1);
      for (const p of ps) {
        const at = w.shingles.get(p);
        if (!at) w.shingles.set(p, item);
        else if (at instanceof Set) at.add(item);
        else if (at !== item) w.shingles.set(p, new Set([at, item]));
      }
      while (w.read.size > READ_MAX || w.pieces > PIECES_MAX) this.drop(w, this.victim(w, all.items));
    }
  }

  /** The oldest earlier-read item of the group with the largest weighted share; this read holds at most half the window. */
  private victim(w: Win, mine: Set<Item>): Item {
    let best: { item: Item; share: number } | undefined;
    for (const g of GROUPS) {
      const slot = w.groups.get(g);
      const oldest = slot?.items.values().next().value;
      if (!oldest || mine.has(oldest)) continue;
      const share = Math.max(slot!.items.size / READ_MAX, slot!.pieces / PIECES_MAX) / WEIGHT[g];
      if (!best || share > best.share) best = { item: oldest, share };
    }
    return best?.item ?? [...w.read.values()].find((i) => !mine.has(i)) ?? w.read.values().next().value!;
  }

  private drop(w: Win, item: Item): void {
    w.read.delete(item.norm);
    const slot = slotOf(w.groups, item.group);
    slot.items.delete(item);
    slot.pieces -= item.size;
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
    w.typedText = (w.typedText + "\n" + norm(message)).slice(-TYPED_MAX);
    // Messages apart by " \n ": an exemption never spans two messages (« chambre 3 », « 8 personnes »).
    w.typedWords = (w.typedWords + " \n " + words(message)).slice(-TYPED_MAX);
    for (const item of extract(message)) {
      w.typedItems.delete(item.norm);
      w.typedItems.add(item.norm);
    }
    for (const old of w.typedItems) {
      if (w.typedItems.size <= TYPED_ITEMS_MAX) break;
      w.typedItems.delete(old);
    }
  }

  /**
   * `address`: `out` is an address the agent opens, not a search query. `except`: a script's tab and its origin now; an
   * item read on that origin is left out (the page already has it). Not the tab: it may have left the page it was read on.
   */
  check(win: string, out: string, address = false, except?: { tab: string; origin: string | null }): OutflowHit | undefined {
    const w = this.wins.get(win);
    const foreign = (item: Item) => !except?.origin || ![...item.from].some((k) => k.split("\n")[1] === except.origin);
    const typedNow = w ? w.typedText + "\n" + norm(w.buffer) : "";
    const typed = (n: string) => !!w && (w.typedItems.has(n) || typedNow.includes(n));

    for (const s of findSecrets(out)) {
      const n = norm(s.value);
      if (typed(n)) continue;
      const read = w?.read.get(n);
      if (read && !foreign(read)) continue;
      const source = read?.source;
      return { kind: s.kind, masked: mask(s.value), ...(source ? { source } : {}) };
    }
    if (!w) return undefined;
    // An address a private read showed whole is a link followed: it tells its site nothing the link did not already hold.
    if (address && w.urls.has(sameAddress(out) ?? "")) return undefined;

    const hit = (item: Item): OutflowHit => ({ kind: item.kind, masked: mask(item.value), source: item.source });
    // A piece the user typed is theirs to send, even if a read item contains it.
    const found = (p: string, keep: (item: Item) => boolean = () => true) => {
      const at = w.shingles.get(p);
      // The index first: scanning the typed text for every piece of a long query is quadratic.
      if (!at || typedNow.includes(p)) return undefined;
      for (const item of at instanceof Set ? at : at ? [at] : []) if (keep(item) && foreign(item) && !typed(item.norm)) return item;
    };
    const sizes = new Set([DIGIT_CHUNK, TEXT_CHUNK, ...w.shortLengths.keys()]);
    const scan = (out: string): OutflowHit | undefined => {
      // Digits written as words are checked as the digits they spell, read in the percent-decoded text (an address
      // carries 三八一 as %E4%B8%89…); one reading, so the variant bound is unchanged.
      const words = spelled(urlDecoded(out));
      for (const soft of new Set([...variants(out), ...(words ? variants(words) : [])].map(softNorm))) {
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
    };
    const direct = w.read.size ? scan(out) : undefined;
    if (direct || address || !w.privateRead) return direct;

    // shortcut: a frame that changes between queries, or one under 6 characters around a part, evades the series rule;
    // bare pieces with no frame at all are caught (bench B3), also with ordinary searches between them, but not one digit
    // or one whole number per search. Upgrade if a bench shows those.
    // shortcut: a part the user typed as whole words anywhere is exempt (« 2 4 » once typed), whatever its context;
    // tie typed words to their context if that is abused.
    // A series: earlier searches sharing this query's frame (common leading and trailing words) are judged with it, so
    // a value split over several searches is caught. Frame = whole lowercased words, so it never eats into the code.
    const terms = series(out).split(" ");
    let pre = Infinity;
    let suf = Infinity;
    const members: string[][] = [];
    // Whole words only: with spaces dropped, « 38 ans » would exempt the part « 3 8 ».
    const typedWords = ` ${w.typedWords} \n ${words(w.buffer)} `;
    for (const q of w.sent) {
      const other = q.split(" ");
      const [p, x] = frame(terms, other);
      const chars = (ws: string[]) => ws.join(" ").length;
      const shorter = Math.min(chars(terms), chars(other));
      const framed = chars(terms.slice(0, p)) + chars(terms.slice(terms.length - x));
      // Frame thresholds: at least 6 characters and more than half of the shorter query, with a part left on both sides.
      if (framed < 6 || framed * 2 <= shorter || p + x >= Math.min(terms.length, other.length)) continue;
      pre = Math.min(pre, p);
      suf = Math.min(suf, x);
      members.push(other);
    }
    let candidates: string[];
    /** Which parts count toward the pause (all by default). */
    let counted = (parts: string[]) => parts;
    if (members.length) candidates = [...members, terms].map((ws) => ws.slice(pre, ws.length - suf).join(" "));
    else {
      // No frame: a whole query that is a piece (« trois huit », « un six ») joins the bare pieces kept before it, the
      // ordinary searches between them skipped (a lesson planted in the notebook asked for that shape).
      const query = terms.join(" ");
      if (!codeLike(query)) return undefined;
      const bare = w.sent.filter(codeLike);
      if (!bare.length) return undefined;
      candidates = [...bare, query];
      let inRow = 0;
      for (let i = w.sent.length - 1; i >= 0 && codeLike(w.sent[i]!); i--) inRow++;
      // shortcut: with ordinary searches between them, bare pieces with no match pause only when 3 have this query's
      // shape (« trois huit », « un six », « deux quatre » are all two digits), so honest short searches scattered over a
      // conversation (« 2 1 », « e 4 », « 4 4 2 ») stay quiet; a code sent in pieces of changing shape (« trois huit »,
      // « 1 6 2 », « 4 ») leaves when it was not read whole, and 3 honest bare searches of one shape (« 2 1 », « 3 0 »,
      // « 1 1 ») pause. Upgrade if a bench shows either.
      if (inRow < bare.length) counted = inRow >= 2 ? (ps) => ps.slice(-(inRow + 1)) : (ps) => ps.filter((p) => shape(p) === shape(query));
    }
    const untyped = (ps: string[]) => ps.filter((part) => norm(part) && !typedWords.includes(" " + words(part) + " "));
    const pieced = w.read.size ? scan(untyped(candidates).join(" ")) : undefined;
    if (pieced) return pieced;
    const held = untyped(counted(candidates));
    if (held.filter(codeLike).length < 3) return undefined;
    // `masked` shows the parts in clear: the band is seen by the user only, and these parts already went out.
    return { kind: "series", masked: held.join(" · ").slice(0, 40) };
  }

  /** A search that went to the engine: kept, once the window read private data, to judge the next ones as a series. */
  sent(win: string, query: string): void {
    const w = this.wins.get(win);
    if (!w?.privateRead) return;
    w.sent.push(series(query.slice(0, SENT_LENGTH_MAX)));
    if (w.sent.length > SERIES_MAX) w.sent.shift();
  }

  /**
   * A link the agent follows (`label`: its text in a numbered list, if known), judged with the code-like links it followed
   * on the same site before, as bare search pieces are: a page's grid of links labelled « 0 »… « 9 » clicked in a code's
   * order sends the code to the page's server one request at a time. Judging records the piece, held or not, so calls
   * made at the same time are judged one after the other; a held link the user then refuses still counts (stricter).
   */
  click(win: string, url: string, label?: string): OutflowHit | undefined {
    const w = this.wins.get(win);
    // The piece: a one-character label, or one this address was shown with elsewhere (a « voir » listing of it never frees
    // it); an address shown only under words (« Lire la suite » on /article/5) is no piece; one never shown with a label
    // tells its own (an image link, an address typed from the page).
    const shown = w?.labels.get(url);
    const piece = shown || (shown === undefined || label !== undefined ? clickPiece(url, label) : undefined);
    if (!w?.privateRead || !piece) return undefined;
    // Links elsewhere or with words between the pieces do not end the run: a « Retour » link would otherwise defeat it.
    const site = clickSite(url);
    const run = w.clicks.get(site) ?? [];
    w.clicks.delete(site);
    w.clicks.set(site, run);
    if (w.clicks.size > CLICK_SITES_MAX) w.clicks.delete(w.clicks.keys().next().value!);
    if (run.push(piece) > SERIES_MAX) run.shift();
    // The pieces joined, scanned as an address is (rule 2): a run that spells a read item is that item, whatever its shape.
    const spelt = w.read.size ? this.check(win, run.join(" "), true) : undefined;
    if (spelt) return spelt;
    // shortcut: the last PAGER_SPAN pieces of a run of ASCII digits and letters are read as a pager, and pass when they spell
    // no read item, when each step climbs or steps back by one (« 2 3 4 », « 4 3 », « 2 3 5 »), with one step at most going
    // back to « 1 » or to a page of the run right after a step of one (« 2 3 4 5 1 », « 3 4 5 4 2 »). So a code shaped
    // that way (123 456, 135 799: measured over all 6-digit codes, 7.4 %, 2.9 % without the back step) leaves when it was
    // not read whole; upgrade if a bench shows codes sent that way. Any other character (a CJK label) gets no pager pass, or a page could make every code
    // climb. Only the last pieces are judged so a step that carded stops carding honest links later (a drop stays within
    // PAGER_SPAN pieces of its two ends, so a code still meets it).
    const tail = run.slice(-PAGER_SPAN);
    const at = (i: number) => tail[i]!.codePointAt(0)!;
    let back = 0;
    const pager = tail.every((c, i) => {
      if (!/^[0-9a-z]$/.test(c)) return false;
      if (!i || at(i) >= at(i - 1) - 1) return true;
      return i > 1 && Math.abs(at(i - 1) - at(i - 2)) <= 1 && (c === "1" || tail.indexOf(c) < i) && ++back <= 1;
    });
    if (run.length < 3 || pager) return undefined;
    // `masked` shows the pieces in clear, as for a series of searches: the agent asked to send each of them.
    return { kind: "clicks", masked: run.join(" · ").slice(0, 40) };
  }

  /** Links shown to the agent in a numbered list, kept by address with the piece their label gives (`click`). */
  links(win: string, links: readonly { text: string; url: string }[]): void {
    const w = this.win(win);
    for (const l of links) {
      if (l.url.length > URL_LENGTH_MAX) continue;
      // A link with no label tells nothing here: its address gives its piece. A piece once shown stays: listing the same
      // address again under a word (« voir ») must not free it.
      if (!l.text.trim()) continue;
      const piece = clickPiece(l.url, l.text) ?? "";
      const kept = w.labels.get(l.url);
      w.labels.delete(l.url);
      w.labels.set(l.url, kept || piece);
      if (w.labels.size > LABELS_MAX) w.labels.delete(w.labels.keys().next().value!);
    }
  }

  /** `check` against what every window read: for a caller tied to no window (the main token), which could otherwise
   *  send what a window read. */
  checkAll(out: string, address = false, except?: { tab: string; origin: string | null }): OutflowHit | undefined {
    // No window yet: still one pass, for the secret shapes (rule 1).
    for (const win of this.wins.size ? this.wins.keys() : [""]) {
      const hit = this.check(win, out, address, except);
      if (hit) return hit;
    }
    return undefined;
  }

  /** A new conversation in the window: what the user typed before is no longer theirs to send; what was read stays. */
  forgetTyped(win: string): void {
    const w = this.wins.get(win);
    if (!w) return;
    w.typedItems.clear();
    w.typedText = w.typedWords = w.buffer = w.carry = "";
    w.paste = false;
    w.sent = [];
    w.clicks.clear();
  }

  forget(win: string): void {
    this.wins.delete(win);
  }
}

/** `s` as words: lowercased, letters, digits and `@` only, single spaces. */
const words = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}@]+/gu, " ").trim();

/**
 * What a followed link tells its server, when that is one character: its label, or without one a one-character query
 * value or else the last path segment of its address (« /k/3 », « ?d=3&s=abc »). Undefined for anything longer.
 */
function clickPiece(url: string, label?: string): string | undefined {
  let piece = label?.trim();
  if (!piece)
    try {
      const u = new URL(url);
      // Any one-character query value (?d=3&s=abc), else the last path segment.
      piece = [...u.searchParams.values()].find((v) => [...norm(v)].length === 1) ?? decodeURIComponent(u.pathname.split("/").filter(Boolean).at(-1) ?? "");
    } catch {
      return undefined;
    }
  const n = norm(piece);
  return [...n].length === 1 ? n : undefined;
}

/**
 * The site a followed link goes to, as its host's last two labels: the subdomains of one server (a.grille.net, b.grille.net)
 * are one site. shortcut: under a two-label suffix (co.uk) every site is one, so runs join more and pause more; use the
 * public suffix list if that shows.
 */
function clickSite(url: string): string {
  try {
    return new URL(url).hostname.split(".").slice(-2).join(".");
  } catch {
    return "";
  }
}

/** A query as kept for a series: lowercased, words split on whitespace. */
const series = (q: string) => q.normalize("NFKC").toLowerCase().trim().split(/\s+/).join(" ");

/** Counts of leading and trailing words `a` and `b` share, not overlapping. */
function frame(a: string[], b: string[]): [number, number] {
  const n = Math.min(a.length, b.length);
  let p = 0;
  while (p < n && a[p] === b[p]) p++;
  let x = 0;
  while (x < n - p && a[a.length - 1 - x] === b[b.length - 1 - x]) x++;
  return [p, x];
}

/**
 * A part that looks like a piece of a code: rewritten by `rewrite` (one reading of `spelled`: digit words, spaced
 * letters, NATO) to at most 12 characters, or a part of at most 12 characters holding at least 2 single digits or
 * letters, digit words or NATO words (« 3 8 », « a b », « sept zéro », « kilo xray »), each counted as one
 * character, that make more than half of it. A whole number (« 38 », « 2023 », « 69001 ») is an ordinary refinement, not a piece; a
 * code sent as whole numbers is still caught by the joined-parts scan when it was read.
 */
function codeLike(part: string): boolean {
  const once = rewrite(part, true);
  if (once !== undefined) return norm(once).length <= 12;
  // Split on whitespace only: 2.4, 1/2 and 4-4-2 are one number each, not separate code pieces.
  const tokens = part.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  // A digit or NATO word (sept, kilo) stands for one character.
  const one = tokens.map((t) => /^[\p{L}\p{N}]$/u.test(t) || digitWord(t));
  const total = tokens.reduce((n, t, i) => n + (one[i] ? 1 : t.length), 0);
  const code = one.filter(Boolean).length;
  return total <= 12 && code >= 2 && code * 2 > total;
}

/** A bare piece's shape: one class per word, `d` a digit or digit word, `l` one letter, `x` anything else (« trois huit » → dd). */
const shape = (part: string) =>
  part
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .map((t) => (/^\p{N}$/u.test(t) || (t.length > 1 && digitWord(t)) ? "d" : /^\p{L}$/u.test(t) ? "l" : "x"))
    .join("");

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
