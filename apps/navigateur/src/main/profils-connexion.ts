import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { session, type Session } from "electron";
import { PROFIL_DEFAUT, profilsEnUsage, type EtatNavigateur, type IdProfil } from "../commun/modele";

const PARTITION_DEFAUT = "persist:webaios";
/** Les profils de connexion retirés de l'état et pas encore effacés du disque. */
const FICHIER_A_EFFACER = "profils-a-effacer.json";

/** Partition Electron d'un profil de connexion : celle de toujours pour le profil par défaut (aucune connexion perdue). */
export function partitionDe(id: IdProfil): string {
  return id === PROFIL_DEFAUT ? PARTITION_DEFAUT : `${PARTITION_DEFAUT}-${id}`;
}

/** Fichier des autorisations de sites d'un profil de connexion : `permissions.json` pour le profil par défaut. */
export function fichierPermissions(dossier: string, id: IdProfil): string {
  return join(dossier, id === PROFIL_DEFAUT ? "permissions.json" : `permissions-${id}.json`);
}

/**
 * Une session Electron par profil de connexion (cookies, stockage, cache, autorisations), branchée une seule fois.
 * Un profil qui quitte l'état est noté dans `profils-a-effacer.json`, puis effacé du disque et retiré de la liste ;
 * un effacement interrompu ou raté est repris au démarrage suivant. Seul un profil de cette liste est jamais effacé :
 * une session perdue ou corrompue ne coûte aucune connexion. Le profil par défaut n'y va jamais.
 */
export class SessionsProfils {
  private branchees = new Map<IdProfil, Session>();
  /** Profils en usage au dernier `synchroniser` ; undefined avant le premier. */
  private connus: Set<IdProfil> | undefined;
  /** Copie en mémoire de la liste enregistrée ; lue au premier `synchroniser`. */
  private aEffacer: Set<IdProfil> | undefined;

  constructor(
    private readonly o: {
      /** Dossier du profil navigateur (userData) : la liste des profils à effacer et les fichiers d'autorisations. */
      dossier: string;
      /** Branche une session neuve (téléchargements, autorisations) ; appelé une fois par profil. */
      brancher: (s: Session, id: IdProfil) => void;
      /** Un profil vient d'être effacé : ce qui en reste en mémoire (autorisations) doit l'être aussi. */
      oublier?: (id: IdProfil) => void;
    },
  ) {}

  session(id: IdProfil): Session {
    let s = this.branchees.get(id);
    if (!s) {
      s = session.fromPartition(partitionDe(id));
      this.branchees.set(id, s);
      this.o.brancher(s, id);
    }
    return s;
  }

  /**
   * Note puis efface les profils sortis de l'état depuis l'appel précédent (ni listés, ni utilisés par un espace). Au
   * premier appel, reprend les effacements restés dans la liste ; un profil de la liste revenu dans l'état y est gardé.
   */
  async synchroniser(etat: EtatNavigateur): Promise<void> {
    const ids = profilsEnUsage(etat);
    const liste = (this.aEffacer ??= this.lireListe());
    const sortis = this.connus ? [...this.connus].filter((id) => !ids.has(id)) : [];
    this.connus = ids;
    for (const id of sortis) if (id !== PROFIL_DEFAUT) liste.add(id);
    for (const id of liste) if (ids.has(id)) liste.delete(id);
    this.ecrireListe();
    await Promise.all(
      [...liste].map(async (id) => {
        if (!(await this.effacer(id))) return;
        liste.delete(id);
        this.ecrireListe();
      }),
    );
  }

  /** Vrai si tout le profil a été effacé ; une erreur le laisse sur la liste, pour le démarrage suivant. */
  private async effacer(id: IdProfil): Promise<boolean> {
    try {
      const s = session.fromPartition(partitionDe(id));
      await s.clearStorageData();
      await s.clearCache();
      this.o.oublier?.(id);
      await rm(fichierPermissions(this.o.dossier, id), { force: true });
      return true;
    } catch (e) {
      console.error(`[profils] profil de connexion ${id} non effacé :`, e);
      return false;
    }
  }

  /** La liste enregistrée ; absente ou illisible, elle est vide : dans le doute, rien n'est effacé. */
  private lireListe(): Set<IdProfil> {
    try {
      const lu: unknown = JSON.parse(readFileSync(join(this.o.dossier, FICHIER_A_EFFACER), "utf8"));
      return new Set(Array.isArray(lu) ? lu.filter((x): x is string => typeof x === "string" && x !== "" && x !== PROFIL_DEFAUT) : []);
    } catch {
      return new Set();
    }
  }

  /** Écrit la liste de façon atomique et synchrone : elle est sur le disque avant tout effacement. */
  private ecrireListe(): void {
    const cible = join(this.o.dossier, FICHIER_A_EFFACER);
    const temporaire = `${cible}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaire, JSON.stringify([...(this.aEffacer ?? [])]));
      renameSync(temporaire, cible);
    } catch (e) {
      console.error("[profils] liste des profils à effacer non écrite :", e);
    }
  }
}
