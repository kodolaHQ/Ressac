import { ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { CANAUX, SchemaIdAction, SchemaSaisieAction, SchemaIdExecution, SchemaAction, SchemaActionTelechargement, SchemaReponsePermission, SchemaBornes, SchemaBoutonsFenetre, SchemaCommande, SchemaTailleTerminal, SchemaPlacements, SchemaIdWidget, SchemaBlocWorkflow, SchemaBrouillon, SchemaCible, SchemaCodeWorkflow, SchemaNomCode, SchemaAccord, SchemaOuvrirWidget, SchemaActionApplication, SchemaCouperAcces, SchemaTaillePastille, SchemaApercuPage, SchemaActionSite, selectionConstructeur, type SelectionConstructeur, type Accord, type ActionApplication, type EtatIaAffiche, type ListeApplications, type Brouillon, type EditionWorkflow, type Placement, type ProfilPourAccord, type TailleTerminal, type Action, type WidgetAffiche, type Bornes, type CommandeOnglet, type ResultatExtension } from "../commun/api";
import type { ActionSite, EtatFenetreSite, SiteAffiche } from "../commun/sites";
import { SAISIE_INVALIDE, type BarreExtensions, type LigneExtension, type LigneExtensionEspace } from "../commun/extensions";
import type { Decision, DemandeEnAttente, EtatAcces, EtatNavigateur, IdFenetre, IdOnglet } from "../commun/modele";
import type { Avertissement, CatalogueBloc, DroitDev, EtatDirect, Execution, ResultatEnregistrement, ResultatEssai, ResumeExecution, Proprietaire } from "@webaios/noyau";
import { appliquer } from "./etat/actions";
import type { Historique } from "./historique";
import type { Telechargements } from "./telechargements";
import type { ServiceActions } from "./agent/actions";

/** Les boutons de la barre d'une fenêtre d'appli de site. */
export type GesteSite = "entrer" | "accueil" | "precedent" | "suivant" | "recharger" | "ouvrirBloque";

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
  /** macOS : montrer ou cacher les boutons de la fenêtre (ils suivent la barre latérale). */
  boutonsFenetre(fenetreId: IdFenetre, visibles: boolean): void;
  /** Capture de la page affichée dans la fenêtre si c'est bien `ongletId` (fond d'une modale) ; null sinon. */
  apercu(fenetreId: IdFenetre, ongletId: IdOnglet): Promise<string | null>;
  /** Fermer un onglet en laissant la page demander confirmation (voir GestionnaireVues.fermer). */
  fermerOnglet(ongletId: IdOnglet): void;
  historique: Historique;
  telechargements: Telechargements;
  permissions: { enAttente(): DemandeEnAttente[]; repondre(id: string, d: Decision, droits?: DroitDev[], confirme?: boolean): void };
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
    accorder(a: Accord): Promise<{ ok: true } | { ok: false; erreur: string }>;
    refuserAccord(id: string): void;
    recolter(id: string): void;
    executions(id: string): Promise<ResumeExecution[]>;
    execution(id: string, execution: string): Promise<Execution | null>;
  };
  /**
   * Constructeur de workflows : cibles (widget ou action), noms de code et brouillon déjà validés ici. Chaque appel nomme
   * la fenêtre d'où il vient (celui d'une action est refusé quand son espace actif est privé).
   */
  workflow: {
    catalogue(): CatalogueBloc[];
    lire(f: IdFenetre, cible: Proprietaire): Promise<EditionWorkflow | null>;
    enregistrer(f: IdFenetre, cible: Proprietaire, brouillon: Brouillon): Promise<ResultatEnregistrement & { avertissements: Avertissement[] }>;
    lireCode(f: IdFenetre, cible: Proprietaire, nom: string): Promise<{ texte: string } | { absent: true } | { erreur: string }>;
    enregistrerCode(f: IdFenetre, cible: Proprietaire, nom: string, texte: string): Promise<{ ok: true } | { ok: false; erreur: string }>;
    rejouer(f: IdFenetre, cible: Proprietaire, execution: string, bloc: string): Promise<ResultatEssai>;
    lancer(f: IdFenetre, cible: Proprietaire, saisie: string | null): Promise<{ execution?: string; erreur?: string }>;
    selection(f: IdFenetre, s: SelectionConstructeur): void;
    direct(): Promise<EtatDirect>;
  };
  /** Actions : ids, saisies et adresses validés ici ; le service refuse tout appel d'une fenêtre en espace privé. */
  actions: ServiceActions;
  /** IA locale : `installer` télécharge plusieurs gigaoctets, seulement sur un clic de l'utilisateur. */
  ia: { etat(): Promise<EtatIaAffiche>; installer(): Promise<{ ok: boolean; erreur?: string }> };
  applications: { liste(): Promise<ListeApplications>; agir(dossier: string, action: ActionApplication, fenetreId: IdFenetre): void };
  /** `saisie` validée ici comme chaîne bornée ; le gestionnaire la lit (`idDepuisSaisie`). */
  extensions: {
    installerStore(saisie: string, fenetreId: IdFenetre): Promise<{ ok: true } | { ok: false; erreur: string }>;
    pourEspace(espaceId: string): Promise<LigneExtensionEspace[]>;
    basculer(cle: string, espaceId: string, actif: boolean, fenetreId: IdFenetre): Promise<{ ok: true } | { ok: false; erreur: string }>;
    liste(): Promise<LigneExtension[]>;
    coupees(): boolean;
    barre(fenetreId: IdFenetre): Promise<BarreExtensions>;
    epingler(cle: string, oui: boolean): Promise<ResultatExtension>;
    desactiverPartout(cle: string): Promise<ResultatExtension>;
    supprimer(cle: string): Promise<ResultatExtension>;
    toutCouper(oui: boolean): Promise<ResultatExtension>;
    revoir(cle: string, fenetreId: IdFenetre): Promise<ResultatExtension>;
    reactiver(cle: string): Promise<ResultatExtension>;
    /** « Couper le déblocage » : la console de l'extension est de nouveau filtrée pour l'agent. */
    couperDeblocage(cle: string): Promise<ResultatExtension>;
  };
  acces: { etat(): EtatAcces; couper(id: IdOnglet, droit?: DroitDev): void };
  /** Section « Sites » de la page Applications (fenêtre principale). */
  sites: { liste(): Promise<SiteAffiche[]>; agir(id: string, action: ActionSite, fenetreId: IdFenetre): void };
  /**
   * Interface d'une fenêtre d'appli de site : l'appli vient de l'expéditeur (`idDe`), jamais du message ; seule la page
   * elle-même (pas un de ses cadres) est entendue.
   */
  site: { idDe(sender: WebContents): string | undefined; etat(id: string): EtatFenetreSite | null; geste(id: string, g: GesteSite): void };
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
  recevoir(CANAUX.boutonsFenetre, zod(SchemaBoutonsFenetre), ({ visibles }, f) => g.boutonsFenetre(f, visibles));
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
  recevoir(CANAUX.repondrePermission, zod(SchemaReponsePermission), ({ id, decision, droits, confirme }) => g.permissions.repondre(id, decision, droits, confirme));
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
  ipcMain.handle(CANAUX.accueilAccorder, (e, brut: unknown) => {
    if (!g.fenetreDe(e)) throw new Error("expéditeur inconnu");
    const r = SchemaAccord.safeParse(brut);
    if (!r.success) {
      console.warn(`[ipc] message invalide ignoré sur ${CANAUX.accueilAccorder}:`, brut);
      return { ok: false, erreur: "Demande d'accord invalide" };
    }
    return g.accueil.accorder(r.data);
  });
  recevoir(CANAUX.accueilRefuserAccord, zod(SchemaIdWidget), (id) => g.accueil.refuserAccord(id));
  recevoir(CANAUX.accueilRecolter, zod(SchemaIdWidget), (id) => g.accueil.recolter(id));
  // Exécutions d'un widget : seulement l'interface d'une fenêtre principale (comme les autres accueil.*), ids validés.
  const idWidgetValide = (v: unknown): v is string => SchemaIdWidget.safeParse(v).success;
  repondre(CANAUX.accueilExecutions, (id) => (idWidgetValide(id) ? g.accueil.executions(id) : []));
  repondre(CANAUX.accueilExecution, (id, execution) =>
    idWidgetValide(id) && SchemaIdExecution.safeParse(execution).success ? g.accueil.execution(id, execution as string) : null,
  );
  // Constructeur : seulement l'interface d'une fenêtre principale, chaque argument validé ; la fenêtre est nommée.
  const echec = { ok: false as const, erreur: "Argument invalide" };
  const cibleDe = (v: unknown): Proprietaire | null => {
    const r = SchemaCible.safeParse(v);
    return r.success ? r.data : null;
  };
  const nomValide = (nom: unknown): nom is string => SchemaNomCode.safeParse(nom).success;
  const repondreConstructeur = (canal: string, traiter: (fenetreId: IdFenetre, ...args: unknown[]) => unknown) =>
    ipcMain.handle(canal, (e, ...args: unknown[]) => {
      const fenetreId = g.fenetreDe(e);
      if (!fenetreId) throw new Error("expéditeur inconnu");
      return traiter(fenetreId, ...args);
    });
  repondre(CANAUX.workflowCatalogue, () => g.workflow.catalogue());
  repondreConstructeur(CANAUX.workflowLire, (f, c) => {
    const cible = cibleDe(c);
    return cible ? g.workflow.lire(f, cible) : null;
  });
  repondreConstructeur(CANAUX.workflowEnregistrer, (f, c, brouillon) => {
    const cible = cibleDe(c);
    const b = SchemaBrouillon.safeParse(brouillon);
    return cible && b.success ? g.workflow.enregistrer(f, cible, b.data) : { ...echec, avertissements: [] };
  });
  repondreConstructeur(CANAUX.workflowLireCode, (f, c, nom) => {
    const cible = cibleDe(c);
    return cible && nomValide(nom) ? g.workflow.lireCode(f, cible, nom) : { erreur: "Argument invalide" };
  });
  repondreConstructeur(CANAUX.workflowEnregistrerCode, (f, c, nom, texte) => {
    const cible = cibleDe(c);
    const t = SchemaCodeWorkflow.safeParse(texte);
    return cible && nomValide(nom) && t.success ? g.workflow.enregistrerCode(f, cible, nom, t.data) : echec;
  });
  repondreConstructeur(CANAUX.workflowRejouer, (f, c, execution, bloc) => {
    const cible = cibleDe(c);
    return cible && SchemaIdExecution.safeParse(execution).success && SchemaBlocWorkflow.safeParse(bloc).success
      ? g.workflow.rejouer(f, cible, execution as string, bloc as string)
      : echec;
  });
  repondreConstructeur(CANAUX.workflowLancer, (f, c, saisie) => {
    const cible = cibleDe(c);
    const s = SchemaSaisieAction.safeParse(saisie ?? null);
    return cible && s.success ? g.workflow.lancer(f, cible, s.data) : {};
  });
  recevoir(CANAUX.workflowSelection, selectionConstructeur, (s, f) => g.workflow.selection(f, s));
  repondre(CANAUX.workflowDirectLire, () => g.workflow.direct());
  // Actions : seulement l'interface d'une fenêtre principale, qui est nommée au service (refus en espace privé).
  const repondreFenetre = (canal: string, traiter: (fenetreId: IdFenetre, ...args: unknown[]) => unknown) =>
    ipcMain.handle(canal, (e, ...args: unknown[]) => {
      const fenetreId = g.fenetreDe(e);
      if (!fenetreId) throw new Error("expéditeur inconnu");
      return traiter(fenetreId, ...args);
    });
  const idAction = (v: unknown): v is string => SchemaIdAction.safeParse(v).success;
  const saisieAction = (v: unknown): v is string | null => SchemaSaisieAction.safeParse(v).success;
  const executionAction = (v: unknown): v is string => SchemaIdExecution.safeParse(v).success;
  const actionInvalide = { ok: false as const, erreur: "Demande invalide" };
  repondreFenetre(CANAUX.actionsListe, (f) => g.actions.liste(f));
  repondreFenetre(CANAUX.actionsOuvrir, (f, id, saisie) => (idAction(id) && saisieAction(saisie) ? g.actions.ouvrir(f, id, saisie) : actionInvalide));
  repondreFenetre(CANAUX.actionsLancer, (f, id, saisie) =>
    idAction(id) && saisieAction(saisie) ? g.actions.lancer(f, id, saisie) : { statut: "invalide", erreur: "Demande invalide" },
  );
  repondreFenetre(CANAUX.actionsArreter, (f, id) => void (idAction(id) && g.actions.arreter(f, id)));
  repondreFenetre(CANAUX.actionsPage, (f, id, execution) =>
    idAction(id) && (execution === null || executionAction(execution)) ? g.actions.page(f, id, execution) : null,
  );
  repondreFenetre(CANAUX.actionsExecutions, (f, id) => (idAction(id) ? g.actions.executions(f, id) : []));
  repondreFenetre(CANAUX.actionsExecution, (f, id, execution) => (idAction(id) && executionAction(execution) ? g.actions.execution(f, id, execution) : null));
  repondreFenetre(CANAUX.actionsDirectLire, (f) => g.actions.direct(f));
  repondreFenetre(CANAUX.actionsOuvrirLien, (f, id, execution, url) =>
    idAction(id) && executionAction(execution) && typeof url === "string" && url.length > 0 && url.length <= 8192
      ? g.actions.ouvrirLien(f, id, execution, url)
      : undefined,
  );
  repondreFenetre(CANAUX.actionsProfils, (f) => g.actions.profilsPourAccord(f));
  repondreFenetre(CANAUX.actionsAccorder, (f, brut) => {
    const r = SchemaAccord.safeParse(brut);
    return r.success && idAction(r.data.id) ? g.actions.accorder(f, r.data) : { ok: false, erreur: "Demande d'accord invalide" };
  });
  repondreFenetre(CANAUX.actionsRefuserAccord, (f, id) => (idAction(id) ? g.actions.refuserAccord(f, id) : undefined));
  repondreFenetre(CANAUX.actionsSupprimer, (f, id) => (idAction(id) ? g.actions.supprimer(f, id) : actionInvalide));
  repondreFenetre(CANAUX.actionsVoirWorkflow, (f, id) => (idAction(id) ? g.actions.voirWorkflow(f, id) : undefined));
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
  // Seule l'interface d'une fenêtre principale (un geste de l'utilisateur) installe : la carte s'ouvre dans cette fenêtre.
  ipcMain.handle(CANAUX.extensionsInstallerStore, (e, saisie: unknown) => {
    const fenetreId = g.fenetreDe(e);
    if (!fenetreId) throw new Error("expéditeur inconnu");
    if (typeof saisie !== "string" || saisie.length > 2000) return { ok: false, erreur: SAISIE_INVALIDE };
    return g.extensions.installerStore(saisie, fenetreId);
  });
  const chaine = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
  repondre(CANAUX.extensionsPourEspace, (espaceId) => (chaine(espaceId, 200) ? g.extensions.pourEspace(espaceId) : []));
  // Un geste de l'utilisateur dans la modale d'une fenêtre : la carte d'une extension de l'agent s'ouvre dans cette fenêtre.
  ipcMain.handle(CANAUX.extensionsBasculer, (e, cle: unknown, espaceId: unknown, actif: unknown) => {
    const fenetreId = g.fenetreDe(e);
    if (!fenetreId) throw new Error("expéditeur inconnu");
    if (!chaine(cle, 200) || !chaine(espaceId, 200) || typeof actif !== "boolean") return { ok: false, erreur: "Demande invalide" };
    return g.extensions.basculer(cle, espaceId, actif, fenetreId);
  });
  // La page Extensions et la barre : seulement l'interface d'une fenêtre principale (un geste de l'utilisateur), clés bornées.
  const invalide = { ok: false as const, erreur: "Demande invalide" };
  const geste = (canal: string, traiter: (cle: string, fenetreId: IdFenetre, oui: boolean) => Promise<ResultatExtension>, avecOui = false) =>
    ipcMain.handle(canal, (e, cle: unknown, oui: unknown) => {
      const fenetreId = g.fenetreDe(e);
      if (!fenetreId) throw new Error("expéditeur inconnu");
      if (!chaine(cle, 200) || (avecOui && typeof oui !== "boolean")) return invalide;
      return traiter(cle, fenetreId, oui === true);
    });
  repondre(CANAUX.extensionsListe, () => g.extensions.liste());
  repondre(CANAUX.extensionsCoupees, () => g.extensions.coupees());
  ipcMain.handle(CANAUX.extensionsBarre, (e) => {
    const fenetreId = g.fenetreDe(e);
    if (!fenetreId) throw new Error("expéditeur inconnu");
    return g.extensions.barre(fenetreId);
  });
  geste(CANAUX.extensionsEpingler, (cle, _f, oui) => g.extensions.epingler(cle, oui), true);
  geste(CANAUX.extensionsDesactiverPartout, (cle) => g.extensions.desactiverPartout(cle));
  geste(CANAUX.extensionsSupprimer, (cle) => g.extensions.supprimer(cle));
  geste(CANAUX.extensionsRevoir, (cle, f) => g.extensions.revoir(cle, f));
  geste(CANAUX.extensionsReactiver, (cle) => g.extensions.reactiver(cle));
  geste(CANAUX.extensionsCouperDeblocage, (cle) => g.extensions.couperDeblocage(cle));
  ipcMain.handle(CANAUX.extensionsToutCouper, (e, oui: unknown) => {
    if (!g.fenetreDe(e)) throw new Error("expéditeur inconnu");
    return typeof oui === "boolean" ? g.extensions.toutCouper(oui) : invalide;
  });
  repondre(CANAUX.sitesListe, () => g.sites.liste());
  recevoir(CANAUX.sitesAction, zod(SchemaActionSite), ({ id, action }, f) => g.sites.agir(id, action, f));
  const siteDe = (e: Pick<IpcMainEvent, "sender" | "senderFrame">) =>
    e.senderFrame && e.senderFrame === e.sender.mainFrame ? g.site.idDe(e.sender) : undefined;
  ipcMain.handle(CANAUX.siteEtat, (e) => {
    const id = siteDe(e);
    if (!id) throw new Error("expéditeur inconnu");
    return g.site.etat(id);
  });
  const gestes: [string, GesteSite][] = [
    [CANAUX.siteEntrer, "entrer"],
    [CANAUX.siteAccueil, "accueil"],
    [CANAUX.sitePrecedent, "precedent"],
    [CANAUX.siteSuivant, "suivant"],
    [CANAUX.siteRecharger, "recharger"],
    [CANAUX.siteOuvrirBloque, "ouvrirBloque"],
  ];
  for (const [canal, geste] of gestes)
    ipcMain.on(canal, (e) => {
      const id = siteDe(e);
      if (id) g.site.geste(id, geste);
    });
  recevoir(CANAUX.applicationAction, zod(SchemaActionApplication), ({ dossier, action }, f) => g.applications.agir(dossier, action, f));
  recevoir(CANAUX.agentDemarrer, zod(SchemaTailleTerminal), (t, f) => g.agent.demarrer(f, t));
  recevoir(CANAUX.agentRedimensionner, zod(SchemaTailleTerminal), (t, f) => g.agent.redimensionner(f, t));
  // Une frappe ou un collage : du texte, borné.
  recevoir(CANAUX.agentEcrire, (v) => (typeof v === "string" && v.length <= 1_000_000 ? v : null), (d, f) => g.agent.ecrire(f, d));
  ipcMain.on(CANAUX.demanderEtat, (e) => {
    if (g.fenetreDe(e)) e.sender.send(CANAUX.etat, g.magasin.etat);
  });
}
