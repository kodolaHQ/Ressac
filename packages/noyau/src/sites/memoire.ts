import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ecrireAtomique } from "../workflows/executions.js";
import { ID_SITE } from "./schemas.js";

export const TAILLE_MEMOIRE_SITE = 256 * 1024;
export const POSITIONS_MAX = 500;
export const CLE_MAX = 200;
export const FIN_VIDEO = 0.95;
export const ECRITURE_MEMOIRE_MS = 500;

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

const vide = (): ContenuMemoire => ({ version: 1, valeurs: Object.create(null), positions: Object.create(null) });
const nombre = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const octets = (c: ContenuMemoire) => Buffer.byteLength(JSON.stringify(c));

/** Relit un fichier : tout ce qui n'a pas la bonne forme est ignoré, jamais de plantage. */
function lireContenu(texte: string): ContenuMemoire {
  const c = vide();
  try {
    const brut: unknown = JSON.parse(texte);
    if (!brut || typeof brut !== "object" || (brut as { version?: unknown }).version !== 1) return c;
    const { valeurs, positions } = brut as { valeurs?: unknown; positions?: unknown };
    if (!valeurs || typeof valeurs !== "object" || Array.isArray(valeurs)) return c;
    if (!positions || typeof positions !== "object" || Array.isArray(positions)) return c;
    for (const [k, e] of Object.entries(valeurs)) {
      const x = e as Partial<EntreeMemoire> | null;
      if (k.length < 1 || k.length > CLE_MAX || !x || typeof x !== "object" || !("valeur" in x)) continue;
      if (typeof x.quand !== "string" || (x.adresse !== null && typeof x.adresse !== "string")) continue;
      c.valeurs[k] = { valeur: x.valeur, adresse: x.adresse, quand: x.quand };
    }
    for (const [k, p] of Object.entries(positions)) {
      const x = p as Partial<PositionVideo> | null;
      if (!x || typeof x !== "object" || !nombre(x.t) || !nombre(x.duree) || typeof x.quand !== "string") continue;
      c.positions[k] = { t: x.t, duree: x.duree, quand: x.quand };
    }
  } catch {
    return vide();
  }
  return c;
}

/** Garde les `POSITIONS_MAX` plus récentes (égalité : l'ordre d'insertion). */
function elaguerPositions(c: ContenuMemoire): void {
  const cles = Object.keys(c.positions);
  if (cles.length <= POSITIONS_MAX) return;
  const tries = cles.map((k, i) => ({ k, i })).sort((a, b) => {
    const qa = c.positions[a.k]!.quand;
    const qb = c.positions[b.k]!.quand;
    return qa < qb ? -1 : qa > qb ? 1 : a.i - b.i;
  });
  for (const { k } of tries.slice(0, cles.length - POSITIONS_MAX)) delete c.positions[k];
}

/** `<dossierSites>/<id>/memoire.json`, hors de ~/WebAiOs. Écrite au plus une fois par `ECRITURE_MEMOIRE_MS`. */
export class MemoireSite {
  private c: ContenuMemoire;
  private timer: NodeJS.Timeout | null = null;
  private chaine: Promise<void> = Promise.resolve();
  private readonly ecouteurs = new Set<() => void>();

  private constructor(
    private readonly chemin: string,
    c: ContenuMemoire,
    private readonly maintenant: () => string,
  ) {
    this.c = c;
  }

  static async ouvrir(dossierSites: string, id: string, options: { maintenant?: () => string } = {}): Promise<MemoireSite> {
    if (!ID_SITE.test(id)) throw new Error(`id d'appli de site invalide : ${id}`);
    const chemin = join(dossierSites, id, "memoire.json");
    let c = vide();
    try {
      if ((await stat(chemin)).size <= TAILLE_MEMOIRE_SITE * 2) c = lireContenu(await readFile(chemin, "utf8"));
    } catch {
      // absent ou illisible : mémoire vide
    }
    return new MemoireSite(chemin, c, options.maintenant ?? (() => new Date().toISOString()));
  }

  retenir(cle: string, valeur: unknown, adresse: string | null): { ok: true } | { ok: false; erreur: string } {
    if (typeof cle !== "string" || cle.length < 1 || cle.length > CLE_MAX) return { ok: false, erreur: CLE_INVALIDE };
    let copie: unknown;
    try {
      const texte = JSON.stringify(valeur) as string | undefined;
      if (texte === undefined) return { ok: false, erreur: VALEUR_NON_JSON };
      copie = JSON.parse(texte);
    } catch {
      return { ok: false, erreur: VALEUR_NON_JSON };
    }
    const essai: ContenuMemoire = { version: 1, valeurs: Object.assign(Object.create(null), this.c.valeurs), positions: Object.assign(Object.create(null), this.c.positions) };
    delete essai.valeurs[cle];
    essai.valeurs[cle] = { valeur: copie, adresse, quand: this.maintenant() };
    if (octets(essai) > TAILLE_MEMOIRE_SITE) {
      const anciennes = Object.keys(essai.positions)
        .map((k, i) => ({ k, i }))
        .sort((a, b) => {
          const qa = essai.positions[a.k]!.quand;
          const qb = essai.positions[b.k]!.quand;
          return qa < qb ? -1 : qa > qb ? 1 : a.i - b.i;
        });
      for (const { k } of anciennes) {
        delete essai.positions[k];
        if (octets(essai) <= TAILLE_MEMOIRE_SITE) break;
      }
      if (octets(essai) > TAILLE_MEMOIRE_SITE) return { ok: false, erreur: MEMOIRE_PLEINE };
    }
    this.c = essai;
    this.changer();
    return { ok: true };
  }

  lire(cle: string): unknown | null {
    const e = this.c.valeurs[cle];
    return e === undefined ? null : e.valeur;
  }

  oublier(cle: string): void {
    if (!(cle in this.c.valeurs)) return;
    delete this.c.valeurs[cle];
    this.changer();
  }

  noterPosition(adresse: string, t: number, duree: number): void {
    if (typeof adresse !== "string" || adresse.length < 1 || adresse.length > 2048) return;
    if (!nombre(t) || !nombre(duree) || duree <= 0 || t < 0) return;
    if (t / duree >= FIN_VIDEO) {
      if (!(adresse in this.c.positions)) return;
      delete this.c.positions[adresse];
    } else {
      delete this.c.positions[adresse];
      this.c.positions[adresse] = { t, duree, quand: this.maintenant() };
      elaguerPositions(this.c);
      while (octets(this.c) > TAILLE_MEMOIRE_SITE && Object.keys(this.c.positions).length > 1) {
        delete this.c.positions[Object.keys(this.c.positions)[0]!];
      }
    }
    this.changer();
  }

  position(adresse: string): PositionVideo | null {
    const p = this.c.positions[adresse];
    return p ? { ...p } : null;
  }

  contenu(): ContenuMemoire {
    return this.c;
  }

  surChange(r: () => void): () => void {
    this.ecouteurs.add(r);
    return () => void this.ecouteurs.delete(r);
  }

  /** Écrit tout de suite ce qui est en attente et attend la fin des écritures. */
  async vider(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.programmerEcriture();
    }
    await this.chaine;
  }

  /** Oublie tout : écriture en attente annulée, fichier supprimé, abonnés prévenus. */
  async effacer(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.c = vide();
    this.chaine = this.chaine.then(() => rm(this.chemin, { force: true })).catch(() => {});
    this.prevenir();
    await this.chaine;
  }

  private changer(): void {
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
      .then(() => ecrireAtomique(this.chemin, JSON.stringify(this.c)))
      .catch(() => {});
  }

  private prevenir(): void {
    for (const r of [...this.ecouteurs]) {
      try {
        r();
      } catch {
        // un abonné qui échoue ne gêne pas les autres
      }
    }
  }
}
