import { findAll, longest, telDigitForms, type LabelType, type Zone } from "./detectors.js";
import { canonicalOf, FIELD_LABEL, rawOf, type Forms as PassportForms, type PassportEntry } from "./passport-fields.js";
import type { PassportRef, PassportStore } from "./passport.js";
import { foldedProjections, foldWords, originalSpan, projections, type Projection } from "./projections.js";
import { LABEL_SOURCE, LABELS, type Entry, type LabelTable } from "./table.js";

export type MaskContext = { table: LabelTable; zone: Zone; origin: string | null };
type Span = { start: number; end: number; label: string };

const LABEL_OR_BRACKET = new RegExp(`${LABEL_SOURCE}|[⟨⟩]`, "g");
// Placeholders of issued labels while masking; `sanitize` removes the whole range from untrusted text first.
const PLACEHOLDERS = /\uE000+|\uE001+/g;
const PRIVATE_USE = /[\uE000-\uE0FF]/g;
const KEY = 4;

/**
 * `untrusted` without private-use characters, every `⟨` `⟩` turned into the lookalike `〈` `〉` except in a label
 * `table` issued: a page cannot plant a label.
 */
export function sanitize(untrusted: string, table: LabelTable): string {
  return untrusted
    .replace(PRIVATE_USE, "")
    .replace(LABEL_OR_BRACKET, (m) => (m.length > 1 && table.issued(m) ? m : m.replace(/⟨/g, "〈").replace(/⟩/g, "〉")));
}

// Lower-case letters a-z to the precomposed Latin letters built on them (é, Ê, ŀ…), for names typed with or without accents.
const ACCENTED = new Map<string, string>();
for (let cp = 0xc0; cp <= 0x24f; cp++) {
  const c = String.fromCodePoint(cp);
  const base = c.normalize("NFD")[0]!.toLowerCase();
  if (/[a-z]/.test(base) && c.normalize("NFD").length > 1) ACCENTED.set(base, (ACCENTED.get(base) ?? "") + c);
}
const escape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

/** A name's spacing: within a line, or (`wrap`) across lines too. */
const space = (wrap: boolean) => (wrap ? "\\s" : "[^\\S\\r\\n]");
const letters = (word: string, sp = space(false)) =>
  [...word].map((c) => (/[\s-]/.test(c) ? `(?:${sp}|-)+` : ACCENTED.has(c) ? `[${c}${ACCENTED.get(c)}]\\p{M}*` : escape(c) + "\\p{M}*")).join("");

/**
 * A known name in any case, with or without its accents, composed or not; hyphens and spaces interchangeable inside
 * a word. Built from the name's own words: as given or surname first, with a space or a comma between them, and with
 * the first name as initials before or after the rest (« C. Exemple », « J.-P. Dupont », « Dupont JP »). A lone
 * first name or surname is never matched. Initials are captured in groups `i…` for `capitalInitials`.
 */
function nameRegex(name: string, wrap = false): RegExp {
  const words = name.split(" ");
  const [first, rest, last, others] = [words[0]!, words.slice(1), words[words.length - 1]!, words.slice(0, -1)];
  const sp = space(wrap);
  const word = (w: string) => letters(w, sp);
  const between = `(?:${sp}*,${sp}*|${sp}+)`;
  const seq = (ws: string[], sep = `${sp}+`) => ws.map(word).join(sep);
  const forms = [seq(words, between)];
  if (rest.length) {
    // One initial per part of the first name (Jean-Pierre → J, P), joined by « .- », « - », « . » or nothing.
    const initials = (g: string) =>
      first.split("-").map((part, k) => `(?<i${g}${k}>${word(part[0]!)})`).join(`(?:\\.-|-|\\.${sp}*)?`);
    forms.push(
      `${word(last)}${between}${seq(others)}`,
      `${initials("a")}(?:\\.${sp}*|${sp}+)${seq(rest)}`,
      `${seq(rest)}${sp}+${initials("b")}\\.?(?!['’])`,
    );
  }
  return new RegExp(`(?<![\\p{L}\\p{M}])(?:${forms.join("|")})(?![\\p{L}\\p{M}])`, "giu");
}

/**
 * A match inside a host name or a domain (« impots-gouv-fr.test », « jean-lucie.fr »): its run of address characters
 * holds a scheme, an @, or a dot before a short lower-case label that ends there (a domain's end). A name there is a
 * site's, never the person's. « Jean-Lucie.Merci » is no host.
 */
function inHost(t: string, start: number, end: number): boolean {
  // A space, or a capital (« Jean-Lucie.fr » is a signature, a host is written in lower case): no host.
  if (/[\s\p{Lu}]/u.test(t.slice(start, end))) return false;
  let [a, b] = [start, end];
  while (a > 0 && /[\p{L}\p{N}\p{M}.@:/_%-]/u.test(t[a - 1]!)) a--;
  while (b < t.length && /[\p{L}\p{N}\p{M}.@:/_%-]/u.test(t[b]!)) b++;
  return /:\/\/|@|\.[a-z]{2,6}(?![\p{L}\p{N}\p{M}])/u.test(t.slice(a, b));
}

/** A name match whose initials, if any, are capitals in the text: « c » in « Marie et c Exemple » is no initial. */
const capitalInitials = (m: RegExpMatchArray) =>
  Object.entries(m.groups ?? {}).every(([k, v]) => !k.startsWith("i") || v === undefined || /^\p{Lu}/u.test(v));

type Forms = { digits: string[]; literals: string[]; name?: RegExp[] };
const formsCache = new WeakMap<Entry, Forms>();

/** The forms a known value is searched in: digit strings (any separators), literal strings, or a name pattern. */
function forms(e: Entry): Forms {
  let f = formsCache.get(e);
  if (f) return f;
  const v = e.value;
  const all: Record<LabelType, () => Forms> = {
    iban: () => {
      const bban = v.slice(4);
      return { digits: [v.replace(/\D/g, ""), ...(/^\d+$/.test(bban) ? [bban] : [])], literals: [] };
    },
    carte: () => ({ digits: [v], literals: [] }),
    secu: () => ({ digits: /^\d+$/.test(v) ? [v] : [], literals: [] }),
    tel: () => ({ digits: telDigitForms(v), literals: [] }),
    code: () => (/^\d+$/.test(v) ? { digits: [v], literals: [] } : { digits: [], literals: [v] }),
    // Every shaped e-mail is found by the detector, in any case and percent-decoded.
    email: () => ({ digits: [], literals: [] }),
    nom: () => ({ digits: [], literals: [], name: [nameRegex(v), nameRegex(v, true)] }),
    id: () => ({ digits: [], literals: [v] }),
    motdepasse: () => ({ digits: [], literals: [v] }),
    adresse: () => ({ digits: [], literals: [v] }),
    masque: () => ({ digits: [], literals: [v] }),
    date: () => ({ digits: [], literals: [v] }),
  };
  f = all[e.type]();
  f.digits = f.digits.filter((d) => d.length >= KEY);
  formsCache.set(e, f);
  return f;
}

export type Needle<T = string> = { form: string; label: T };
// First 4 characters → form length → form → labels: a scan costs a few lookups per position, however many values
// share a prefix, never one pass per value.
export type Index<T = string> = Map<string, Map<number, Map<string, T[]>>>;

function index<T>(needles: Needle<T>[]): Index<T> {
  const m: Index<T> = new Map();
  for (const { form, label } of needles) {
    const byLength = m.get(form.slice(0, KEY)) ?? new Map<number, Map<string, T[]>>();
    const byForm = byLength.get(form.length) ?? new Map<string, T[]>();
    byForm.set(form, [...(byForm.get(form) ?? []), label]);
    byLength.set(form.length, byForm);
    m.set(form.slice(0, KEY), byLength);
  }
  return m;
}

/** Between two digits of a digit form: at most 3 characters, no letter (percent escapes aside), no label placeholder. */
const gapOk = (s: string, from: number, to: number) => {
  if (to - from > 12) return false;
  const gap = s.slice(from, to).replace(/%[0-9A-Fa-f]{2}/g, "");
  return gap.length <= 3 && !/[\p{L}\uE000\uE001]/u.test(gap);
};

/** Every place a form of `m` occurs in `p`, given as projected offsets with the form's labels. */
function scan<T>(p: Projection, m: Index<T>, s: string, emit: (i: number, j: number, label: T) => void) {
  if (!m.size) return;
  const t = p.text;
  for (let i = 0; i + KEY <= t.length; i++) {
    const byLength = m.get(t.slice(i, i + KEY));
    if (!byLength) continue;
    for (const [length, byForm] of byLength) {
      const labels = byForm.get(t.slice(i, i + length));
      if (!labels) continue;
      const j = i + length;
      if (p.kind === "digits") {
        let ok = true;
        for (let k = i; ok && k < j - 1; k++) ok = gapOk(s, p.end[k]!, p.start[k + 1]!);
        if (!ok) continue;
      }
      for (const label of labels) emit(i, j, label);
    }
  }
}

function hits(p: Projection, m: Index, s: string, out: Span[]) {
  scan(p, m, s, (i, j, label) => out.push({ ...spanOf(p, i, j), label }));
}

/** A passport form's owner: what a hit labels, the offsets of its initials, and whether it is a name (`inHost`). */
type Owner<T> = { value: T; initials: number[]; name: boolean };
type FormsIndex<T> = { folded: Index<Owner<T>>; digits: Index<Owner<T>> };

function formsIndex<T>(owners: { forms: PassportForms; name: boolean; value: T }[]): FormsIndex<T> {
  const folded: Needle<Owner<T>>[] = [];
  const digits: Needle<Owner<T>>[] = [];
  for (const { forms, name, value } of owners) {
    for (const f of forms.folded) folded.push({ form: f.form, label: { value, initials: f.initials, name } });
    for (const form of forms.digits) digits.push({ form, label: { value, initials: [], name: false } });
  }
  return { folded: index(folded), digits: index(digits) };
}

/**
 * Where `idx`'s forms occur in `s` (design § 6.3): digit forms with no digit right before or after, folded forms between
 * folded-word boundaries, initials upper case in `s`, a name never inside a host. `folded` is built only when needed.
 */
function formHits<T>(s: string, idx: FormsIndex<T>, projs: Projection[], folded: () => Projection[]): { start: number; end: number; value: T }[] {
  const out: { start: number; end: number; value: T }[] = [];
  for (const p of projs)
    if (p.kind === "digits" || p.kind === "numerals")
      scan(p, idx.digits, s, (i, j, o) => {
        const [start, end] = originalSpan(p, i, j);
        if (!/\p{Nd}$/u.test(s.slice(Math.max(0, start - 2), start)) && !/^\p{Nd}/u.test(s.slice(end, end + 2))) out.push({ start, end, value: o.value });
      });
  if (!idx.folded.size) return out;
  for (const p of folded()) {
    const t = p.text;
    scan(p, idx.folded, s, (i, j, o) => {
      if ((i > 0 && t[i - 1] !== " ") || (j < t.length && t[j] !== " ")) return;
      if (!o.initials.every((k) => /^\p{Lu}/u.test(s.slice(...originalSpan(p, i + k, i + k + 1))))) return;
      const [start, end] = originalSpan(p, i, j);
      // A writing never spans an address's brackets: « Aubrac <julien… » is no reversed name.
      if (/[<>@]/.test(s.slice(start, end))) return;
      if (!o.name || !inHost(s, start, end)) out.push({ start, end, value: o.value });
    });
  }
  return oneLine(s, out);
}

/**
 * A writing wrapped over two lines is kept (« 14,⏎rue des Tanneurs »), but not one that only joins the end of a line to
 * the start of the next where each line has its own (« Mme Aubrac⏎Camille Aubrac »): it would merge the two lines.
 */
function oneLine<H extends { start: number; end: number }>(s: string, hits: H[]): H[] {
  const crosses = (h: H) => /[\r\n]/.test(s.slice(h.start, h.end));
  return hits.filter((h) => !crosses(h) || !hits.some((k) => k !== h && !crosses(k) && k.start < h.end && h.start < k.end));
}

/** A passport entry as a hit labels it. */
type Drawn = { ref: PassportRef; entry: PassportEntry; type: LabelType; canonical: string; raw: string };
export type PassportHit = Drawn & { start: number; end: number };
// One index of every form of every passport, built once per store version (design § 6.7).
const storeIndexes = new WeakMap<PassportStore, { version: number; idx: FormsIndex<Drawn> }>();

function storeIndex(store: PassportStore): FormsIndex<Drawn> {
  const cached = storeIndexes.get(store);
  if (cached?.version === store.version) return cached.idx;
  const owners = store.profiles().flatMap((profile) =>
    store.entries(profile).map((entry) => {
      const ref = { profile, id: entry.id };
      const type = FIELD_LABEL[entry.field];
      return { forms: store.formsOf(ref)!, name: type === "nom", value: { ref, entry, type, canonical: canonicalOf(entry), raw: rawOf(entry) } };
    }),
  );
  const idx = formsIndex(owners);
  storeIndexes.set(store, { version: store.version, idx });
  return idx;
}

/**
 * Where the passport's values occur in `text`, under every form it knows. Only for the sources zone: the caller checks
 * the zone (spec § 6, the web never gets the passport). `projs` and `folded`: `text`'s projections, when already built.
 */
export function passportHits(text: string, store: PassportStore, projs = projections(text), folded = () => foldedProjections(text, projs)): PassportHit[] {
  return formHits(text, storeIndex(store), projs, folded).map((h) => ({ start: h.start, end: h.end, ...h.value }));
}

/**
 * A table entry's passport forms (ruling F3: a fill's web entry is searched by them): as the passport had them when the
 * table first labelled the value, so an entry removed or edited since keeps its writings in this table.
 */
const tableForms = new WeakMap<LabelTable, Map<string, { type: LabelType; value: string; forms: PassportForms[] }>>();

function rememberForms(table: LabelTable, label: string, type: LabelType, value: string, forms: PassportForms | undefined): void {
  if (!forms) return;
  const byLabel = tableForms.get(table) ?? new Map<string, { type: LabelType; value: string; forms: PassportForms[] }>();
  tableForms.set(table, byLabel);
  const known = byLabel.get(label);
  // After a wipe a label may be drawn again for another value: the type and value tell them apart.
  if (known?.type === type && known.value === value) {
    if (!known.forms.includes(forms)) known.forms.push(forms);
  } else byLabel.set(label, { type, value, forms: [forms] });
}

function entryForms(table: LabelTable, e: Entry): PassportForms[] {
  if (!e.passport) return [];
  for (const ref of e.passport) {
    const now = table.passport?.get(ref);
    // The store's entry may have been edited: its forms are this value's only while it still has this value.
    if (now && FIELD_LABEL[now.field] === e.type && canonicalOf(now) === e.value) rememberForms(table, e.label, e.type, e.value, table.passport!.formsOf(ref));
  }
  const known = tableForms.get(table)?.get(e.label);
  return known?.type === e.type && known.value === e.value ? known.forms : [];
}

/**
 * Design § 8.5: a value filled on `origin` joins the table's web zone there, so a later read of that page masks it.
 * A passport value keeps its refs and the writings this table knew it by (ruling F3), even once the entry left the passport.
 */
export function labelFilled(table: LabelTable, e: Entry, origin: string): void {
  let label = table.label(e.type, e.value, "web", origin, e.raw);
  for (const ref of e.passport ?? []) label = table.label(e.type, e.value, "web", origin, e.raw, ref);
  for (const forms of entryForms(table, e)) rememberForms(table, label, e.type, e.value, forms);
  // A value the page already had gains its passport writings without a new entry: the origin's lookup is rebuilt.
  table.lookups.delete(JSON.stringify(origin));
}

/**
 * Design § 8.5 for a part of an entry filled by kind (« 69005 », « Aubrac »): the text written joins the web zone on
 * `origin` only, found as one folded form (any case, between word boundaries). Over-masking that word there is accepted.
 * shortcut: a part under 4 folded characters (« Pau ») is not masked at all (the forms index keys on 4), upgrade if short parts matter.
 */
export function labelWritten(table: LabelTable, type: LabelType, written: string, origin: string, ref: PassportRef): void {
  const form = foldWords(written);
  if (form.length < KEY) return;
  // The ref makes the lookup search this label by its remembered forms; its value never equals the entry's canonical.
  const label = table.label(type, form, "web", origin, written, ref);
  rememberForms(table, label, type, form, { folded: [{ form, initials: [] }], digits: [] });
  table.lookups.delete(JSON.stringify(origin));
}

/**
 * The zone's known values ready to search: built once per zone and origin, again when the zone gains an entry or the
 * passport changes. `passport`: the forms of the entries drawn from the passport (labels as values). `emails`: the web
 * zone's e-mails (only a fill puts one there), by canonical value.
 */
export type Lookup = { size: number; version: number; byDigits: Index; byText: Index; short: Needle[]; names: [RegExp[], string][]; passport: FormsIndex<{ label: string; type: LabelType }>; emails: Set<string> };

function lookup(ctx: MaskContext): Lookup {
  const { table, zone, origin } = ctx;
  const all = table.entries(zone);
  const key = zone === "sources" ? zone : JSON.stringify(origin);
  const cached = table.lookups.get(key);
  const version = table.passport?.version ?? 0;
  // Entries are only appended (a wipe clears the cache), and a web entry's origin never changes: same size, same index.
  if (cached?.size === all.length && cached.version === version) return cached;
  const built = buildLookup(ctx, all);
  table.lookups.set(key, built);
  return built;
}

/** `lookup` over `all` (the zone's entries), not cached. */
function buildLookup(ctx: MaskContext, all: readonly Entry[]): Lookup {
  const { table, zone, origin } = ctx;
  const version = table.passport?.version ?? 0;
  const entries = zone === "sources" ? all : all.filter((e) => (origin === null ? !e.origins.length : e.origins.includes(origin)));
  const digits: Needle[] = [];
  const long: Needle[] = [];
  const short: Needle[] = [];
  const names: [RegExp[], string][] = [];
  const drawn: { forms: PassportForms; name: boolean; value: { label: string; type: LabelType } }[] = [];
  const emails = new Set<string>();
  for (const e of entries) {
    if (zone === "web" && e.type === "email") emails.add(e.value);
    const own = entryForms(table, e);
    for (const pf of own) drawn.push({ forms: pf, name: e.type === "nom", value: { label: e.label, type: e.type } });
    const f = forms(e);
    for (const form of f.digits) digits.push({ form, label: e.label });
    // A passport value is found by its forms, between word boundaries; its canonical as a bare literal would also match
    // inside another word (« Ablyon », « 690051 »).
    if (!own.length) for (const form of f.literals) (form.length >= KEY ? long : short).push({ form, label: e.label });
    if (f.name) names.push([f.name, e.label]);
  }
  return { size: all.length, version, byDigits: index(digits), byText: index(long), short, names, passport: formsIndex(drawn), emails };
}

/** Every occurrence of the zone's known values in `s`, in any of their forms, on every projection. */
function variants(s: string, { byDigits, byText, short, names }: Lookup, projs: Projection[]): Span[] {
  const out: Span[] = [];
  for (const p of projs) {
    if (p.kind === "digits" || p.kind === "numerals") {
      hits(p, byDigits, s, out);
      continue;
    }
    hits(p, byText, s, out);
    // shortcut: values under 4 characters (a short password) are searched one pass each, upgrade if they get many.
    for (const n of short)
      for (let i = p.text.indexOf(n.form); i >= 0 && n.form; i = p.text.indexOf(n.form, i + n.form.length))
        out.push({ ...spanOf(p, i, i + n.form.length), label: n.label });
    // Two passes, so a wrapped match never consumes the start of a name on its own line: the wrapped ones then go by oneLine.
    const found: Span[] = [];
    for (const [res, label] of names)
      for (const re of res)
        for (const m of p.text.matchAll(re)) if (capitalInitials(m) && !inHost(p.text, m.index, m.index + m[0].length)) found.push({ ...spanOf(p, m.index, m.index + m[0].length), label });
    out.push(...oneLine(s, found));
  }
  return out;
}

const spanOf = (p: Projection, from: number, to: number) => {
  const [start, end] = originalSpan(p, from, to);
  return { start, end };
};

const WORD = /[\p{L}\p{N}\p{M}]/u;

/** The spans of `sorted` (by start, none longer than `longest`) that may overlap `h`: a few per hit, not every find. */
function near<T extends { start: number; end: number }>(sorted: readonly T[], longest: number, h: { start: number; end: number }): T[] {
  let [lo, hi] = [0, sorted.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.start < h.end) lo = mid + 1;
    else hi = mid;
  }
  const out: T[] = [];
  for (let k = lo - 1; k >= 0 && sorted[k]!.start > h.start - longest; k--) if (sorted[k]!.end > h.start) out.push(sorted[k]!);
  return out;
}

/**
 * Design § 6.6, between types the detector wins: the parts of passport hit `h` outside every detector span of another
 * type, each trimmed to word characters. « Aubrac camille@… » keeps « camille » an e-mail (no name in a local part)
 * and « Aubrac » a name; a hit wholly inside a detector span is left to it. A hit's own edges stay where its projection put them.
 */
function outside<H extends { start: number; end: number; type: LabelType }>(s: string, h: H, finds: readonly { start: number; end: number; type: LabelType }[]): H[] {
  let parts: [number, number][] = [[h.start, h.end]];
  for (const f of finds) {
    if (f.type === h.type) continue;
    parts = parts.flatMap(([a, b]): [number, number][] => (f.end <= a || f.start >= b ? [[a, b]] : [[a, Math.min(b, f.start)], [Math.max(a, f.end), b]]));
  }
  const out: H[] = [];
  for (let [a, b] of parts) {
    // Only a cut edge is trimmed: the hit's own edges may start an escape (« \u0048éloïse »).
    while (a < b && a !== h.start && !WORD.test(s[a]!)) a++;
    while (b > a && b !== h.end && !WORD.test(s[b - 1]!)) b--;
    if (a < b) out.push({ ...h, start: a, end: b });
  }
  return out;
}

/** Gives a value its label: `LabelTable.label`'s arguments. */
type Labeler = (type: LabelType, canonical: string, zone: Zone, origin: string | null, raw: string, ref?: PassportRef) => string;

/**
 * Issued labels of `text` hidden behind placeholder runs, alternating so two adjacent labels stay two runs: no detector
 * reads the digits or the type word of a label, and no replacement cuts one. `labels`: the hidden labels, in order.
 */
function placeheld(text: string, table: LabelTable): { s: string; labels: string[] } {
  const labels: string[] = [];
  const s = sanitize(text, table).replace(LABELS, (l) => (labels.push(l), (labels.length % 2 ? "\uE000" : "\uE001").repeat(l.length)));
  return { s, labels };
}

/**
 * The spans `maskText` replaces in `s` (placeheld), sorted and apart, each with its label. `label` gives each value its
 * label; `known` the zone's lookup, called once every detector find has its label. `remember`: a passport hit's forms go
 * to the table (only when `label` issues real labels).
 */
function maskSpans(s: string, ctx: MaskContext, label: Labeler, known: () => Lookup, remember: boolean): Span[] {
  const { table, zone, origin } = ctx;
  const projs = projections(s);
  let foldedOnce: Projection[] | undefined;
  // The folded projection costs a pass: built only when a passport form is searched (ruling F19).
  const folded = () => (foldedOnce ??= foldedProjections(s, projs));
  const finds = findAll(s, zone);
  const byStart = [...finds].sort((a, b) => a.start - b.start);
  const longestFind = finds.reduce((m, f) => Math.max(m, f.end - f.start), 0);
  const passport = zone === "sources" && table.passport ? passportHits(s, table.passport, projs, folded).flatMap((h) => outside(s, h, near(byStart, longestFind, h))) : [];
  // Design § 6.6: a passport span replaces a detector span of the same extent and type (a header's display name).
  const replaced = (f: { start: number; end: number; type: LabelType }) => passport.some((h) => h.start === f.start && h.end === f.end && h.type === f.type);
  // A value goes back out as the page wrote it, but a code may have been spelled out in words: its digits go back.
  const spans: Span[] = finds
    .filter((f) => !replaced(f))
    .map((f) => ({ start: f.start, end: f.end, label: label(f.type, f.canonical, zone, origin, f.type === "code" ? f.canonical : s.slice(f.start, f.end)) }));
  const k = known();
  spans.push(...variants(s, k, projs));
  // Design § 8.5: the web zone's detector finds no e-mail, so one filled on this origin is found as the sources find it (local part).
  if (k.emails.size)
    for (const f of findAll(s, "sources")) if (f.type === "email" && k.emails.has(f.canonical)) spans.push({ start: f.start, end: f.end, label: label("email", f.canonical, zone, origin, s.slice(f.start, f.end)) });
  // A known passport value (read before, or filled on this origin) yields to a detector of another type too, as on its first read.
  for (const h of formHits(s, k.passport, projs, folded))
    for (const part of outside(s, { start: h.start, end: h.end, type: h.value.type }, near(byStart, longestFind, h))) spans.push({ start: part.start, end: part.end, label: h.value.label });
  for (const h of passport) {
    const l = label(h.type, h.canonical, "sources", origin, h.raw, h.ref);
    if (remember) rememberForms(table, l, h.type, h.canonical, table.passport!.formsOf(h.ref));
    spans.push({ start: h.start, end: h.end, label: l });
  }
  return longest(spans.filter((x) => !/[\uE000\uE001]/.test(s.slice(x.start, x.end))));
}

/**
 * `text` with every value to hide replaced by its label: what is found in it (registered in `ctx.table`), plus the
 * known values of the zone in any of their forms. The sources zone applies every sources entry; the web zone only the
 * web entries of `ctx.origin`, never a sources entry (that would tell a page which of its values are yours). The
 * passport masks in the sources zone only (design § 6.1); in the web zone only a value it filled there, on that origin.
 * E-mails keep their `@domain`; overlapping finds are masked as one, with the longest one's label.
 */
export function maskText(text: string, ctx: MaskContext): string {
  const { table } = ctx;
  // Internal comparisons set it too: it errs toward « non couverte » (ruling F30).
  table.touched = true;
  const { s, labels } = placeheld(text, table);
  let out = "";
  let at = 0;
  for (const sp of maskSpans(s, ctx, (...a) => table.label(...a), () => lookup(ctx), true)) {
    out += s.slice(at, sp.start) + sp.label;
    at = sp.end;
  }
  out += s.slice(at);
  let i = 0;
  return out.replace(PLACEHOLDERS, () => labels[i++]!);
}

/** A span of a text `maskText` would replace by a label of `type`. */
export type MaskedRun = { start: number; end: number; type: LabelType };

/**
 * Exactly the spans `maskText(text, ctx)` would label, as offsets in `text`, sorted and apart: for the chrome's marks.
 * Issues no label and leaves the table as it was (bar its search caches): a value not yet in the table gets a stand-in.
 */
export function maskedRuns(text: string, ctx: MaskContext): MaskedRun[] {
  const { table, zone } = ctx;
  const { s } = placeheld(text, table);
  const stand = new Map<string, string>();
  const pending: Entry[] = [];
  const label: Labeler = (type, canonical, z, origin, raw) => {
    const issued = table.labelOf(type, canonical, z, origin);
    if (issued) return issued;
    const key = JSON.stringify(z === "sources" ? [z, type, canonical] : [z, type, canonical, origin]);
    let l = stand.get(key);
    if (!l) {
      // The label's type is all a run reads of it; the table never sees it.
      l = `⟨${type}-${stand.size}⟩`;
      stand.set(key, l);
      if (z === zone) pending.push({ label: l, type, value: canonical, raw, zone: z, origins: origin === null ? [] : [origin] });
    }
    return l;
  };
  // maskText's lookup gains the detector finds it just labelled: the same entries here, appended as the table would.
  const known = () => (pending.length ? buildLookup(ctx, [...table.entries(zone), ...pending]) : lookup(ctx));
  const spans = maskSpans(s, ctx, label, known, false);
  // `sanitize` drops private-use characters and keeps every other one: map offsets in `s` back to `text`.
  const kept: number[] = [];
  if (s.length !== text.length) for (let i = 0; i < text.length; i++) if (!/[\uE000-\uE0FF]/.test(text[i]!)) kept.push(i);
  const back = (i: number) => (kept.length ? kept[i]! : i);
  return spans.map((sp) => ({ start: back(sp.start), end: back(sp.end - 1) + 1, type: /^⟨([a-z]+)-/.exec(sp.label)![1] as LabelType }));
}
