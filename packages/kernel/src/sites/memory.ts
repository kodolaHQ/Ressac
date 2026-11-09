import { readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../workflows/executions.js";
import { ID_SITE } from "./schemas.js";

/** First name `<base>.bak`, `<base>.1.bak`… that does not exist yet (a backup never overwrites another). */
async function freeName(base: string): Promise<string | null> {
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? `${base}.bak` : `${base}.${i}.bak`;
    if (!(await stat(name).then(() => true, () => false))) return name;
  }
  return null;
}

export const SITE_MEMORY_SIZE = 256 * 1024;
export const POSITIONS_MAX = 500;
export const KEY_MAX = 200;
export const VIDEO_END = 0.95;
export const MEMORY_WRITE_MS = 500;
/** Maximum nesting of a kept value (arrays and objects). */
export const MEMORY_DEPTH_MAX = 32;
/** Number of nodes visited at most before refusing a value (bomb of shared references). */
const NODES_MAX = 200_000;
const URL_POSITION_MAX = 2048;

export const MEMORY_FULL = "Mémoire de l'appli pleine (256 Ko)";
export const NON_JSON_VALUE = "Valeur refusée : JSON seulement";
export const KEY_INVALID = "Clé refusée : 1 à 200 caractères";

export type MemoryEntry = { value: unknown; url: string | null; when: string };
export type PositionVideo = { t: number; duration: number; when: string };
export type MemoryContent = {
  version: 1;
  values: Record<string, MemoryEntry>;
  positions: Record<string, PositionVideo>;
};

const BASE_BYTES = Buffer.byteLength('{"version":1,"values":{},"positions":{}}');
const count = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const bytes = (text: string) => Buffer.byteLength(text);
const withoutPrototype = <T>() => Object.create(null) as Record<string, T>;

type Assessment = "ok" | "non-json" | "pleine";

/** Iterative walk (never a call stack): depth, number of nodes and estimated size, before any stringify. */
function assess(value: unknown): Assessment {
  const stack: [unknown, number][] = [[value, 0]];
  let nodes = 0;
  let estimation = 0;
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (++nodes > NODES_MAX) return "pleine";
    if (typeof v === "string") {
      estimation += v.length;
    } else if (v !== null && typeof v === "object") {
      if (depth >= MEMORY_DEPTH_MAX) return "non-json";
      if (Array.isArray(v)) {
        estimation += v.length;
        if (v.length > NODES_MAX) return "pleine";
        for (const x of v) stack.push([x, depth + 1]);
      } else {
        for (const k of Object.keys(v)) {
          estimation += k.length;
          stack.push([(v as Record<string, unknown>)[k], depth + 1]);
        }
      }
    }
    if (estimation > SITE_MEMORY_SIZE) return "pleine";
  }
  return "ok";
}

/** JSON copy of a value, or the reason for the refusal. Never throws. */
function copyJson(value: unknown): { ok: true; copy: unknown; text: string } | { ok: false; error: string } {
  try {
    const assessment = assess(value);
    if (assessment === "pleine") return { ok: false, error: MEMORY_FULL };
    if (assessment === "non-json") return { ok: false, error: NON_JSON_VALUE };
    const text = JSON.stringify(value) as string | undefined;
    if (text === undefined) return { ok: false, error: NON_JSON_VALUE };
    if (text.length > SITE_MEMORY_SIZE) return { ok: false, error: MEMORY_FULL };
    return { ok: true, copy: JSON.parse(text), text: text };
  } catch {
    return { ok: false, error: NON_JSON_VALUE };
  }
}

type ValueSlot = { e: MemoryEntry; size: number };
type SlotPosition = { p: PositionVideo; size: number };

const valueSize = (key: string, url: string | null, when: string, text: string) =>
  bytes(JSON.stringify(key)) + 1 + bytes(`{"value":,"url":${JSON.stringify(url)},"when":${JSON.stringify(when)}}`) + bytes(text) + 1;
const positionSize = (key: string, p: PositionVideo) => bytes(JSON.stringify(key)) + 1 + bytes(JSON.stringify(p)) + 1;

/**
 * `<sitesFolder>/<id>/memory.json`, outside ~/WebAiOs. Written at most once per `ECRITURE_MEMOIRE_MS`.
 * A write that fails keeps the data in memory: the next change (or `vider()`) tries again.
 * The consumer must call `vider()` when the app closes, otherwise the pending deferred write is lost.
 */
export class SiteMemory {
  private values = new Map<string, ValueSlot>();
  private positions = new Map<string, SlotPosition>();
  private total = BASE_BYTES;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private rev = 0;
  private writeRev = 0;
  private readonly listeners = new Set<() => void>();

  private constructor(
    private readonly path: string,
    private readonly now: () => string,
  ) {}

  static async open(sitesFolder: string, id: string, options: { now?: () => string } = {}): Promise<SiteMemory> {
    if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
    const path = join(sitesFolder, id, "memory.json");
    const m = new SiteMemory(path, options.now ?? (() => new Date().toISOString()));
    try {
      if ((await stat(path)).size <= SITE_MEMORY_SIZE * 2) {
        const raw: unknown = JSON.parse(await readFile(path, "utf8"));
        const version = raw && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
        if (version === 1) m.load(raw as Record<string, unknown>);
        else if (raw && typeof raw === "object" && !Array.isArray(raw) && "version" in raw) {
          const n = /^[A-Za-z0-9]{1,10}$/.test(String(version)) ? String(version) : "x";
          const free = await freeName(`${path}.v${n}`);
          if (free) await rename(path, free).catch(() => {});
        }
      }
    } catch {
      // absent, too big or damaged: empty memory
    }
    return m;
  }

  /** Re-reads a file re-imposing all the bounds; what exceeds them is dropped. */
  private load(raw: Record<string, unknown>): void {
    const { values, positions } = raw;
    if (values && typeof values === "object" && !Array.isArray(values)) {
      for (const [k, e] of Object.entries(values)) {
        const x = e as Partial<MemoryEntry> | null;
        if (k.length < 1 || k.length > KEY_MAX || !x || typeof x !== "object" || !("value" in x)) continue;
        if (typeof x.when !== "string" || (x.url !== null && typeof x.url !== "string")) continue;
        const c = copyJson(x.value);
        if (!c.ok) continue;
        const size = valueSize(k, x.url, x.when, c.text);
        if (this.total + size > SITE_MEMORY_SIZE) continue;
        this.values.set(k, { e: { value: c.copy, url: x.url, when: x.when }, size: size });
        this.total += size;
      }
    }
    if (positions && typeof positions === "object" && !Array.isArray(positions)) {
      const alreadyRead: [string, PositionVideo][] = [];
      for (const [k, p] of Object.entries(positions)) {
        const x = p as Partial<PositionVideo> | null;
        if (k.length < 1 || k.length > URL_POSITION_MAX) continue;
        if (!x || typeof x !== "object" || !count(x.t) || !count(x.duration) || typeof x.when !== "string") continue;
        alreadyRead.push([k, { t: x.t, duration: x.duration, when: x.when }]);
      }
      const recent = alreadyRead.map((l, i) => ({ l, i })).sort((a, b) => (a.l[1].when < b.l[1].when ? 1 : a.l[1].when > b.l[1].when ? -1 : b.i - a.i));
      const kept: [string, PositionVideo, number][] = [];
      for (const { l: [k, p] } of recent.slice(0, POSITIONS_MAX)) {
        const size = positionSize(k, p);
        if (this.total + size > SITE_MEMORY_SIZE) continue;
        this.total += size;
        kept.push([k, p, size]);
      }
      for (const [k, p, size] of kept.reverse()) this.positions.set(k, { p, size: size });
    }
  }

  /**
   * Positions to forget (the oldest by `quand`, never `sauf`) so that `ajout` more bytes fit,
   * or null if even without positions it does not fit. Changes nothing.
   */
  private evict(addition: number, except: string | null, maxPositions: boolean): string[] | null {
    const candidates = [...this.positions.entries()].map(([k, s], i) => ({ k, q: s.p.when, t: s.size, i })).filter((c) => c.k !== except);
    const outside: string[] = [];
    let total = this.total + addition;
    let remaining = this.positions.size + (maxPositions ? 1 : 0);
    if (total <= SITE_MEMORY_SIZE && remaining <= POSITIONS_MAX) return outside;
    candidates.sort((a, b) => (a.q < b.q ? -1 : a.q > b.q ? 1 : a.i - b.i));
    for (const c of candidates) {
      if (total <= SITE_MEMORY_SIZE && remaining <= POSITIONS_MAX) break;
      outside.push(c.k);
      total -= c.t;
      remaining--;
    }
    return total <= SITE_MEMORY_SIZE && remaining <= POSITIONS_MAX ? outside : null;
  }

  private forgetPositions(keys: string[]): void {
    for (const k of keys) {
      this.total -= this.positions.get(k)!.size;
      this.positions.delete(k);
    }
  }

  keep(key: string, value: unknown, url: string | null): { ok: true } | { ok: false; error: string } {
    try {
      if (typeof key !== "string" || key.length < 1 || key.length > KEY_MAX) return { ok: false, error: KEY_INVALID };
      if (url !== null && (typeof url !== "string" || url.length > URL_POSITION_MAX)) return { ok: false, error: NON_JSON_VALUE };
      const c = copyJson(value);
      if (!c.ok) return c;
      const when = this.now();
      const size = valueSize(key, url, when, c.text);
      const old = this.values.get(key)?.size ?? 0;
      const outside = this.evict(size - old, null, false);
      if (!outside) return { ok: false, error: MEMORY_FULL };
      this.forgetPositions(outside);
      this.values.set(key, { e: { value: c.copy, url: url, when: when }, size: size });
      this.total += size - old;
      this.change();
      return { ok: true };
    } catch {
      return { ok: false, error: NON_JSON_VALUE };
    }
  }

  read(key: string): unknown | null {
    const s = this.values.get(key);
    return s === undefined ? null : structuredClone(s.e.value);
  }

  forget(key: string): void {
    const s = this.values.get(key);
    if (!s) return;
    this.values.delete(key);
    this.total -= s.size;
    this.change();
  }

  notePosition(url: string, t: number, duration: number): void {
    try {
      if (typeof url !== "string" || url.length < 1 || url.length > URL_POSITION_MAX) return;
      if (!count(t) || !count(duration) || duration <= 0 || t < 0) return;
      const old = this.positions.get(url);
      if (t / duration >= VIDEO_END) {
        if (!old) return;
        this.total -= old.size;
        this.positions.delete(url);
      } else {
        const p = { t, duration: duration, when: this.now() };
        const size = positionSize(url, p);
        const outside = this.evict(size - (old?.size ?? 0), url, !old);
        if (!outside) return;
        this.forgetPositions(outside);
        if (old) this.total -= old.size;
        this.positions.delete(url);
        this.positions.set(url, { p, size: size });
        this.total += size;
      }
      this.change();
    } catch {
      // a position is a convenience: never an exception to the caller
    }
  }

  position(url: string): PositionVideo | null {
    const s = this.positions.get(url);
    return s ? { ...s.p } : null;
  }

  /** A copy of the content: modifying it changes nothing in the memory. */
  content(): MemoryContent {
    const c: MemoryContent = { version: 1, values: withoutPrototype(), positions: withoutPrototype() };
    for (const [k, s] of this.values) c.values[k] = structuredClone(s.e);
    for (const [k, s] of this.positions) c.positions[k] = { ...s.p };
    return c;
  }

  onChange(r: () => void): () => void {
    this.listeners.add(r);
    return () => void this.listeners.delete(r);
  }

  /** Writes right away what is not yet written and waits for the writes to end. To call at closing. */
  async clear(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.writeRev !== this.rev) this.scheduleWrite();
    await this.chain;
  }

  /** Forgets everything: pending write cancelled, file deleted, subscribers notified. */
  async erase(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.values = new Map();
    this.positions = new Map();
    this.total = BASE_BYTES;
    const rev = ++this.rev;
    this.chain = this.chain
      .then(async () => {
        await rm(this.path, { force: true });
        this.writeRev = rev;
      })
      .catch(() => {});
    this.notify();
    await this.chain;
  }

  private change(): void {
    this.rev++;
    this.notify();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduleWrite();
    }, MEMORY_WRITE_MS);
    this.timer.unref();
  }

  private scheduleWrite(): void {
    this.chain = this.chain
      .then(async () => {
        const rev = this.rev;
        if (this.writeRev === rev) return;
        const c = this.content();
        await writeAtomic(this.path, JSON.stringify(c));
        this.writeRev = rev;
      })
      .catch(() => {
        // data kept in memory (ecritRev unchanged): the next change or vider() tries again
      });
  }

  private notify(): void {
    for (const r of [...this.listeners]) {
      try {
        r();
      } catch {
        // a subscriber that fails does not bother the others
      }
    }
  }
}
