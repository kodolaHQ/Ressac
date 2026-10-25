import { ipcMain, type IpcMainEvent } from "electron";
import { CANAUX, SchemaAction, SchemaActionTelechargement, SchemaReponsePermission, SchemaBornes, SchemaCommande, type Action, type Bornes, type CommandeOnglet } from "../commun/api";
import type { Decision, DemandeEnAttente, EtatNavigateur, IdFenetre, IdOnglet } from "../commun/modele";
import { appliquer } from "./etat/actions";
import type { Historique } from "./historique";
import type { Telechargements } from "./telechargements";

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
  /** Fermer un onglet en laissant la page demander confirmation (voir GestionnaireVues.fermer). */
  fermerOnglet(ongletId: IdOnglet): void;
  historique: Historique;
  telechargements: Telechargements;
  permissions: { enAttente(): DemandeEnAttente[]; repondre(id: string, d: Decision): void };
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

  recevoir(CANAUX.action, zod<Action>(SchemaAction), (a) => (a.type === "fermerOnglet" ? g.fermerOnglet(a.id) : g.magasin.agir(a)));
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
  repondre(CANAUX.telechargementsListe, () => g.telechargements.liste());
  recevoir(CANAUX.telechargementAction, zod(SchemaActionTelechargement), ({ id, action }) => g.telechargements[action](id));
  repondre(CANAUX.permissionsListe, () => g.permissions.enAttente());
  recevoir(CANAUX.repondrePermission, zod(SchemaReponsePermission), ({ id, decision }) => g.permissions.repondre(id, decision));
  ipcMain.on(CANAUX.demanderEtat, (e) => {
    if (g.fenetreDe(e)) e.sender.send(CANAUX.etat, g.magasin.etat);
  });
}
