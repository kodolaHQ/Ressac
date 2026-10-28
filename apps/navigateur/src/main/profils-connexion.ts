import { readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { session, type Session } from "electron";
import { PROFIL_DEFAUT, profilsEnUsage, type EtatNavigateur, type IdProfil } from "../commun/modele";

const PARTITION_DEFAUT = "persist:webaios";

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
 * Un profil qui quitte l'état est effacé du disque, sauf le profil par défaut.
 */
export class SessionsProfils {
  private branchees = new Map<IdProfil, Session>();
  /** Profils de l'état au dernier `synchroniser` ; undefined avant le premier. */
  private connus: Set<IdProfil> | undefined;

  constructor(
    private readonly o: {
      /** Dossier du profil navigateur (userData) : `Partitions/` et les fichiers d'autorisations. */
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
   * Efface les profils sortis de l'état (ni listés, ni utilisés par un espace). Au premier appel, aussi ceux restés sur
   * le disque (effacement interrompu) — seulement si `sessionChargee` : un état initial de secours (session absente ou
   * corrompue) ne dit rien des profils du disque, qui sont alors gardés.
   */
  async synchroniser(etat: EtatNavigateur, sessionChargee = true): Promise<void> {
    const ids = profilsEnUsage(etat);
    const avant = this.connus ?? (sessionChargee ? new Set(this.surLeDisque()) : ids);
    this.connus = ids;
    // Le profil par défaut n'est jamais effacé : les connexions d'avant les espaces et les blocs d'accueil y vivent.
    await Promise.all([...avant].filter((id) => !ids.has(id) && id !== PROFIL_DEFAUT).map((id) => this.effacer(id)));
  }

  private async effacer(id: IdProfil): Promise<void> {
    try {
      const s = session.fromPartition(partitionDe(id));
      await s.clearStorageData();
      await s.clearCache();
      this.o.oublier?.(id);
      await rm(fichierPermissions(this.o.dossier, id), { force: true });
    } catch (e) {
      console.error(`[profils] profil de connexion ${id} non effacé :`, e);
    }
  }

  /** Les profils de connexion (autres que le profil par défaut) dont une partition existe dans `Partitions/`. */
  private surLeDisque(): IdProfil[] {
    let noms: string[];
    try {
      noms = readdirSync(join(this.o.dossier, "Partitions"));
    } catch {
      return [];
    }
    const prefixe = `${PARTITION_DEFAUT.slice("persist:".length)}-`;
    return noms.filter((n) => n.startsWith(prefixe)).map((n) => n.slice(prefixe.length));
  }
}
