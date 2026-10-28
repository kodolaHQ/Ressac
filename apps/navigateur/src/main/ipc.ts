import { ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { CANAUX, SchemaAction, SchemaActionTelechargement, SchemaReponsePermission, SchemaBornes, SchemaCommande, SchemaTailleTerminal, SchemaPlacements, SchemaIdWidget, SchemaAccord, SchemaOuvrirWidget, SchemaActionApplication, SchemaCouperAcces, SchemaTaillePastille, SchemaApercuPage, type ActionApplication, type EtatIaAffiche, type ListeApplications, type Placement, type ProfilPourAccord, type TailleTerminal, type Action, type WidgetAffiche, type Bornes, type CommandeOnglet } from "../commun/api";
import type { Decision, DemandeEnAttente, EtatAcces, EtatNavigateur, IdFenetre, IdOnglet } from "../commun/modele";
import type { DroitDev } from "@webaios/noyau";
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
  fenetreDe(e: Pick<IpcMainEvent, "sender" | "senderFrame">): IdFenetre | undefined;
  naviguer(fenetreId: IdFenetre, ongletId: IdOnglet | null, saisie: string): void;
  commande(ongletId: IdOnglet, c: CommandeOnglet): void;
  bornes(fenetreId: IdFenetre, b: Bornes): void;
  /** Capture de la page affichée dans la fenêtre si c'est bien `ongletId` (fond d'une modale) ; null sinon. */
  apercu(fenetreId: IdFenetre, ongletId: IdOnglet): Promise<string | null>;
  /** Fermer un onglet en laissant la page demander confirmation (voir GestionnaireVues.fermer). */
  fermerOnglet(ongletId: IdOnglet): void;
  historique: Historique;
  telechargements: Telechargements;
  permissions: { enAttente(): DemandeEnAttente[]; repondre(id: string, d: Decision, droits?: DroitDev[]): void };
  agent: {
    demarrer(f: IdFenetre, t: TailleTerminal): void;
    ecrire(f: IdFenetre, d: string): void;
    redimensionner(f: IdFenetre, t: TailleTerminal): void;
    profils(): Promise<{ id: string; nom: string }[]>;
  };
  accueil: {
    lire(): Promise<WidgetAffiche[]>;
    placer(placements: Placement[]): void;
    retirer(id: string): void;
    /** `url` validée ici comme chaîne ; le gestionnaire n'ouvre que http(s). */
    ouvrir(url: string, id: string, fenetreId: IdFenetre): void;
    profilsPourAccord(fenetreId: IdFenetre): ProfilPourAccord[];
    accorder(id: string, profil: string): void;
    refuserAccord(id: string): void;
    recolter(id: string): void;
  };
  /** IA locale : `installer` télécharge plusieurs gigaoctets, seulement sur un clic de l'utilisateur. */
  ia: { etat(): Promise<EtatIaAffiche>; installer(): Promise<{ ok: boolean; erreur?: string }> };
  applications: { liste(): Promise<ListeApplications>; agir(dossier: string, action: ActionApplication, fenetreId: IdFenetre): void };
  acces: { etat(): EtatAcces; couper(id: IdOnglet, droit?: DroitDev): void };
  /** Pastilles des fenêtres d'appli (vues sans fenêtre principale) : seules, elles agissent sur leur appli. */
  pastille: { dossierDe(sender: WebContents): string | undefined; etat(dossier: string): EtatAcces; redimensionner(dossier: string, ouverte: boolean): void };
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
  repondre(CANAUX.historiqueRechercher, (texte, n, distinctes) => (typeof texte === "string" ? g.historique.rechercher(texte, limite(n, 50), distinctes === true) : []));
  repondre(CANAUX.historiqueRecents, () => g.historique.recents());
  repondre(CANAUX.historiqueEffacer, (depuis) => {
    const date = typeof depuis === "string" ? new Date(depuis) : undefined;
    if (date && Number.isNaN(date.getTime())) return;
    g.historique.effacer(date);
  });
  repondre(CANAUX.historiqueOublierTexte, (url, espaceId) => {
    if (typeof url === "string" && typeof espaceId === "string") g.historique.oublierTexte(url, espaceId);
  });
  repondre(CANAUX.telechargementsListe, () => g.telechargements.liste());
  recevoir(CANAUX.telechargementAction, zod(SchemaActionTelechargement), ({ id, action }) => g.telechargements[action](id));
  repondre(CANAUX.permissionsListe, () => g.permissions.enAttente());
  recevoir(CANAUX.repondrePermission, zod(SchemaReponsePermission), ({ id, decision, droits }) => g.permissions.repondre(id, decision, droits));
  // La modale prend le clavier (la page l'avait peut-être) ; la capture ne vise que la page affichée dans cette fenêtre.
  ipcMain.handle(CANAUX.apercuPage, (e, brut: unknown) => {
    const fenetreId = g.fenetreDe(e);
    if (!fenetreId) throw new Error("expéditeur inconnu");
    const r = SchemaApercuPage.safeParse(brut);
    if (!r.success) {
      console.warn(`[ipc] message invalide ignoré sur ${CANAUX.apercuPage}:`, brut);
      return null;
    }
    e.sender.focus();
    return r.data.ongletId ? g.apercu(fenetreId, r.data.ongletId) : null;
  });
  repondre(CANAUX.accueilLire, () => g.accueil.lire());
  repondre(CANAUX.agentProfils, () => g.agent.profils());
  ipcMain.handle(CANAUX.accueilProfils, (e) => {
    const fenetreId = g.fenetreDe(e);
    if (!fenetreId) throw new Error("expéditeur inconnu");
    return g.accueil.profilsPourAccord(fenetreId);
  });
  recevoir(CANAUX.accueilPlacer, zod(SchemaPlacements), (p) => g.accueil.placer(p));
  recevoir(CANAUX.accueilRetirer, zod(SchemaIdWidget), (id) => g.accueil.retirer(id));
  recevoir(CANAUX.accueilOuvrir, zod(SchemaOuvrirWidget), ({ url, id }, f) => g.accueil.ouvrir(url, id, f));
  recevoir(CANAUX.accueilAccorder, zod(SchemaAccord), ({ id, profil }) => g.accueil.accorder(id, profil));
  recevoir(CANAUX.accueilRefuserAccord, zod(SchemaIdWidget), (id) => g.accueil.refuserAccord(id));
  recevoir(CANAUX.accueilRecolter, zod(SchemaIdWidget), (id) => g.accueil.recolter(id));
  repondre(CANAUX.iaEtat, () => g.ia.etat());
  // Seule une fenêtre principale (un clic de l'utilisateur dans l'interface) lance l'installation.
  repondre(CANAUX.iaInstaller, () => g.ia.installer());
  // Une pastille d'appli ne voit que l'accès de son appli et ne coupe que celui-là ; la fenêtre principale voit tout.
  ipcMain.handle(CANAUX.accesEtat, (e) => {
    const dossier = g.pastille.dossierDe(e.sender);
    if (dossier) return g.pastille.etat(dossier);
    if (!g.fenetreDe(e)) throw new Error("expéditeur inconnu");
    return g.acces.etat();
  });
  ipcMain.on(CANAUX.accesCouper, (e, brut: unknown) => {
    const dossier = g.pastille.dossierDe(e.sender);
    if (!dossier && !g.fenetreDe(e)) return;
    const r = SchemaCouperAcces.safeParse(brut);
    if (!r.success || (dossier && r.data.id !== `app:${dossier}`)) {
      console.warn(`[ipc] message invalide ignoré sur ${CANAUX.accesCouper}:`, brut);
      return;
    }
    g.acces.couper(r.data.id, r.data.droit);
  });
  ipcMain.on(CANAUX.pastilleTaille, (e, brut: unknown) => {
    const dossier = g.pastille.dossierDe(e.sender);
    const r = SchemaTaillePastille.safeParse(brut);
    if (dossier && r.success) g.pastille.redimensionner(dossier, r.data.ouverte);
  });
  repondre(CANAUX.applicationsListe, () => g.applications.liste());
  recevoir(CANAUX.applicationAction, zod(SchemaActionApplication), ({ dossier, action }, f) => g.applications.agir(dossier, action, f));
  recevoir(CANAUX.agentDemarrer, zod(SchemaTailleTerminal), (t, f) => g.agent.demarrer(f, t));
  recevoir(CANAUX.agentRedimensionner, zod(SchemaTailleTerminal), (t, f) => g.agent.redimensionner(f, t));
  // Une frappe ou un collage : du texte, borné.
  recevoir(CANAUX.agentEcrire, (v) => (typeof v === "string" && v.length <= 1_000_000 ? v : null), (d, f) => g.agent.ecrire(f, d));
  ipcMain.on(CANAUX.demanderEtat, (e) => {
    if (g.fenetreDe(e)) e.sender.send(CANAUX.etat, g.magasin.etat);
  });
}
