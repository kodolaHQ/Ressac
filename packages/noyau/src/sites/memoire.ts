import { readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ecrireAtomique } from "../workflows/executions.js";
import { ID_SITE } from "./schemas.js";

/** First name `<base>.bak`, `<base>.1.bak`… that does not exist yet (a backup never overwrites another). */
async function nomLibre(base: string): Promise<string | null> {
  for (let i = 0; i < 100; i++) {
    const nom = i === 0 ? `${base}.bak` : `${base}.${i}.bak`;
    if (!(await stat(nom).then(() => true, () => false))) return nom;
  }
  return null;
}

export const TAILLE_MEMOIRE_SITE = 256 * 1024;
export const POSITIONS_MAX = 500;
export const CLE_MAX = 200;
export const FIN_VIDEO = 0.95;
export const ECRITURE_MEMOIRE_MS = 500;
/** Maximum nesting of a kept value (arrays and objects). */
export const PROFONDEUR_MEMOIRE_MAX = 32;
/** Number of nodes visited at most before refusing a value (bomb of shared references). */
const NOEUDS_MAX = 200_000;
const ADRESSE_POSITION_MAX = 2048;

export const MEMOIRE_PLEINE = "Mémoire de l'appli pleine (256 Ko)";
export const VALEUR_NON_JSON = "Valeur refusée : JSON seulement";
export const CLE_INVALIDE = "Clé refusée : 1 à 200 caractères";

export type EntreeMemoire = { valeur: unknown; adresse: string | null; quand: string };
export type PositionVideo = { t: number; duree: number; quand: string };
export type ContenuMemoire = {
  version: 1;
  valeurs: Record<string, EntreeMemoire>;
  positions: Record<string, PositionVideo>;
};

const BASE_OCTETS = Buffer.byteLength('{"version":1,"valeurs":{},"positions":{}}');
const nombre = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const octets = (texte: string) => Buffer.byteLength(texte);
const sansPrototype = <T>() => Object.create(null) as Record<string, T>;

type Examen = "ok" | "non-json" | "pleine";

/** Iterative walk (never a call stack): depth, number of nodes and estimated size, before any stringify. */
function examiner(valeur: unknown): Examen {
  const pile: [unknown, number][] = [[valeur, 0]];
  let noeuds = 0;
  let estimation = 0;
  while (pile.length > 0) {
    const [v, profondeur] = pile.pop()!;
    if (++noeuds > NOEUDS_MAX) return "pleine";
    if (typeof v === "string") {
      estimation += v.length;
    } else if (v !== null && typeof v === "object") {
      if (profondeur >= PROFONDEUR_MEMOIRE_MAX) return "non-json";
      if (Array.isArray(v)) {
        estimation += v.length;
        if (v.length > NOEUDS_MAX) return "pleine";
        for (const x of v) pile.push([x, profondeur + 1]);
      } else {
        for (const k of Object.keys(v)) {
          estimation += k.length;
          pile.push([(v as Record<string, unknown>)[k], profondeur + 1]);
        }
      }
    }
    if (estimation > TAILLE_MEMOIRE_SITE) return "pleine";
  }
  return "ok";
}

/** JSON copy of a value, or the reason for the refusal. Never throws. */
function copierJson(valeur: unknown): { ok: true; copie: unknown; texte: string } | { ok: false; erreur: string } {
  try {
    const examen = examiner(valeur);
    if (examen === "pleine") return { ok: false, erreur: MEMOIRE_PLEINE };
    if (examen === "non-json") return { ok: false, erreur: VALEUR_NON_JSON };
    const texte = JSON.stringify(valeur) as string | undefined;
    if (texte === undefined) return { ok: false, erreur: VALEUR_NON_JSON };
    if (texte.length > TAILLE_MEMOIRE_SITE) return { ok: false, erreur: MEMOIRE_PLEINE };
    return { ok: true, copie: JSON.parse(texte), texte };
  } catch {
    return { ok: false, erreur: VALEUR_NON_JSON };
  }
}

type SlotValeur = { e: EntreeMemoire; taille: number };
type SlotPosition = { p: PositionVideo; taille: number };

const tailleValeur = (cle: string, adresse: string | null, quand: string, texte: string) =>
  octets(JSON.stringify(cle)) + 1 + octets(`{"valeur":,"adresse":${JSON.stringify(adresse)},"quand":${JSON.stringify(quand)}}`) + octets(texte) + 1;
const taillePosition = (cle: string, p: PositionVideo) => octets(JSON.stringify(cle)) + 1 + octets(JSON.stringify(p)) + 1;

/**
 * `<dossierSites>/<id>/memoire.json`, outside ~/WebAiOs. Written at most once per `ECRITURE_MEMOIRE_MS`.
 * A write that fails keeps the data in memory: the next change (or `vider()`) tries again.
 * The consumer must call `vider()` when the app closes, otherwise the pending deferred write is lost.
 */
export class MemoireSite {
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

  static async ouvrir(dossierSites: string, id: string, options: { maintenant?: () => string } = {}): Promise<MemoireSite> {
    if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
    const chemin = join(dossierSites, id, "memoire.json");
    const m = new MemoireSite(chemin, options.maintenant ?? (() => new Date().toISOString()));
    try {
      if ((await stat(chemin)).size <= TAILLE_MEMOIRE_SITE * 2) {
        const brut: unknown = JSON.parse(await readFile(chemin, "utf8"));
        const version = brut && typeof brut === "object" ? (brut as { version?: unknown }).version : undefined;
        if (version === 1) m.charger(brut as Record<string, unknown>);
        else if (brut && typeof brut === "object" && !Array.isArray(brut) && "version" in brut) {
          const n = /^[A-Za-z0-9]{1,10}$/.test(String(version)) ? String(version) : "x";
          const libre = await nomLibre(`${chemin}.v${n}`);
          if (libre) await rename(chemin, libre).catch(() => {});
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
        const x = e as Partial<EntreeMemoire> | null;
        if (k.length < 1 || k.length > CLE_MAX || !x || typeof x !== "object" || !("valeur" in x)) continue;
        if (typeof x.quand !== "string" || (x.adresse !== null && typeof x.adresse !== "string")) continue;
        const c = copierJson(x.valeur);
        if (!c.ok) continue;
        const taille = tailleValeur(k, x.adresse, x.quand, c.texte);
        if (this.total + taille > TAILLE_MEMOIRE_SITE) continue;
        this.valeurs.set(k, { e: { valeur: c.copie, adresse: x.adresse, quand: x.quand }, taille });
        this.total += taille;
      }
    }
    if (positions && typeof positions === "object" && !Array.isArray(positions)) {
      const lues: [string, PositionVideo][] = [];
      for (const [k, p] of Object.entries(positions)) {
        const x = p as Partial<PositionVideo> | null;
        if (k.length < 1 || k.length > ADRESSE_POSITION_MAX) continue;
        if (!x || typeof x !== "object" || !nombre(x.t) || !nombre(x.duree) || typeof x.quand !== "string") continue;
        lues.push([k, { t: x.t, duree: x.duree, quand: x.quand }]);
      }
      const recentes = lues.map((l, i) => ({ l, i })).sort((a, b) => (a.l[1].quand < b.l[1].quand ? 1 : a.l[1].quand > b.l[1].quand ? -1 : b.i - a.i));
      const gardees: [string, PositionVideo, number][] = [];
      for (const { l: [k, p] } of recentes.slice(0, POSITIONS_MAX)) {
        const taille = taillePosition(k, p);
        if (this.total + taille > TAILLE_MEMOIRE_SITE) continue;
        this.total += taille;
        gardees.push([k, p, taille]);
      }
      for (const [k, p, taille] of gardees.reverse()) this.positions.set(k, { p, taille });
    }
  }

  /**
   * Positions to forget (the oldest by `quand`, never `sauf`) so that `ajout` more bytes fit,
   * or null if even without positions it does not fit. Changes nothing.
   */
  private evincer(ajout: number, sauf: string | null, maxPositions: boolean): string[] | null {
    const candidats = [...this.positions.entries()].map(([k, s], i) => ({ k, q: s.p.quand, t: s.taille, i })).filter((c) => c.k !== sauf);
    const dehors: string[] = [];
    let total = this.total + ajout;
    let restantes = this.positions.size + (maxPositions ? 1 : 0);
    if (total <= TAILLE_MEMOIRE_SITE && restantes <= POSITIONS_MAX) return dehors;
    candidats.sort((a, b) => (a.q < b.q ? -1 : a.q > b.q ? 1 : a.i - b.i));
    for (const c of candidats) {
      if (total <= TAILLE_MEMOIRE_SITE && restantes <= POSITIONS_MAX) break;
      dehors.push(c.k);
      total -= c.t;
      restantes--;
    }
    return total <= TAILLE_MEMOIRE_SITE && restantes <= POSITIONS_MAX ? dehors : null;
  }

  private oublierPositions(cles: string[]): void {
    for (const k of cles) {
      this.total -= this.positions.get(k)!.taille;
      this.positions.delete(k);
    }
  }

  retenir(cle: string, valeur: unknown, adresse: string | null): { ok: true } | { ok: false; erreur: string } {
    try {
      if (typeof cle !== "string" || cle.length < 1 || cle.length > CLE_MAX) return { ok: false, erreur: CLE_INVALIDE };
      if (adresse !== null && (typeof adresse !== "string" || adresse.length > ADRESSE_POSITION_MAX)) return { ok: false, erreur: VALEUR_NON_JSON };
      const c = copierJson(valeur);
      if (!c.ok) return c;
      const quand = this.maintenant();
      const taille = tailleValeur(cle, adresse, quand, c.texte);
      const ancien = this.valeurs.get(cle)?.taille ?? 0;
      const dehors = this.evincer(taille - ancien, null, false);
      if (!dehors) return { ok: false, erreur: MEMOIRE_PLEINE };
      this.oublierPositions(dehors);
      this.valeurs.set(cle, { e: { valeur: c.copie, adresse, quand }, taille });
      this.total += taille - ancien;
      this.changer();
      return { ok: true };
    } catch {
      return { ok: false, erreur: VALEUR_NON_JSON };
    }
  }

  lire(cle: string): unknown | null {
    const s = this.valeurs.get(cle);
    return s === undefined ? null : structuredClone(s.e.valeur);
  }

  oublier(cle: string): void {
    const s = this.valeurs.get(cle);
    if (!s) return;
    this.valeurs.delete(cle);
    this.total -= s.taille;
    this.changer();
  }

  noterPosition(adresse: string, t: number, duree: number): void {
    try {
      if (typeof adresse !== "string" || adresse.length < 1 || adresse.length > ADRESSE_POSITION_MAX) return;
      if (!nombre(t) || !nombre(duree) || duree <= 0 || t < 0) return;
      const ancien = this.positions.get(adresse);
      if (t / duree >= FIN_VIDEO) {
        if (!ancien) return;
        this.total -= ancien.taille;
        this.positions.delete(adresse);
      } else {
        const p = { t, duree, quand: this.maintenant() };
        const taille = taillePosition(adresse, p);
        const dehors = this.evincer(taille - (ancien?.taille ?? 0), adresse, !ancien);
        if (!dehors) return;
        this.oublierPositions(dehors);
        if (ancien) this.total -= ancien.taille;
        this.positions.delete(adresse);
        this.positions.set(adresse, { p, taille });
        this.total += taille;
      }
      this.changer();
    } catch {
      // a position is a convenience: never an exception to the caller
    }
  }

  position(adresse: string): PositionVideo | null {
    const s = this.positions.get(adresse);
    return s ? { ...s.p } : null;
  }

  /** A copy of the content: modifying it changes nothing in the memory. */
  contenu(): ContenuMemoire {
    const c: ContenuMemoire = { version: 1, valeurs: sansPrototype(), positions: sansPrototype() };
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
    }, ECRITURE_MEMOIRE_MS);
    this.timer.unref();
  }

  private programmerEcriture(): void {
    this.chaine = this.chaine
      .then(async () => {
        const rev = this.rev;
        if (this.ecritRev === rev) return;
        const c = this.contenu();
        await ecrireAtomique(this.chemin, JSON.stringify(c));
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
