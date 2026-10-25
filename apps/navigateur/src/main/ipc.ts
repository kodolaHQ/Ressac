import { ipcMain, type IpcMainEvent } from "electron";
import { CANAUX, SchemaAction, SchemaBornes, SchemaCommande, type Action, type Bornes, type CommandeOnglet } from "../commun/api";
import type { EtatNavigateur, IdFenetre, IdOnglet } from "../commun/modele";
import { appliquer } from "./etat/actions";
import type { Historique } from "./historique";

type Abonne = (etat: EtatNavigateur, precedent: EtatNavigateur) => void;

/** Détient l'unique état du navigateur ; seul `agir` le modifie. */
export class Magasin {
  private abonnes: Abonne[] = [];
  constructor(private courant: EtatNavigateur) {}

  get etat(): EtatNavigateur {
    return this.courant;
  }

  agir(action: Action): void {
    const precedent = this.courant;
    this.courant = appliquer(precedent, action);
    if (this.courant !== precedent) for (const a of this.abonnes) a(this.courant, precedent);
  }

  abonner(a: Abonne): void {
    this.abonnes.push(a);
  }
}

export interface Gestionnaires {
  magasin: Magasin;
  /** Fenêtre principale émettrice d'un message ; undefined pour une popup ou une page web. */
  fenetreDe(e: Pick<IpcMainEvent, "sender">): IdFenetre | undefined;
  naviguer(fenetreId: IdFenetre, ongletId: IdOnglet | null, saisie: string): void;
  commande(ongletId: IdOnglet, c: CommandeOnglet): void;
  bornes(fenetreId: IdFenetre, b: Bornes): void;
  historique: Historique;
}

/** Reçoit les messages de l'interface, après validation : tout message invalide est ignoré et journalisé. */
export function brancherIpc(g: Gestionnaires): void {
  const recevoir = <T>(canal: string, valider: (v: unknown) => T | null, traiter: (v: T, fenetreId: IdFenetre) => void) => {
    ipcMain.on(canal, (e, brut: unknown) => {
      const fenetreId = g.fenetreDe(e);
      if (!fenetreId) return;
      const v = valider(brut);
      if (v === null) {
        console.warn(`[ipc] message invalide ignoré sur ${canal}:`, brut);
        return;
      }
      traiter(v, fenetreId);
    });
  };
  const zod = <T>(s: { safeParse(v: unknown): { success: true; data: T } | { success: false } }) => (v: unknown) => {
    const r = s.safeParse(v);
    return r.success ? r.data : null;
  };

  recevoir(CANAUX.action, zod<Action>(SchemaAction), (a) => g.magasin.agir(a));
  recevoir(CANAUX.naviguer, (v) => {
    const o = v as { ongletId?: unknown; saisie?: unknown } | null;
    const ongletId = o?.ongletId === null || typeof o?.ongletId === "string" ? o.ongletId : undefined;
    return ongletId !== undefined && typeof o?.saisie === "string" ? { ongletId, saisie: o.saisie } : null;
  }, (v, f) => g.naviguer(f, v.ongletId, v.saisie));
  recevoir(CANAUX.commande, zod(SchemaCommande), (v) => g.commande(v.ongletId, v.c));
  recevoir(CANAUX.bornes, zod(SchemaBornes), (b, f) => g.bornes(f, b));
  const repondre = (canal: string, traiter: (...args: unknown[]) => unknown) =>
    ipcMain.handle(canal, (e, ...args: unknown[]) => {
      if (!g.fenetreDe(e)) throw new Error("expéditeur inconnu");
      return traiter(...args);
    });
  const limite = (v: unknown, defaut: number) => (Number.isInteger(v) && (v as number) > 0 ? Math.min(v as number, 500) : defaut);
  repondre(CANAUX.historiqueRechercher, (texte, n) => (typeof texte === "string" ? g.historique.rechercher(texte, limite(n, 50)) : []));
  repondre(CANAUX.historiqueRecents, () => g.historique.recents());
  repondre(CANAUX.historiqueEffacer, (depuis) => {
    const date = typeof depuis === "string" ? new Date(depuis) : undefined;
    if (date && Number.isNaN(date.getTime())) return;
    g.historique.effacer(date);
  });
  ipcMain.on(CANAUX.demanderEtat, (e) => {
    if (g.fenetreDe(e)) e.sender.send(CANAUX.etat, g.magasin.etat);
  });
}
