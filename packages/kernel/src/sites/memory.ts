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
export const FIN_VIDEO = 0.95;
export const MEMORY_WRITE_MS = 500;
/** Maximum nesting of a kept value (arrays and objects). */
export const MEMORY_DEPTH_MAX = 32;
/** Number of nodes visited at most before refusing a value (bomb of shared references). */
const NODES_MAX = 200_000;
const URL_POSITION_MAX = 2048;

export const MEMORY_FULL = "Mémoire de l'appli pleine (256 Ko)";
export const VALEUR_NON_JSON = "Valeur refusée : JSON seulement";
export const KEY_INVALID = "Clé refusée : 1 à 200 caractères";

export type MemoryEntry = { valeur: unknown; adresse: string | null; quand: string };
export type PositionVideo = { t: number; duree: number; quand: string };
export type MemoryContent = {
  version: 1;
  valeurs: Record<string, MemoryEntry>;
  positions: Record<string, PositionVideo>;
};

const BASE_OCTETS = Buffer.byteLength('{"version":1,"valeurs":{},"positions":{}}');
const count = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const octets = (text: string) => Buffer.byteLength(text);
const sansPrototype = <T>() => Object.create(null) as Record<string, T>;

type Examen = "ok" | "non-json" | "pleine";

/** Iterative walk (never a call stack): depth, number of nodes and estimated size, before any stringify. */
function examiner(valeur: unknown): Examen {
  const pile: [unknown, number][] = [[valeur, 0]];
  let nodes = 0;
  let estimation = 0;
  while (pile.length > 0) {
    const [v, depth] = pile.pop()!;
    if (++nodes > NODES_MAX) return "pleine";
    if (typeof v === "string") {
      estimation += v.length;
    } else if (v !== null && typeof v === "object") {
      if (depth >= MEMORY_DEPTH_MAX) return "non-json";
      if (Array.isArray(v)) {
        estimation += v.length;
        if (v.length > NODES_MAX) return "pleine";
        for (const x of v) pile.push([x, depth + 1]);
      } else {
        for (const k of Object.keys(v)) {
          estimation += k.length;
          pile.push([(v as Record<string, unknown>)[k], depth + 1]);
        }
      }
    }
    if (estimation > SITE_MEMORY_SIZE) return "pleine";
  }
  return "ok";
}

/** JSON copy of a value, or the reason for the refusal. Never throws. */
function copierJson(valeur: unknown): { ok: true; copie: unknown; texte: string } | { ok: false; erreur: string } {
  try {
    const examen = examiner(valeur);
    if (examen === "pleine") return { ok: false, erreur: MEMORY_FULL };
    if (examen === "non-json") return { ok: false, erreur: VALEUR_NON_JSON };
    const text = JSON.stringify(valeur) as string | undefined;
    if (text === undefined) return { ok: false, erreur: VALEUR_NON_JSON };
    if (text.length > SITE_MEMORY_SIZE) return { ok: false, erreur: MEMORY_FULL };
    return { ok: true, copie: JSON.parse(text), texte: text };
  } catch {
    return { ok: false, erreur: VALEUR_NON_JSON };
  }
}

type SlotValeur = { e: MemoryEntry; taille: number };
type SlotPosition = { p: PositionVideo; taille: number };

const tailleValeur = (key: string, url: string | null, when: string, text: string) =>
  octets(JSON.stringify(key)) + 1 + octets(`{"valeur":,"adresse":${JSON.stringify(url)},"quand":${JSON.stringify(when)}}`) + octets(text) + 1;
const taillePosition = (key: string, p: PositionVideo) => octets(JSON.stringify(key)) + 1 + octets(JSON.stringify(p)) + 1;

/**
 * `<dossierSites>/<id>/memoire.json`, outside ~/WebAiOs. Written at most once per `ECRITURE_MEMOIRE_MS`.
 * A write that fails keeps the data in memory: the next change (or `vider()`) tries again.
 * The consumer must call `vider()` when the app closes, otherwise the pending deferred write is lost.
 */
export class SiteMemory {
  private valeurs = new Map<string, SlotValeur>();
  private positions = new Map<string, SlotPosition>();
  private total = BASE_OCTETS;
  private timer: NodeJS.Timeout | null = null;
  private chaine: Promise<void> = Promise.resolve();
  private rev = 0;
  private ecritRev = 0;
  private readonly ecouteurs = new Set<() => void>();

  private constructor(
    private readonly chemin: string,
    private readonly maintenant: () => string,
  ) {}

  static async ouvrir(dossierSites: string, id: string, options: { maintenant?: () => string } = {}): Promise<SiteMemory> {
    if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
    const path = join(dossierSites, id, "memoire.json");
    const m = new SiteMemory(path, options.maintenant ?? (() => new Date().toISOString()));
    try {
      if ((await stat(path)).size <= SITE_MEMORY_SIZE * 2) {
        const brut: unknown = JSON.parse(await readFile(path, "utf8"));
        const version = brut && typeof brut === "object" ? (brut as { version?: unknown }).version : undefined;
        if (version === 1) m.charger(brut as Record<string, unknown>);
        else if (brut && typeof brut === "object" && !Array.isArray(brut) && "version" in brut) {
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
  private charger(brut: Record<string, unknown>): void {
    const { valeurs, positions } = brut;
    if (valeurs && typeof valeurs === "object" && !Array.isArray(valeurs)) {
      for (const [k, e] of Object.entries(valeurs)) {
        const x = e as Partial<MemoryEntry> | null;
        if (k.length < 1 || k.length > KEY_MAX || !x || typeof x !== "object" || !("valeur" in x)) continue;
        if (typeof x.quand !== "string" || (x.adresse !== null && typeof x.adresse !== "string")) continue;
        const c = copierJson(x.valeur);
        if (!c.ok) continue;
        const taille = tailleValeur(k, x.adresse, x.quand, c.texte);
        if (this.total + taille > SITE_MEMORY_SIZE) continue;
        this.valeurs.set(k, { e: { valeur: c.copie, adresse: x.adresse, quand: x.quand }, taille });
        this.total += taille;
      }
    }
    if (positions && typeof positions === "object" && !Array.isArray(positions)) {
      const lues: [string, PositionVideo][] = [];
      for (const [k, p] of Object.entries(positions)) {
        const x = p as Partial<PositionVideo> | null;
        if (k.length < 1 || k.length > URL_POSITION_MAX) continue;
        if (!x || typeof x !== "object" || !count(x.t) || !count(x.duree) || typeof x.quand !== "string") continue;
        lues.push([k, { t: x.t, duree: x.duree, quand: x.quand }]);
      }
      const recent = lues.map((l, i) => ({ l, i })).sort((a, b) => (a.l[1].quand < b.l[1].quand ? 1 : a.l[1].quand > b.l[1].quand ? -1 : b.i - a.i));
      const kept: [string, PositionVideo, number][] = [];
      for (const { l: [k, p] } of recent.slice(0, POSITIONS_MAX)) {
        const taille = taillePosition(k, p);
        if (this.total + taille > SITE_MEMORY_SIZE) continue;
        this.total += taille;
        kept.push([k, p, taille]);
      }
      for (const [k, p, taille] of kept.reverse()) this.positions.set(k, { p, taille });
    }
  }

  /**
   * Positions to forget (the oldest by `quand`, never `sauf`) so that `ajout` more bytes fit,
   * or null if even without positions it does not fit. Changes nothing.
   */
  private evincer(addition: number, sauf: string | null, maxPositions: boolean): string[] | null {
    const candidates = [...this.positions.entries()].map(([k, s], i) => ({ k, q: s.p.quand, t: s.taille, i })).filter((c) => c.k !== sauf);
    const dehors: string[] = [];
    let total = this.total + addition;
    let remaining = this.positions.size + (maxPositions ? 1 : 0);
    if (total <= SITE_MEMORY_SIZE && remaining <= POSITIONS_MAX) return dehors;
    candidates.sort((a, b) => (a.q < b.q ? -1 : a.q > b.q ? 1 : a.i - b.i));
    for (const c of candidates) {
      if (total <= SITE_MEMORY_SIZE && remaining <= POSITIONS_MAX) break;
      dehors.push(c.k);
      total -= c.t;
      remaining--;
    }
    return total <= SITE_MEMORY_SIZE && remaining <= POSITIONS_MAX ? dehors : null;
  }

  private oublierPositions(keys: string[]): void {
    for (const k of keys) {
      this.total -= this.positions.get(k)!.taille;
      this.positions.delete(k);
    }
  }

  retenir(key: string, valeur: unknown, url: string | null): { ok: true } | { ok: false; erreur: string } {
    try {
      if (typeof key !== "string" || key.length < 1 || key.length > KEY_MAX) return { ok: false, erreur: KEY_INVALID };
      if (url !== null && (typeof url !== "string" || url.length > URL_POSITION_MAX)) return { ok: false, erreur: VALEUR_NON_JSON };
      const c = copierJson(valeur);
      if (!c.ok) return c;
      const when = this.maintenant();
      const taille = tailleValeur(key, url, when, c.texte);
      const old = this.valeurs.get(key)?.taille ?? 0;
      const dehors = this.evincer(taille - old, null, false);
      if (!dehors) return { ok: false, erreur: MEMORY_FULL };
      this.oublierPositions(dehors);
      this.valeurs.set(key, { e: { valeur: c.copie, adresse: url, quand: when }, taille });
      this.total += taille - old;
      this.changer();
      return { ok: true };
    } catch {
      return { ok: false, erreur: VALEUR_NON_JSON };
    }
  }

  lire(key: string): unknown | null {
    const s = this.valeurs.get(key);
    return s === undefined ? null : structuredClone(s.e.valeur);
  }

  oublier(key: string): void {
    const s = this.valeurs.get(key);
    if (!s) return;
    this.valeurs.delete(key);
    this.total -= s.taille;
    this.changer();
  }

  noterPosition(url: string, t: number, duration: number): void {
    try {
      if (typeof url !== "string" || url.length < 1 || url.length > URL_POSITION_MAX) return;
      if (!count(t) || !count(duration) || duration <= 0 || t < 0) return;
      const old = this.positions.get(url);
      if (t / duration >= FIN_VIDEO) {
        if (!old) return;
        this.total -= old.taille;
        this.positions.delete(url);
      } else {
        const p = { t, duree: duration, quand: this.maintenant() };
        const taille = taillePosition(url, p);
        const dehors = this.evincer(taille - (old?.taille ?? 0), url, !old);
        if (!dehors) return;
        this.oublierPositions(dehors);
        if (old) this.total -= old.taille;
        this.positions.delete(url);
        this.positions.set(url, { p, taille });
        this.total += taille;
      }
      this.changer();
    } catch {
      // a position is a convenience: never an exception to the caller
    }
  }

  position(url: string): PositionVideo | null {
    const s = this.positions.get(url);
    return s ? { ...s.p } : null;
  }

  /** A copy of the content: modifying it changes nothing in the memory. */
  contenu(): MemoryContent {
    const c: MemoryContent = { version: 1, valeurs: sansPrototype(), positions: sansPrototype() };
    for (const [k, s] of this.valeurs) c.valeurs[k] = structuredClone(s.e);
    for (const [k, s] of this.positions) c.positions[k] = { ...s.p };
    return c;
  }

  surChange(r: () => void): () => void {
    this.ecouteurs.add(r);
    return () => void this.ecouteurs.delete(r);
  }

  /** Writes right away what is not yet written and waits for the writes to end. To call at closing. */
  async vider(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ecritRev !== this.rev) this.programmerEcriture();
    await this.chaine;
  }

  /** Forgets everything: pending write cancelled, file deleted, subscribers notified. */
  async effacer(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.valeurs = new Map();
    this.positions = new Map();
    this.total = BASE_OCTETS;
    const rev = ++this.rev;
    this.chaine = this.chaine
      .then(async () => {
        await rm(this.chemin, { force: true });
        this.ecritRev = rev;
      })
      .catch(() => {});
    this.prevenir();
    await this.chaine;
  }

  private changer(): void {
    this.rev++;
    this.prevenir();
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.programmerEcriture();
    }, MEMORY_WRITE_MS);
    this.timer.unref();
  }

  private programmerEcriture(): void {
    this.chaine = this.chaine
      .then(async () => {
        const rev = this.rev;
        if (this.ecritRev === rev) return;
        const c = this.contenu();
        await writeAtomic(this.chemin, JSON.stringify(c));
        this.ecritRev = rev;
      })
      .catch(() => {
        // data kept in memory (ecritRev unchanged): the next change or vider() tries again
      });
  }

  private prevenir(): void {
    for (const r of [...this.ecouteurs]) {
      try {
        r();
      } catch {
        // a subscriber that fails does not bother the others
      }
    }
  }
}
