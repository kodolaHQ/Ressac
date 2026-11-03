import { ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { CANAUX, SchemaIdAction, SchemaSaisieAction, SchemaIdExecution, SchemaAction, SchemaActionTelechargement, SchemaReponsePermission, SchemaBornes, SchemaBoutonsFenetre, SchemaCommande, SchemaTailleTerminal, SchemaPlacements, SchemaIdWidget, SchemaBlocWorkflow, SchemaBrouillon, SchemaCible, SchemaCodeWorkflow, SchemaNomCode, SchemaAccord, SchemaOuvrirWidget, SchemaActionApplication, SchemaCouperAcces, SchemaTaillePastille, SchemaApercuPage, SchemaMessageParcours, SchemaActionSite, selectionConstructeur, type SelectionConstructeur, type Accord, type ActionApplication, type EtatIaAffiche, type ListeApplications, type Brouillon, type EditionWorkflow, type Placement, type ProfilPourAccord, type TailleTerminal, type Action, type WidgetAffiche, type Bornes, type CommandeOnglet, type ResultatExtension, type MessageParcours } from "../commun/api";
import { gesteAccueilDuCadre } from "./sites/cadre-accueil";
import { ADRESSE_ACCUEIL_MAX, EMPREINTE_ACCORD_LONGUEUR, type ActionSite, type EtatFenetreSite, type MessageVersLAccueil, type SiteAffiche } from "../commun/sites";
import { SAISIE_INVALIDE, type BarreExtensions, type LigneExtension, type LigneExtensionEspace, type LigneExtensionSite } from "../commun/extensions";
import type { Decision, DemandeEnAttente, EtatAcces, EtatNavigateur, IdFenetre, IdOnglet } from "../commun/modele";
import type { Avertissement, CatalogueBloc, DroitDev, EtatDirect, Execution, ResultatEnregistrement, ResultatEssai, ResumeExecution, Proprietaire } from "@webaios/noyau";
import { appliquer } from "./etat/actions";
import type { Historique } from "./historique";
import type { Telechargements } from "./telechargements";
import type { ServiceActions } from "./agent/actions";
import { ID_PROJET, type IdProjet } from "@webaios/noyau";
import { TEXTE_REMARQUE_MAX, type ContexteCalque, type ElementAffiche, type EtatDesign, type EtatExternes, type LotAffiche } from "../commun/api";
import type { Commentaire, DiffFichier, VueRelecture } from "../commun/api";
import type { CibleDesign } from "./design/service";
import { JETON_RELECTURE } from "./design/relecture";

/** Les boutons de la barre d'une fenêtre d'appli de site. */
export type GesteSite = "entrer" | "accueil" | "precedent" | "suivant" | "recharger" | "ouvrirBloque" | "chercherAdresse";

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
  /** Le panneau ⌃Tab de la fenêtre agit sur son parcours (voir ParcoursOnglets.message). */
  parcoursOnglets(fenetreId: IdFenetre, m: MessageParcours): void;
  /** La page affichée dans la fenêtre reprend le clavier (voir GestionnaireVues.focaliserAffiche). */
  rendreFocusPage(fenetreId: IdFenetre): void;
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
  site: {
    idDe(sender: WebContents): string | undefined;
    etat(id: string): EtatFenetreSite | null;
    geste(id: string, g: GesteSite): void;
    /** La carte d'accord des retouches de l'appli : « Autoriser » ou « Ouvrir sans retouches ». */
    accorder(id: string, oui: boolean, empreinte: string): Promise<void>;
    /** L'écran d'accueil (relayé par l'interface) : mémoire en lecture, une adresse du site, une image du site. */
    memoire(id: string): Promise<MessageVersLAccueil & { type: "memoire" }>;
    ouvrir(id: string, adresse: string): Promise<boolean>;
    image(id: string, url: string): Promise<string | null>;
    /** Vrai geste de l'utilisateur dans le cadre de l'accueil de l'appli `id`. */
    gesteAccueil(id: string): void;
    /** Le menu « Extensions » de la barre (plan 16) : les extensions du Store et leur état dans l'appli. */
    extensionsListe(id: string): LigneExtensionSite[];
    /** L'interrupteur d'une extension dans l'appli ; réussi, la vue du site est rechargée (page déjà chargée seulement). */
    extensionsBasculer(id: string, cle: string, actif: boolean): Promise<ResultatExtension>;
    /** Les boutons des extensions chargées dans l'appli, sur la vue du site (en vue « site »). */
    extensionsBarre(id: string): BarreExtensions;
    /** « Gérer les extensions » : la page Extensions dans la fenêtre principale au premier plan. */
    extensionsGerer(id: string): void;
    /** Hauteur du panneau du menu (0 : fermé) : la vue du site est repoussée d'autant. */
    extensionsPanneau(id: string, hauteur: number): void;
  };
  /** Pastilles des fenêtres d'appli (vues sans fenêtre principale) : seules, elles agissent sur leur appli. */
  pastille: { dossierDe(sender: WebContents): string | undefined; etat(dossier: string): EtatAcces; redimensionner(dossier: string, ouverte: boolean): void };
  /**
   * Mode design : l'expéditeur est l'interface d'une fenêtre principale (son onglet affiché), la pastille d'une fenêtre
   * d'appli ou un calque (bulle, panier). La cible vient toujours de l'expéditeur, jamais du message.
   */
  design: {
    calqueDe(sender: WebContents): CibleDesign | undefined;
    etat(c: CibleDesign): Promise<EtatDesign>;
    basculer(c: CibleDesign): void;
    relire(c: CibleDesign): void;
    ouvrirPanier(c: CibleDesign): void;
    /** Le projet suivi de la cible (le seul que la pastille d'une appli peut lire). */
    projetDe(c: CibleDesign): Promise<IdProjet | null>;
    contexte(c: CibleDesign): ContexteCalque | null;
    ajouter(c: CibleDesign, texte: string): Promise<ResultatExtension>;
    annuler(c: CibleDesign): void;
    panier(p: IdProjet): Promise<ElementAffiche[]>;
    retirer(p: IdProjet, id: string): Promise<void>;
    envoyer(p: IdProjet): Promise<ResultatExtension>;
    lots(p: IdProjet): Promise<LotAffiche[]>;
    traite(p: IdProjet, lot: string): Promise<void>;
  };
  /** Section « Projets externes » (fenêtre principale) : `id` validé ici (16 hex). */
  externes: {
    liste(): Promise<EtatExternes>;
    brancher(nom: string): Promise<{ commande: string }>;
    revoquer(id: string): Promise<void>;
    oublier(id: string): Promise<void>;
    relire(f: IdFenetre, id: string): void;
  };
  /** Page Relecture (fenêtre principale) : `projet` validé ici ; le chemin, par la comparaison gardée. */
  relecture: {
    ouvrir(p: IdProjet, jeton?: string): Promise<VueRelecture>;
    fichier(p: IdProjet, jeton: string, chemin: string): Promise<DiffFichier>;
    lignes(p: IdProjet, jeton: string, chemin: string, debut: number, fin: number): Promise<string[]>;
    commentaires(p: IdProjet): Promise<Commentaire[]>;
    commenter(p: IdProjet, jeton: string, c: { fichier: string; debut: number; fin: number; texte: string }): Promise<ResultatExtension>;
    modifierCommentaire(p: IdProjet, id: string, texte: string): Promise<void>;
    resoudre(p: IdProjet, id: string, resolu: boolean): Promise<void>;
    supprimerCommentaire(p: IdProjet, id: string): Promise<void>;
    envoyer(p: IdProjet): Promise<ResultatExtension>;
    relu(p: IdProjet, jeton: string): Promise<VueRelecture>;
  };
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
  recevoir(CANAUX.rendreFocusPage, () => true, (_v, f) => g.rendreFocusPage(f));
  recevoir(CANAUX.parcoursOnglets, zod<MessageParcours>(SchemaMessageParcours), (m, f) => g.parcoursOnglets(f, m));
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
    [CANAUX.siteChercherAdresse, "chercherAdresse"],
  ];
  for (const [canal, geste] of gestes)
    ipcMain.on(canal, (e) => {
      const id = siteDe(e);
      if (id) g.site.geste(id, geste);
    });
  ipcMain.handle(CANAUX.siteAccorder, (e, oui: unknown, empreinte: unknown) => {
    const id = siteDe(e);
    if (!id) throw new Error("expéditeur inconnu");
    if (typeof oui !== "boolean" || !chaine(empreinte, EMPREINTE_ACCORD_LONGUEUR)) throw new Error("réponse invalide");
    return g.site.accorder(id, oui, empreinte);
  });
  // L'écran d'accueil passe par l'interface de sa fenêtre : l'appli vient de l'expéditeur, les adresses sont bornées.
  ipcMain.handle(CANAUX.siteAccueilMemoire, (e) => {
    const id = siteDe(e);
    if (!id) throw new Error("expéditeur inconnu");
    return g.site.memoire(id);
  });
  ipcMain.handle(CANAUX.siteAccueilOuvrir, (e, adresse: unknown) => {
    const id = siteDe(e);
    if (!id) throw new Error("expéditeur inconnu");
    return chaine(adresse, ADRESSE_ACCUEIL_MAX) ? g.site.ouvrir(id, adresse) : false;
  });
  // Le geste vient du preload du cadre de l'accueil : retenu seulement pour un cadre posé directement dans la page de la
  // fenêtre de cette appli et qui montre son propre accueil.
  ipcMain.on(CANAUX.siteAccueilGeste, (e) => {
    const id = gesteAccueilDuCadre(e.senderFrame, e.sender.mainFrame, g.site.idDe(e.sender));
    if (id) g.site.gesteAccueil(id);
  });
  ipcMain.handle(CANAUX.siteAccueilImage, (e, url: unknown) => {
    const id = siteDe(e);
    if (!id) throw new Error("expéditeur inconnu");
    return chaine(url, ADRESSE_ACCUEIL_MAX) ? g.site.image(id, url) : null;
  });
  // Le menu « Extensions » de la barre d'une appli de site : l'appli vient de l'expéditeur, les clés sont bornées.
  ipcMain.handle(CANAUX.siteExtensionsListe, (e) => {
    const id = siteDe(e);
    if (!id) throw new Error("expéditeur inconnu");
    return g.site.extensionsListe(id);
  });
  ipcMain.handle(CANAUX.siteExtensionsBasculer, (e, cle: unknown, actif: unknown) => {
    const id = siteDe(e);
    if (!id) throw new Error("expéditeur inconnu");
    if (!chaine(cle, 200) || typeof actif !== "boolean") return invalide;
    return g.site.extensionsBasculer(id, cle, actif);
  });
  ipcMain.handle(CANAUX.siteExtensionsBarre, (e) => {
    const id = siteDe(e);
    if (!id) throw new Error("expéditeur inconnu");
    return g.site.extensionsBarre(id);
  });
  ipcMain.on(CANAUX.siteExtensionsGerer, (e) => {
    const id = siteDe(e);
    if (id) g.site.extensionsGerer(id);
  });
  ipcMain.on(CANAUX.siteExtensionsPanneau, (e, hauteur: unknown) => {
    const id = siteDe(e);
    if (id && typeof hauteur === "number" && Number.isFinite(hauteur)) g.site.extensionsPanneau(id, hauteur);
  });
  recevoir(CANAUX.applicationAction, zod(SchemaActionApplication), ({ dossier, action }, f) => g.applications.agir(dossier, action, f));
  recevoir(CANAUX.agentDemarrer, zod(SchemaTailleTerminal), (t, f) => g.agent.demarrer(f, t));
  recevoir(CANAUX.agentRedimensionner, zod(SchemaTailleTerminal), (t, f) => g.agent.redimensionner(f, t));
  // Une frappe ou un collage : du texte, borné.
  recevoir(CANAUX.agentEcrire, (v) => (typeof v === "string" && v.length <= 1_000_000 ? v : null), (d, f) => g.agent.ecrire(f, d));
  ipcMain.on(CANAUX.demanderEtat, (e) => {
    if (g.fenetreDe(e)) e.sender.send(CANAUX.etat, g.magasin.etat);
  });
  brancherDesign(g);
  brancherExternes(g);
  brancherRelecture(g);
}

type OrigineDesign = { cible: CibleDesign; origine: "fenetre" | "pastille" | "calque" };

/** Mode design : chaque message est rattaché à sa cible d'après l'expéditeur ; projets et textes sont validés. */
function brancherDesign(g: Gestionnaires): void {
  const origine = (e: Pick<IpcMainEvent, "sender" | "senderFrame">): OrigineDesign | undefined => {
    const f = g.fenetreDe(e);
    if (f) return { cible: { type: "fenetre", fenetreId: f }, origine: "fenetre" };
    if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame) return undefined;
    const dossier = g.pastille.dossierDe(e.sender);
    if (dossier) return { cible: { type: "app", dossier }, origine: "pastille" };
    const calque = g.design.calqueDe(e.sender);
    return calque ? { cible: calque, origine: "calque" } : undefined;
  };
  /** La fenêtre principale voit tous les projets ; une pastille ou un calque, seulement celui de sa cible. */
  const projetPermis = async (o: OrigineDesign, p: unknown): Promise<boolean> => {
    if (typeof p !== "string" || !ID_PROJET.test(p)) return false;
    if (o.origine === "fenetre") return true;
    if (o.origine === "calque") return g.design.contexte(o.cible)?.projet === p;
    return (await g.design.projetDe(o.cible)) === p;
  };
  const exiger = (e: Pick<IpcMainEvent, "sender" | "senderFrame">, permises: OrigineDesign["origine"][]) => {
    const o = origine(e);
    if (!o || !permises.includes(o.origine)) throw new Error("expéditeur inconnu");
    return o;
  };
  const toutes: OrigineDesign["origine"][] = ["fenetre", "pastille", "calque"];
  ipcMain.handle(CANAUX.designEtat, (e) => g.design.etat(exiger(e, ["fenetre", "pastille"]).cible));
  ipcMain.on(CANAUX.designBasculer, (e) => {
    const o = origine(e);
    if (o && o.origine !== "calque") g.design.basculer(o.cible);
  });
  ipcMain.on(CANAUX.designRelire, (e) => {
    const o = origine(e);
    if (o && o.origine !== "calque") g.design.relire(o.cible);
  });
  ipcMain.on(CANAUX.designOuvrirPanier, (e) => {
    const o = origine(e);
    if (o?.origine === "pastille") g.design.ouvrirPanier(o.cible);
  });
  const invalide = { ok: false as const, erreur: "Demande invalide" };
  ipcMain.handle(CANAUX.designPanier, async (e, p: unknown) => (await projetPermis(exiger(e, toutes), p) ? g.design.panier(p as IdProjet) : []));
  ipcMain.handle(CANAUX.designLots, async (e, p: unknown) => (await projetPermis(exiger(e, toutes), p) ? g.design.lots(p as IdProjet) : []));
  ipcMain.handle(CANAUX.designRetirer, async (e, p: unknown, id: unknown) => {
    if ((await projetPermis(exiger(e, toutes), p)) && typeof id === "string" && id.length <= 64) await g.design.retirer(p as IdProjet, id);
  });
  ipcMain.handle(CANAUX.designTraite, async (e, p: unknown, lot: unknown) => {
    if ((await projetPermis(exiger(e, toutes), p)) && typeof lot === "string" && lot.length <= 64) await g.design.traite(p as IdProjet, lot);
  });
  ipcMain.handle(CANAUX.designEnvoyer, async (e, p: unknown) => ((await projetPermis(exiger(e, toutes), p)) ? g.design.envoyer(p as IdProjet) : invalide));
  ipcMain.handle(CANAUX.designContexte, (e) => g.design.contexte(exiger(e, ["calque"]).cible));
  ipcMain.handle(CANAUX.designAjouter, (e, texte: unknown) => {
    const o = exiger(e, ["calque"]);
    return typeof texte === "string" && texte.length <= TEXTE_REMARQUE_MAX ? g.design.ajouter(o.cible, texte) : invalide;
  });
  ipcMain.on(CANAUX.designAnnuler, (e) => {
    const o = origine(e);
    if (o?.origine === "calque") g.design.annuler(o.cible);
  });
}

const ID_EXTERNE = /^[0-9a-f]{16}$/;
const ID_CLIENT = /^[0-9a-f-]{8,64}$/;

/** « Projets externes » : la fenêtre principale seule ; ids et noms validés ici. */
function brancherExternes(g: Gestionnaires): void {
  const principale = (e: Pick<IpcMainEvent, "sender" | "senderFrame">) => {
    if (!g.fenetreDe(e)) throw new Error("expéditeur inconnu");
  };
  ipcMain.handle(CANAUX.externesListe, (e) => (principale(e), g.externes.liste()));
  ipcMain.handle(CANAUX.externesBrancher, (e, nom: unknown) => {
    principale(e);
    if (typeof nom !== "string" || nom.length > 200) throw new Error("Nom invalide");
    return g.externes.brancher(nom);
  });
  ipcMain.handle(CANAUX.externesRevoquer, async (e, id: unknown) => {
    principale(e);
    if (typeof id === "string" && ID_CLIENT.test(id)) await g.externes.revoquer(id);
  });
  ipcMain.handle(CANAUX.externesOublier, async (e, id: unknown) => {
    principale(e);
    if (typeof id === "string" && ID_EXTERNE.test(id)) await g.externes.oublier(id);
  });
  ipcMain.on(CANAUX.externesRelire, (e, id: unknown) => {
    const f = g.fenetreDe(e);
    if (f && typeof id === "string" && ID_EXTERNE.test(id)) g.externes.relire(f, id);
  });
}

const CHEMIN_RELECTURE_MAX = 4096;
const ID_COMMENTAIRE = /^c-[0-9a-f]{8}$/;
const entier = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;

/** Page Relecture : la fenêtre principale seule ; projet par `ID_PROJET`, chemin borné (le service le cherche dans la comparaison gardée). */
function brancherRelecture(g: Gestionnaires): void {
  const verifier = (e: Pick<IpcMainEvent, "sender" | "senderFrame">, p: unknown): IdProjet => {
    if (!g.fenetreDe(e)) throw new Error("expéditeur inconnu");
    if (typeof p !== "string" || !ID_PROJET.test(p)) throw new Error("projet invalide");
    return p;
  };
  const chemin = (c: unknown): string => {
    if (typeof c !== "string" || c === "" || c.length > CHEMIN_RELECTURE_MAX || c.includes("\0")) throw new Error("chemin invalide");
    return c;
  };
  // Le jeton d'une comparaison : ses deux arbres (40 hex chacun), séparés par « : ».
  const jeton = (j: unknown): string => {
    if (typeof j !== "string" || !JETON_RELECTURE.test(j)) throw new Error("jeton invalide");
    return j;
  };
  ipcMain.handle(CANAUX.relectureOuvrir, (e, p: unknown, j: unknown) => g.relecture.ouvrir(verifier(e, p), j === undefined || j === null ? undefined : jeton(j)));
  ipcMain.handle(CANAUX.relectureFichier, (e, p: unknown, j: unknown, c: unknown) => g.relecture.fichier(verifier(e, p), jeton(j), chemin(c)));
  ipcMain.handle(CANAUX.relectureLignes, (e, p: unknown, j: unknown, c: unknown, debut: unknown, fin: unknown) => {
    const projet = verifier(e, p);
    if (!entier(debut) || !entier(fin) || fin < debut) throw new Error("lignes invalides");
    return g.relecture.lignes(projet, jeton(j), chemin(c), debut, fin);
  });
  // Commentaires : texte borné comme une remarque, id d'un commentaire `c-<8 hex>`.
  const texte = (t: unknown): string => {
    if (typeof t !== "string" || t.length > TEXTE_REMARQUE_MAX) throw new Error("texte invalide");
    return t;
  };
  const idCommentaire = (id: unknown): string => {
    if (typeof id !== "string" || !ID_COMMENTAIRE.test(id)) throw new Error("commentaire invalide");
    return id;
  };
  ipcMain.handle(CANAUX.relectureCommentaires, (e, p: unknown) => g.relecture.commentaires(verifier(e, p)));
  ipcMain.handle(CANAUX.relectureCommenter, (e, p: unknown, j: unknown, c: unknown) => {
    const projet = verifier(e, p);
    const o = (c ?? {}) as Record<string, unknown>;
    if (typeof c !== "object" || c === null || !entier(o.debut) || !entier(o.fin) || o.fin < o.debut) throw new Error("lignes invalides");
    return g.relecture.commenter(projet, jeton(j), { fichier: chemin(o.fichier), debut: o.debut, fin: o.fin, texte: texte(o.texte) });
  });
  ipcMain.handle(CANAUX.relectureModifier, (e, p: unknown, id: unknown, t: unknown) => g.relecture.modifierCommentaire(verifier(e, p), idCommentaire(id), texte(t)));
  ipcMain.handle(CANAUX.relectureResoudre, (e, p: unknown, id: unknown, r: unknown) => {
    const projet = verifier(e, p);
    if (typeof r !== "boolean") throw new Error("résolu invalide");
    return g.relecture.resoudre(projet, idCommentaire(id), r);
  });
  ipcMain.handle(CANAUX.relectureSupprimer, (e, p: unknown, id: unknown) => g.relecture.supprimerCommentaire(verifier(e, p), idCommentaire(id)));
  ipcMain.handle(CANAUX.relectureEnvoyer, (e, p: unknown) => g.relecture.envoyer(verifier(e, p)));
  ipcMain.handle(CANAUX.relectureRelu, (e, p: unknown, j: unknown) => g.relecture.relu(verifier(e, p), jeton(j)));
}
