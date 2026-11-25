import type { LabelType, Zone } from "./detectors.js";
import type { Lookup } from "./mask.js";
import type { PassportRef, PassportStore } from "./passport.js";

/**
 * `value`: the canonical form, what forms are matched on; `raw`: the value as first written, what goes back out (a reveal,
 * a fill, the user's « Voir »); `passport`: the passport entries it was drawn for, if any.
 */
export type Entry = { label: string; type: LabelType; value: string; raw: string; zone: Zone; origins: string[]; passport?: PassportRef[] };
/** A tab opened from an issued handle: printed as that handle, whatever address it is on now. */
export type Pin = { handle: string; real: string };

/** The regex-safe form of `s`. */
const escaped = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
/** `encodeURIComponent`, or nothing for a string it cannot encode (a lone surrogate). */
const encoded = (s: string) => {
  try {
    return encodeURIComponent(s);
  } catch {
    return "";
  }
};
// A value this short is replaced only as a whole word: inside other digits or letters it is a date, a price, a word.
const SHORT_VALUE = 6;

/**
 * `text` with each entry's value replaced by its label, in any case, as written, percent-encoded or with `+` for spaces
 * (as an address writes it). An e-mail keeps its `@domain`, as masking writes it.
 */
export function relabel(text: string, entries: readonly Entry[]): string {
  const forms = new Map<string, { to: string; word: boolean }>();
  const add = (form: string, to: string, word = form.length < SHORT_VALUE) => form && !forms.has(form.toLowerCase()) && forms.set(form.toLowerCase(), { to, word });
  for (const e of entries)
    for (const v of new Set([e.raw, e.value])) {
      const at = e.type === "email" ? v.lastIndexOf("@") : -1;
      if (at > 0) {
        const local = v.slice(0, at);
        add(v, `${e.label}${v.slice(at)}`);
        add(encoded(v), `${e.label}%40${v.slice(at + 1)}`);
        // The local part alone (a page writes « camille.exemple »), long enough not to be a common word, as a whole word.
        if (local.length >= SHORT_VALUE) for (const f of [local, encoded(local), local.replace(/ /g, "+")]) add(f, e.label, true);
      } else {
        for (const f of [v, encoded(v)]) {
          add(f, e.label);
          add(f.replace(/%20| /g, "+"), e.label);
        }
      }
    }
  if (!forms.size) return text;
  // A whole word: no letter, digit or e-mail character glued to it.
  const alternatives = [...forms]
    .sort(([a], [b]) => b.length - a.length)
    .map(([f, { word }]) => (word ? `(?<![\\p{L}\\p{N}._%+-])${escaped(f)}(?![\\p{L}\\p{N}_%+-]|\\.[\\p{L}\\p{N}])` : escaped(f)));
  return text.replace(new RegExp(alternatives.join("|"), "giu"), (m) => forms.get(m.toLowerCase())?.to ?? m);
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 8;
/** A label's shape as `draw` writes it, group 1 its type: the one pattern every reader of labels builds on. */
export const LABEL_SOURCE = `⟨([a-z]+)-[a-z0-9]{${ID_LENGTH}}⟩`;
/** Global: for `replace`, `match` and `matchAll` only (`test` and `exec` would keep its `lastIndex`). */
export const LABELS = new RegExp(LABEL_SOURCE, "g");
// 252 = 7 × 36: higher bytes are dropped so every character is equally likely.
const BYTE_LIMIT = 252;

const keyOf = (type: LabelType, canonical: string, zone: Zone, origin: string | null) =>
  JSON.stringify(zone === "sources" ? [zone, type, canonical] : [zone, type, canonical, origin]);

/**
 * The labels of one session. The sources zone gives one label per value, whatever the origin (a value of several
 * sources, a passport per login profile later, accumulates origins); the web zone gives one per value and origin, and
 * never the sources' label, so a page cannot learn a value by repeating it (spec § 5.3, the « ECB » case).
 */
export class LabelTable {
  private readonly byKey = new Map<string, Entry>();
  private readonly byLabel = new Map<string, Entry>();
  private readonly zones: Record<Zone, Entry[]> = { sources: [], web: [] };
  /** Masked address as emitted → the real one and the origin it was read on (spec § 5.3, opaque handles). */
  private readonly handles = new Map<string, { real: string; origin: string }>();
  /** Handles a load was sent to: their values reached their real address's origin. */
  private readonly sentHandles = new Map<string, Set<string>>();
  /** Tabs opened from a handle, until the agent sends them to an address that is not one. */
  private readonly pins = new Map<string, Pin>();
  /** `maskText`'s search index per zone (and web origin), kept until the zone gains an entry; wiped with the table. */
  readonly lookups = new Map<string, Lookup>();
  readonly passport: PassportStore | undefined;
  /** Some text was masked with this table (what marks a conversation « non couverte » on a new passport form). Internal comparisons set it too: it errs toward « non couverte ». */
  touched = false;
  private readonly resolvable: boolean;
  private readonly random: (n: number) => Uint8Array;

  /** `resolvable` false (the default, the main token's table): labels are issued but `resolve` gives nothing. */
  constructor(o: { resolvable?: boolean; random?: (n: number) => Uint8Array; passport?: PassportStore } = {}) {
    this.resolvable = o.resolvable ?? false;
    this.passport = o.passport;
    this.random = o.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  }

  label(type: LabelType, canonical: string, zone: Zone, origin: string | null, raw = canonical, ref?: PassportRef): string {
    const key = keyOf(type, canonical, zone, origin);
    let entry = this.byKey.get(key);
    if (!entry) {
      entry = { label: this.draw(type), type, value: canonical, raw, zone, origins: [] };
      this.byKey.set(key, entry);
      this.byLabel.set(entry.label, entry);
      this.zones[zone].push(entry);
    }
    if (origin !== null && !entry.origins.includes(origin)) entry.origins.push(origin);
    if (ref && !entry.passport?.some((r) => r.profile === ref.profile && r.id === ref.id)) (entry.passport ??= []).push({ ...ref });
    return entry.label;
  }

  /** The label `label` would give, if it is already issued: issues nothing. */
  labelOf(type: LabelType, canonical: string, zone: Zone, origin: string | null): string | undefined {
    return this.byKey.get(keyOf(type, canonical, zone, origin))?.label;
  }

  resolve(label: string): Entry | undefined {
    return this.resolvable ? this.byLabel.get(label) : undefined;
  }

  entries(zone: Zone): readonly Entry[] {
    return this.zones[zone];
  }

  issued(label: string): boolean {
    return this.byLabel.has(label);
  }

  /** Records that `masked` was emitted for the address `real`, read on `origin`; only a resolvable table issues handles. */
  handle(masked: string, real: string, origin: string): void {
    if (this.resolvable && !this.handles.has(masked)) this.handles.set(masked, { real, origin });
  }

  /** The real address behind a masked one exactly as emitted; nothing for any other string. */
  unhandle(url: string): { real: string; origin: string } | undefined {
    return this.resolvable ? this.handles.get(url) : undefined;
  }

  /** A load from the handle `masked` reached `origin` (its real address's, or one a granted redirect led to). */
  opened(masked: string, origin: string): void {
    if (!this.handles.has(masked)) return;
    const at = this.sentHandles.get(masked) ?? this.sentHandles.set(masked, new Set()).get(masked)!;
    at.add(origin);
  }

  /**
   * The entries behind the labels of every handle whose load reached `origin`: that origin's server got their values in the
   * address, so its pages showing them back (a bare-address title) tell it nothing when they are masked there. A handle
   * only shown, never opened, counts for nothing: masking a page's guess of it would be an oracle.
   */
  handledOn(origin: string): Entry[] {
    const out = new Set<Entry>();
    for (const [masked, reached] of this.sentHandles) {
      if (reached.has(origin))
        for (const m of masked.matchAll(LABELS)) {
          const e = this.byLabel.get(m[0]);
          if (e) out.add(e);
        }
    }
    return [...out];
  }

  /** The tab now shows `pin.real`, opened from `pin.handle` (undefined: from anything else, the pin goes). Only a resolvable table pins. */
  pin(tab: string, pin: Pin | undefined): void {
    if (pin && this.resolvable) this.pins.set(tab, pin);
    else this.pins.delete(tab);
  }

  pinned(tab: string): Pin | undefined {
    return this.pins.get(tab);
  }

  wipe(): void {
    this.lookups.clear();
    this.handles.clear();
    this.sentHandles.clear();
    this.pins.clear();
    this.byKey.clear();
    this.byLabel.clear();
    this.zones.sources = [];
    this.zones.web = [];
  }

  /** A fresh random label of `type`, redrawn while it collides with an issued one. */
  private draw(type: LabelType): string {
    for (;;) {
      let id = "";
      while (id.length < ID_LENGTH)
        for (const b of this.random(ID_LENGTH)) if (b < BYTE_LIMIT && id.length < ID_LENGTH) id += ALPHABET[b % ALPHABET.length];
      const label = `⟨${type}-${id}⟩`;
      if (!this.byLabel.has(label)) return label;
    }
  }
}
