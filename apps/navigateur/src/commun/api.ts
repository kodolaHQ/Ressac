import { z } from "zod";
import { dossierValide, DROITS_DEV, ID_EXECUTION, ID_SITE, type Application, type Avertissement, type CatalogueBloc, type DeclarationWidget, type EtatDirect, type LectureBrouillon, type ResultatEnregistrement, type ResultatEssai, type DroitDev, type EtatIa, type EtatWidget, type Execution, type ResumeExecution, type EtatActions, type PageAction, type ResultatLancement, type Proprietaire } from "@webaios/noyau";
import type { EtatLot, IdProjet, ProjetExterne, ProjetSuivi } from "@webaios/noyau";
import { ID_PROJET, type Commentaire, type DiffFichier, type FichierModifie } from "@webaios/noyau";
import type { ActionAffichee } from "./actions";
import type { ActionSite, EtatFenetreSite, MessageVersLAccueil, SiteAffiche } from "./sites";
import type { BarreExtensions, LigneExtension, LigneExtensionEspace } from "./extensions";
import type { ZoneGauche } from "./revelation";
import type { Decision, DemandeEnAttente, EtatAcces, EtatNavigateur, IdEspace, IdFenetre, IdOnglet, Telechargement, Visite } from "./modele";

export { ARG_CALQUE, ARG_FENETRE, ARG_PASTILLE, ARG_SITE, CANAUX } from "./canaux";

const id = z.string().min(1);
const moteur = z.enum(["google", "duckduckgo", "qwant"]);

/** Les actions, validées à l'entrée du process principal : le schéma est la source du type. */
export const SchemaAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ouvrirOnglet"),
    fenetreId: id,
    url: z.string(),
    espaceId: id.optional(),
    activer: z.boolean().optional(),
    ouvertParAgent: z.boolean().optional(),
    apres: id.optional(),
  }),
  z.object({ type: z.literal("fermerOnglet"), id }),
  // garderEspace : l'onglet devient celui de son espace sans que la fenêtre change d'espace (demande d'une extension).
  z.object({ type: z.literal("activerOnglet"), id, garderEspace: z.boolean().optional() }),
  z.object({ type: z.literal("deplacerOnglet"), id, index: z.number().int() }),
  z.object({ type: z.literal("rouvrirOngletFerme"), fenetreId: id }),
  z.object({
    type: z.literal("majOnglet"),
    id,
    champs: z
      .object({
        url: z.string(),
        titre: z.string(),
        favicon: z.string().nullable(),
        chargement: z.boolean(),
        peutReculer: z.boolean(),
        peutAvancer: z.boolean(),
        zoom: z.number(),
        plante: z.boolean(),
        erreur: z.string().nullable(),
      })
      .partial(),
  }),
  z.object({ type: z.literal("ouvrirFavori"), fenetreId: id, genre: z.enum(["essentiel", "epingle"]), id }),
  z.object({ type: z.literal("epinglerOnglet"), id }),
  z.object({ type: z.literal("desepingler"), espaceId: id, favoriId: id }),
  z.object({ type: z.literal("ajouterEssentiel"), id }),
  z.object({ type: z.literal("retirerEssentiel"), favoriId: id }),
  /** `profil` : un profil de connexion existant, ou « nouveau » pour en créer un propre à l'espace. */
  z.object({ type: z.literal("creerEspace"), nom: z.string().min(1), icone: z.string().min(1), prive: z.boolean(), profil: id, fenetreId: id.optional() }),
  z.object({ type: z.literal("reglerEspace"), id, nom: z.string().min(1), icone: z.string().min(1), prive: z.boolean(), profil: id }),
  z.object({ type: z.literal("supprimerEspace"), id }),
  z.object({ type: z.literal("activerEspace"), fenetreId: id, id }),
  z.object({ type: z.literal("ouvrirFenetre"), id: id.optional(), espaceId: id.optional() }),
  z.object({ type: z.literal("fermerFenetre"), id }),
  z.object({
    type: z.literal("cadrerFenetre"),
    id,
    cadre: z.object({ x: z.number(), y: z.number(), largeur: z.number().positive(), hauteur: z.number().positive() }),
  }),
  z.object({ type: z.literal("afficherPageVide"), fenetreId: id }),
  z.object({ type: z.literal("basculerCompact"), fenetreId: id }),
  z.object({ type: z.literal("basculerPanneauAgent"), fenetreId: id }),
  /** Active la page Applications de l'espace actif, ou l'ouvre. */
  z.object({ type: z.literal("ouvrirApplications"), fenetreId: id }),
  /** Active la page Extensions de cette fenêtre, ou l'ouvre (comme Applications). */
  z.object({ type: z.literal("ouvrirExtensions"), fenetreId: id }),
  /** Active la page « Voir le workflow » du widget `id` dans cette fenêtre, ou l'ouvre. */
  z.object({
    type: z.literal("ouvrirWorkflow"),
    fenetreId: id,
    id: z.string().regex(/^[a-z0-9-]+$/).max(100),
    nom: z.string().max(60),
    /** Le workflow d'une action (`webaios://workflow/action/<id>`) plutôt que celui d'un widget. */
    proprietaire: z.literal("action").optional(),
  }),
  /**
   * Active la page de l'action `id` dans cette fenêtre (un onglet `webaios://action/<id>[/…]`, dans un espace non privé),
   * ou l'ouvre ; `execution` y montre ce résultat-là.
   */
  z.object({
    type: z.literal("ouvrirAction"),
    fenetreId: id,
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    nom: z.string().max(60),
    execution: z.string().regex(ID_EXECUTION).max(64).optional(),
  }),
  /** Active la page « Actions » de cette fenêtre, ou l'ouvre. */
  z.object({ type: z.literal("ouvrirActions"), fenetreId: id }),
  /** Ouverture et fermeture automatiques du panneau par la page d'accueil (pas une action de l'utilisateur). */
  z.object({ type: z.literal("panneauAgentAccueil"), fenetreId: id, ouvert: z.boolean() }),
  z.object({ type: z.literal("choisirMoteur"), moteur }),
  z.object({ type: z.literal("choisirProfilAgent"), profil: z.string().regex(/^[\w-]+$/).max(64) }),
  z.object({ type: z.literal("largeurPanneauAgent"), largeur: z.number().finite() }),
  /** Active la page Relecture du projet dans cette fenêtre, ou l'ouvre (une par projet et par fenêtre). */
  z.object({ type: z.literal("ouvrirRelecture"), fenetreId: id, projet: z.string().regex(ID_PROJET), nom: z.string().max(80) }),
]);
export type Action = z.infer<typeof SchemaAction>;

export const SchemaCommande = z.union([
  z.object({ ongletId: id, c: z.enum(["reculer", "avancer", "recharger", "rechargerSansCache", "arreter", "finRecherche", "outils"]) }),
  z.object({ ongletId: id, c: z.object({ zoom: z.enum(["plus", "moins", "zero"]) }) }),
  z.object({ ongletId: id, c: z.object({ chercher: z.string(), suivant: z.boolean().optional(), precedent: z.boolean().optional() }) }),
]);
export type CommandeOnglet = z.infer<typeof SchemaCommande>["c"];

export const SchemaBornes = z.object({ x: z.number(), y: z.number(), largeur: z.number(), hauteur: z.number() });
export type Bornes = z.infer<typeof SchemaBornes>;
export const SchemaBoutonsFenetre = z.object({ visibles: z.boolean() }).strict();

export type Panneau = "historique" | "telechargements";
/**
 * Raccourcis du menu destinés à l'interface (la page web a souvent le focus). `fermerOnglet` : ⌘W sur le constructeur,
 * qui demande d'abord si du code n'est pas enregistré.
 */
export type Raccourci = "rechercher" | "chercherSuivant" | "chercherPrecedent" | "adresse" | "agent" | "fermerOnglet";
export interface ResultatRecherche {
  ongletId: IdOnglet;
  actif: number;
  total: number;
}

/** API exposée à l'interface par le preload (`window.webaios`). */
export interface ApiWebaios {
  fenetreId: IdFenetre;
  agir(action: Action): void;
  surEtat(rappel: (e: EtatNavigateur) => void): () => void;
  /** `ongletId` null : la saisie ouvre un nouvel onglet (page vide). */
  naviguer(ongletId: IdOnglet | null, saisie: string): void;
  commande(ongletId: IdOnglet, c: CommandeOnglet): void;
  bornesContenu(b: Bornes): void;
  /** macOS : les boutons de la fenêtre suivent la barre latérale (cachés avec elle en mode compact). */
  boutonsFenetre(visibles: boolean): void;
  /** Mode compact : au-dessus d'une page web, la souris change de zone par rapport au bord gauche (voir revelation.ts). */
  surZoneGauche(rappel: (zone: ZoneGauche) => void): () => void;
  /** Le menu demande d'ouvrir un panneau de l'interface (⌘Y…). */
  surPanneau(rappel: (p: Panneau) => void): () => void;
  surRaccourci(rappel: (r: Raccourci) => void): () => void;
  surResultatRecherche(rappel: (r: ResultatRecherche) => void): () => void;
  /** Plein écran HTML (vidéo…) : l'interface s'efface. */
  surPleinEcran(rappel: (actif: boolean) => void): () => void;
  historique: {
    /** `distinctes` : une seule ligne par URL (barre d'adresse) ; sinon une par URL et par espace. */
    rechercher(texte: string, limite?: number, distinctes?: boolean): Promise<Visite[]>;
    recents(): Promise<Visite[]>;
    /** `depuis` : date ISO ; absent, tout l'historique. */
    effacer(depuis?: string): Promise<void>;
    /** Oublie le texte retenu d'une visite (une URL dans un espace), sans effacer la visite. */
    oublierTexte(url: string, espaceId: string): Promise<void>;
  };
  telechargements: {
    liste(): Promise<Telechargement[]>;
    ouvrir(id: string): void;
    montrer(id: string): void;
    annuler(id: string): void;
  };
  surTelechargements(rappel: (liste: Telechargement[]) => void): () => void;
  permissions: {
    enAttente(): Promise<DemandeEnAttente[]>;
    /** `o.confirme` : la case « Je comprends » d'une carte d'extension renforcée est cochée. */
    repondre(id: string, decision: Decision, droits?: DroitDev[], o?: { confirme?: boolean }): void;
  };
  surPermissions(rappel: (liste: DemandeEnAttente[]) => void): () => void;
  /**
   * Une modale s'ouvre : le clavier revient à l'interface, et la page affichée par `ongletId` est capturée (data URL
   * JPEG réduite) pour rester visible, floutée, derrière la modale. null : pas de page à montrer, ou capture ratée.
   */
  apercuPage(ongletId: IdOnglet | null): Promise<string | null>;
  /** Terminal de l'agent de cette fenêtre. */
  agent: {
    /** Démarre la session (ou la retrouve : son état et sa sortie récente sont renvoyés). */
    demarrer(t: TailleTerminal): void;
    ecrire(d: string): void;
    redimensionner(t: TailleTerminal): void;
    surDonnees(rappel: (d: string) => void): () => void;
    surEtat(rappel: (e: EtatPanneauAgent) => void): () => void;
    /** Profils d'agent disponibles (le choix passe par l'action choisirProfilAgent). */
    profils(): Promise<{ id: string; nom: string }[]>;
  };
  /** Accès de l'agent aux onglets (pastilles et bulle pour le couper). */
  acces: {
    etat(): Promise<EtatAcces>;
    couper(id: IdOnglet, droit?: DroitDev): void;
  };
  /** L'accès de l'agent à un onglet a changé : l'état complet est rediffusé. */
  surAcces(rappel: (e: EtatAcces) => void): () => void;
  /** Page d'accueil : les widgets de accueil/widgets de l'espace de l'agent. */
  accueil: {
    lire(): Promise<WidgetAffiche[]>;
    /** Un widget, sa disposition, ses données ou son état ont changé : relire. */
    surChange(rappel: () => void): () => void;
    /** Nouvelle disposition (tous les widgets placés) ; refusée si un placement sort de la grille ou vise un id inconnu. */
    placer(placements: Placement[]): void;
    /** Met le widget à la corbeille (accueil/.corbeille) et retire son accord. */
    retirer(id: string): void;
    /**
     * Lien demandé par l'affichage du widget `id` : http(s) seulement, dans un onglet de cette fenêtre. Ouvert seulement
     * si un vrai clic de l'utilisateur vient de tomber dans l'affichage de ce widget (vu par le preload du cadre).
     */
    ouvrir(url: string, id: string): void;
    /** Profils de connexion qu'un accord peut utiliser (jamais celui d'un espace privé). */
    profilsPourAccord(): Promise<ProfilPourAccord[]>;
    /**
     * L'utilisateur autorise le widget à lire avec son compte, dans ce profil. `compte` et `publiques` : exactement ce que la
     * carte lui a montré ; refusé (avec l'erreur) si la déclaration a changé depuis.
     */
    accorder(a: Accord): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** L'utilisateur refuse ou retire l'accord : les données lues avec le compte sont effacées. */
    refuserAccord(id: string): void;
    /** « Mettre à jour maintenant ». */
    recolter(id: string): void;
    /** Les dernières exécutions du widget, la plus récente d'abord. */
    executions(id: string): Promise<ResumeExecution[]>;
    /** Une exécution complète (blocs, sorties, journaux) ; null si elle n'existe plus ou si l'id est invalide. */
    execution(id: string, execution: string): Promise<Execution | null>;
  };
  /**
   * Constructeur visuel des workflows : celui d'un widget (page `webaios://workflow/<id>`) ou d'une action
   * (`webaios://workflow/action/<id>`, refusé quand l'espace actif de la fenêtre est privé).
   */
  workflow: {
    catalogue(): Promise<CatalogueBloc[]>;
    /** null : widget ou action inconnus, ou sans workflow. */
    lire(cible: Proprietaire): Promise<EditionWorkflow | null>;
    enregistrer(cible: Proprietaire, brouillon: Brouillon): Promise<ResultatEnregistrement & { avertissements: Avertissement[] }>;
    lireCode(cible: Proprietaire, nom: string): Promise<{ texte: string } | { absent: true } | { erreur: string }>;
    enregistrerCode(cible: Proprietaire, nom: string, texte: string): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** Un essai ; pour une action, sa page se voit dans l'aperçu, jamais comme dernier résultat. */
    rejouer(cible: Proprietaire, execution: string, bloc: string): Promise<ResultatEssai>;
    /**
     * Lance une vraie exécution maintenant ; rend son id (absent si l'agent est arrêté ou si rien n'a tourné). Une action
     * reçoit `saisie` et peut rendre le refus (`erreur` : saisie requise, accord requis…).
     */
    lancer(cible: Proprietaire, saisie?: string | null): Promise<{ execution?: string; erreur?: string }>;
    /** Le bloc sélectionné dans le constructeur de cette fenêtre (pour workflow_ouvert). */
    selection(cible: Proprietaire, bloc: string | null): void;
    /** Les exécutions des widgets qui tournent (celles des actions : `actions.direct`). */
    direct(): Promise<EtatDirect>;
    surDirect(rappel: (e: EtatDirect) => void): () => void;
  };
  /** IA locale (Kev et Gemma) des récoltes. */
  ia: {
    etat(): Promise<EtatIaAffiche>;
    /** Télécharge Kev et Gemma (plusieurs gigaoctets) : seulement sur un clic de l'utilisateur. */
    installer(): Promise<{ ok: boolean; erreur?: string }>;
    surEtat(rappel: (e: EtatIaAffiche) => void): () => void;
    /** Une ligne de la sortie de l'installation. */
    surProgres(rappel: (ligne: string) => void): () => void;
  };
  /**
   * Les actions (`~/WebAiOs/actions`) et leurs pages. Refusé quand l'espace actif de la fenêtre est privé
   * (`ACTIONS_EN_ESPACE_PRIVE`, ou rien : `[]`, `null`).
   */
  actions: {
    liste(): Promise<ActionAffichee[]>;
    /** Une action, un composant ou un dernier résultat a changé : relire. */
    surChange(rappel: () => void): () => void;
    /**
     * Le choix d'une suggestion : la page de l'action s'ouvre (ou celle qui montre l'exécution en cours) et l'action est
     * lancée, sauf si elle tourne déjà ou que sa saisie requise manque.
     */
    ouvrir(id: string, saisie: string | null): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** « Relancer » depuis la page : rend l'issue de l'exécution, à sa fin. */
    lancer(id: string, saisie: string | null): Promise<ResultatLancement>;
    arreter(id: string): void;
    /** Ce résultat (null : le dernier), sans rien relancer ; null s'il n'y en a pas. */
    page(id: string, execution: string | null): Promise<PageAction | null>;
    executions(id: string): Promise<ResumeExecution[]>;
    /** Une exécution complète (blocs, sorties, journaux), pour le constructeur ; null si elle n'existe plus. */
    execution(id: string, execution: string): Promise<Execution | null>;
    direct(): Promise<EtatActions>;
    surDirect(rappel: (e: EtatActions) => void): () => void;
    /** Un lien de la page : ouvert dans un onglet seulement si l'adresse figure telle quelle dans les résultats. */
    ouvrirLien(id: string, execution: string, url: string): void;
    /** Profils de connexion qu'un accord peut utiliser (jamais celui d'un espace privé). */
    profilsPourAccord(): Promise<ProfilPourAccord[]>;
    /** Comme pour un widget ; rien n'est lancé (L'utilisateur relance depuis la page). */
    accorder(a: Accord): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** Retire l'accord et efface exécutions, résultats et mémoire. */
    refuserAccord(id: string): Promise<void>;
    /** Met l'action à la corbeille (`actions/.corbeille`) et oublie son accord et ses données. */
    supprimer(id: string): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** Ouvre le constructeur sur le workflow de l'action. */
    voirWorkflow(id: string): void;
  };
  /** Page Applications (projets de l'espace de l'agent). */
  applications: {
    liste(): Promise<ListeApplications>;
    /** Un projet ou l'état d'une appli a changé : relire. */
    surChange(rappel: () => void): () => void;
    agir(dossier: string, action: ActionApplication): void;
  };
  /** Section « Sites » de la page Applications : les applis de site de l'espace de l'agent. */
  sites: {
    liste(): Promise<SiteAffiche[]>;
    /** Une appli de site est apparue, a changé, s'est ouverte ou fermée : relire. */
    surChange(rappel: () => void): () => void;
    agir(id: string, action: ActionSite): void;
  };
  extensions: {
    /**
     * Installe une extension du Chrome Web Store (adresse de sa page ou id) dans l'espace actif de cette fenêtre, après la
     * carte d'accord. Saisie illisible : « Adresse ou identifiant du Chrome Web Store attendu ».
     */
    installerStore(saisie: string): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** Les extensions installées ou accordées, et les dossiers de l'agent jamais accordés, vus depuis cet espace. */
    pourEspace(espaceId: IdEspace): Promise<LigneExtensionEspace[]>;
    /** Active ou désactive une extension dans le profil de cet espace (l'agent sans accord passe par la carte). */
    basculer(cle: string, espaceId: IdEspace, actif: boolean): Promise<{ ok: true } | { ok: false; erreur: string }>;
    /** Le registre des extensions a changé (ou leurs erreurs) : relire. */
    surChange(rappel: () => void): () => void;
    /** Toutes les extensions du registre (page Extensions). */
    liste(): Promise<LigneExtension[]>;
    /** « Désactiver toutes les extensions » est-il en vigueur ? */
    coupees(): Promise<boolean>;
    /** Les extensions chargées dans le profil de l'espace actif de cette fenêtre. */
    barre(): Promise<BarreExtensions>;
    epingler(cle: string, oui: boolean): Promise<ResultatExtension>;
    /** Retirée de tous les profils (l'accord reste). */
    desactiverPartout(cle: string): Promise<ResultatExtension>;
    /** Store : désinstallée ; agent : accord et copie effacés (le dossier de l'agent reste). */
    supprimer(cle: string): Promise<ResultatExtension>;
    /** « Désactiver toutes les extensions » : rien n'est chargé tant que c'est vrai, même après un redémarrage. */
    toutCouper(oui: boolean): Promise<ResultatExtension>;
    /** La carte de la mise à jour en attente (Store) ou de la portée élargie (agent), dans cette fenêtre. */
    revoir(cle: string): Promise<ResultatExtension>;
    /** Une extension désactivée pour ses plantages repart (là où elle était active). */
    reactiver(cle: string): Promise<ResultatExtension>;
    /** « Couper le déblocage » de la console d'une extension de l'agent. */
    couperDeblocage(cle: string): Promise<ResultatExtension>;
  };
  /** Mode design de l'onglet actif de cette fenêtre, et paniers de remarques. */
  design: ApiDesign;
  externes: ApiExternes;
  relecture: ApiRelecture;
}


export type ResultatExtension = { ok: true } | { ok: false; erreur: string };

/** Une appli telle que la page l'affiche : ce que dit le gestionnaire, et ce que le navigateur en a retenu. */
export type ApplicationAffichee = Application & { favicon?: string; dernierLancement?: string };
export interface ListeApplications {
  atelier: "ok" | "docker-absent";
  applications: ApplicationAffichee[];
}
/** Un seul segment de chemin : ni séparateur, ni `.`/`..`, ni NUL. */
const segmentValide = (d: string) => d !== "" && d !== "." && d !== ".." && !/[/\\\0]/.test(d);
/** Actions possibles sur un projet « Sans fiche » dont le nom de dossier n'est pas lançable (`My Project`, `_tmp`…). */
const SUR_TOUT_DOSSIER = new Set(["deboguer", "supprimer", "dossier"]);

export const SchemaActionApplication = z
  .object({
    dossier: z.string(),
    action: z.enum(["lancer", "arreter", "relancer", "ouvrir", "deboguer", "supprimer", "promouvoir", "dossier", "relire"]),
  })
  .refine(({ dossier, action }) => (SUR_TOUT_DOSSIER.has(action) ? segmentValide(dossier) : dossierValide(dossier)));
export type ActionApplication = z.infer<typeof SchemaActionApplication>["action"];

/** Une action sur une appli de site : son id suit `ID_SITE` (jamais un chemin). */
export const SchemaActionSite = z.object({
  id: z.string().regex(ID_SITE),
  action: z.enum(["ouvrir", "modifier", "oublier", "dossier", "supprimer"]),
});

export const SchemaActionTelechargement = z.object({ id, action: z.enum(["ouvrir", "montrer", "annuler"]) });
/** `droits` : la sélection de l'utilisateur sur la carte des outils de développement (n'importe quel sous-ensemble des quatre droits). */
export const SchemaReponsePermission = z.object({
  id,
  decision: z.enum(["autoriser", "refuser"]),
  droits: z.array(z.enum(DROITS_DEV as [DroitDev, ...DroitDev[]])).optional(),
  confirme: z.boolean().optional(),
});

/** Couper un droit de l'agent sur un onglet, ou tout son accès si `droit` est absent. */
export const SchemaCouperAcces = z.object({ id, droit: z.enum(DROITS_DEV as [DroitDev, ...DroitDev[]]).optional() });

/** Capture de la page affichée, pour le fond d'une modale : l'onglet que l'interface voit actif, ou aucun. */
export const SchemaApercuPage = z.object({ ongletId: id.nullable() });

/** La pastille d'une fenêtre d'appli s'agrandit (bulle ouverte) ou se referme. */
export const SchemaTaillePastille = z.object({ ouverte: z.boolean() });

/** Ce que montre le panneau agent d'une fenêtre. */
export type EtatPanneauAgent =
  | { etat: "preparation" }
  | { etat: "docker-absent" }
  | { etat: "erreur"; message: string }
  | { etat: "actif" }
  | { etat: "termine"; code: number };

const COLONNES_GRILLE = 12;
const idWidget = z.string().regex(/^[a-z0-9-]+$/).max(100);
export const SchemaIdWidget = idWidget;
/** Id d'une action (nom de son dossier sous `~/WebAiOs/actions`). */
export const SchemaIdAction = z.string().regex(/^[a-z0-9-]{1,60}$/);
/** Saisie d'une action venue de l'interface : bornée ici, coupée par le noyau. */
export const SchemaSaisieAction = z.string().max(2000).nullable();
/** Ce qu'ouvre le constructeur : le workflow d'un widget ou celui d'une action. */
export const SchemaCible = z.discriminatedUnion("type", [
  z.object({ type: z.literal("widget"), id: idWidget }).strict(),
  z.object({ type: z.literal("action"), id: SchemaIdAction }).strict(),
]);

/**
 * Id d'un bloc venu de l'interface : borné en taille seulement (jamais un chemin). Le moteur valide la forme et nomme
 * le bloc en cause : un id écrit par l'agent qu'il refuse doit lui parvenir.
 */
export const SchemaBlocWorkflow = z.string().min(1).max(200);
/** Nom d'un fichier de code du widget : un `.mjs` à la racine de son dossier. */
export const SchemaNomCode = z.string().regex(/^[a-z0-9-]+\.mjs$/).max(64);
/** Texte d'un `.mjs` : 256 Ko au plus (en octets, comme à l'écriture). */
export const SchemaCodeWorkflow = z.string().max(256 * 1024).refine((t) => new TextEncoder().encode(t).length <= 256 * 1024, "code trop gros");
/**
 * Brouillon du constructeur : borné mais pas forcément valide pour le moteur (c'est `enregistrerWorkflow` qui répond).
 * Les paramètres restent libres : le moteur les valide.
 */
export const SchemaBrouillon = z.object({
  version: z.literal(1),
  blocs: z
    .array(
      z.object({
        id: SchemaBlocWorkflow,
        type: z.string().min(1).max(200),
        nom: z.string().max(200).optional(),
        position: z.object({ x: z.number().finite(), y: z.number().finite() }),
        parametres: z.record(z.string(), z.unknown()),
      }),
    )
    .max(100),
  liens: z.array(z.object({ de: SchemaBlocWorkflow, vers: SchemaBlocWorkflow })).max(400),
});

/** Le bloc sélectionné dans le constructeur d'une fenêtre, et le workflow (widget ou action) où il l'est. */
export type SelectionConstructeur = { widget: string; bloc: string | null } | { action: string; bloc: string | null };
/**
 * Le bloc sélectionné dans le constructeur : un bloc invalide devient « aucun » (`workflow_ouvert` ne montre jamais
 * l'ancien) ; null, message ignoré, si la cible est invalide.
 */
export function selectionConstructeur(v: unknown): SelectionConstructeur | null {
  const o = v as { cible?: unknown; bloc?: unknown } | null;
  const cible = SchemaCible.safeParse(o?.cible);
  if (!cible.success) return null;
  const r = SchemaBlocWorkflow.safeParse(o?.bloc);
  const bloc = r.success ? r.data : null;
  return cible.data.type === "widget" ? { widget: cible.data.id, bloc } : { action: cible.data.id, bloc };
}
export type Brouillon = z.infer<typeof SchemaBrouillon>;

export type EditionWorkflow = LectureBrouillon & {
  avertissements: Avertissement[];
  /** Ce que `widget.json` déclare, en lecture seule ; `recolte` null : le widget n'en déclare pas. Absent pour une action. */
  widget?: {
    nom: string;
    compte: string[];
    publiques: string[];
    config: unknown;
    web: boolean;
    recolte: { minutes: number | null; heures: string[]; dureeMaxMinutes: number | null; notifier: boolean } | null;
  };
  /** Ce que `action.json` déclare, en lecture seule (jamais écrit par WebAiOs). Absent pour un widget. */
  action?: {
    nom: string;
    compte: string[];
    publiques: string[];
    web: boolean;
    saisie: { libelle: string } | null;
    miseEnPage: string | null;
    dureeMaxMinutes: number | null;
  };
};
/** Id d'une exécution : son début ISO sans « : » ni « . » (jamais un chemin). */
export const SchemaIdExecution = z.string().regex(ID_EXECUTION).max(64);
const cote = z.number().int().min(1).max(COLONNES_GRILLE);
/** Les placements de la grille de 12 colonnes : entiers, dans la grille, un seul par widget. */
export const SchemaPlacements = z
  .array(
    z
      .object({ id: idWidget, x: z.number().int().min(0).max(COLONNES_GRILLE - 1), y: z.number().int().min(0).max(10_000), l: cote, h: cote })
      .strict()
      .refine((p) => p.x + p.l <= COLONNES_GRILLE, "déborde de la grille"),
  )
  .max(500)
  .refine((ps) => new Set(ps.map((p) => p.id)).size === ps.length, "widget placé deux fois");
const domaine = z.string().min(1).max(253);
export const SchemaAccord = z
  .object({ id: idWidget, profil: z.string().min(1).max(200), compte: z.array(domaine).max(100), publiques: z.array(domaine).max(100) })
  .strict();
export type Accord = z.infer<typeof SchemaAccord>;
export const SchemaOuvrirWidget = z.object({ url: z.string().min(1).max(8192), id: idWidget }).strict();
export const SchemaTailleTerminal = z.object({ cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) });
export type TailleTerminal = z.infer<typeof SchemaTailleTerminal>;

/** Place d'un widget dans la grille de 12 colonnes (rangées de 90 px). */
export interface Placement {
  id: string;
  x: number;
  y: number;
  l: number;
  h: number;
}

/** Un widget de la page d'accueil, tel que l'interface l'affiche. */
export type WidgetAffiche =
  | {
      id: string;
      nom: string;
      placement: Placement;
      tailles: DeclarationWidget["tailles"];
      /** `webaios-widget://<id>/affichage.html?v=<mtime>`, ou null tant que l'agent n'a pas écrit l'affichage. */
      src: string | null;
      donnees: unknown | null;
      exemple: unknown | null;
      etat: EtatWidget;
      /** Domaines lus avec le compte de l'utilisateur (vide : sources publiques seulement). */
      compte: string[];
      /** Domaines publics que le widget peut contacter ; pour un widget avec compte, couverts par le même accord. */
      publiques: string[];
      /** Le widget a une récolte (`workflow.json` ou `recolte.mjs`) : son menu propose « Voir / modifier le workflow ». */
      aRecolte: boolean;
      /** Heures fixes de la récolte (« HH:MM »), vide sans elles. */
      heures: string[];
      /** Fréquence de la récolte en minutes, null sans elle. */
      minutes: number | null;
    }
  | { id: string; erreur: string; placement: Placement };

export interface ProfilPourAccord {
  id: string;
  /** « Profil de « Perso, Travail » » : les espaces qui l'utilisent. */
  libelle: string;
  /** Le profil de l'espace actif de la fenêtre, s'il peut servir. */
  parDefaut: boolean;
}

/** État de l'IA locale pour l'indicateur ; `verification` : ce qui est en place (absent si non vérifié). */
export interface EtatIaAffiche {
  etat: EtatIa;
  erreur?: string;
  verification?: { kev: boolean; uv: boolean; ollama: boolean; gemma: boolean };
}

/** Ce que l'interface de la pastille d'une fenêtre d'appli reçoit du preload : l'accès de l'agent et le mode design de son appli. */
export type ApiPastille = Pick<ApiWebaios, "acces" | "surAcces"> & {
  /** Demande au process principal d'agrandir (bulle ouverte) ou de rétrécir la vue de la pastille. */
  pastilleTaille(ouverte: boolean): void;
  /** Le mode design de la fenêtre d'appli ; « Panier » l'ouvre dans le calque de la fenêtre. */
  design: { etat(): Promise<EtatDesign>; basculer(): void; panier(): void; relire(): void };
};

/**
 * L'unique API de l'interface d'une fenêtre d'appli de site (`site.html`). Le process principal reconnaît l'appli à
 * l'expéditeur, jamais à ce que l'interface dit.
 */
export interface ApiSite {
  etat(): Promise<EtatFenetreSite | null>;
  surEtat(rappel: (e: EtatFenetreSite) => void): () => void;
  /** « Entrer dans le site » : la vue du site, chargée sur l'adresse de départ la première fois seulement. */
  entrer(): void;
  /** ⌂ : retour à l'écran d'accueil, la page du site reste chargée dessous. */
  accueil(): void;
  precedent(): void;
  suivant(): void;
  recharger(): void;
  /** « Ouvrir dans un onglet » : le dernier lien bloqué, dans un onglet de la fenêtre principale. */
  ouvrirBloque(): void;
  /** « Chercher la nouvelle adresse » : lit la page de référence (au plus une fois par minute) ; sans effet si l'appli n'en a pas. */
  chercherAdresse(): void;
  /**
   * La carte d'accord des retouches. oui : l'accord est retenu, puis la vue suivante (accueil ou site) avec retouches ;
   * non : la vue suivante sans retouches ni reprise, pour cette ouverture seulement (la carte revient à la prochaine).
   * `empreinte` : celle de la carte cliquée ; si les droits ont changé depuis, rien n'est accordé et la carte revient à jour.
   */
  accorder(oui: boolean, empreinte: string): Promise<void>;
  /** Pour l'écran d'accueil : la mémoire de l'appli et ses positions de reprise (lecture), et le domaine actuel. */
  memoire(): Promise<MessageVersLAccueil & { type: "memoire" }>;
  /** Chaque changement de la mémoire de l'appli ; renvoie le désabonnement. */
  surMemoire(rappel: (m: MessageVersLAccueil & { type: "memoire" }) => void): () => void;
  /**
   * L'accueil demande une adresse du site (relative ou sur un de ses domaines) : la vue du site y va, sur le domaine
   * actuel. Faux si elle est refusée, ou si une autre vient d'être ouverte (une par `ECART_OUVERTURE_ACCUEIL_MS`).
   */
  ouvrir(adresse: string): Promise<boolean>;
  /** Une image d'un domaine de l'appli, chargée avec sa session, en `data:` ; null si elle est refusée. */
  image(url: string): Promise<string | null>;
}

/** Le mode design d'une cible (onglet actif d'une fenêtre, ou fenêtre d'appli). */
export interface EtatDesign {
  actif: boolean;
  projet: ProjetSuivi | null;
  /** Raison pour laquelle le mode design n'est pas proposé ici ; null s'il l'est. */
  indisponible: string | null;
  /** « l'agent », « Claude Code (<nom>) » ; null si personne ne peut recevoir les remarques. */
  destination: string | null;
  /** Pourquoi `destination` est null (aucun Claude Code branché). */
  sansDestination: string | null;
  /** Nombre de remarques dans le panier du projet. */
  panier: number;
  /** Nom du projet à afficher. */
  nom: string;
}
/** Une remarque telle que le panier et l'historique l'affichent : du texte, jamais du HTML. */
export interface ElementAffiche {
  id: string;
  type: "design" | "relecture";
  etiquette: string;
  texte: string;
  source: string | null;
  traite: { quand: string; note?: string } | null;
}
export interface LotAffiche {
  id: string;
  cree: string;
  etat: EtatLot;
  destination: "agent" | "mcp";
  elements: ElementAffiche[];
}
export interface ApiDesign {
  etat(): Promise<EtatDesign>;
  /** ⌘⇧D : sans effet là où le mode est indisponible. */
  basculer(): void;
  panier(projet: IdProjet): Promise<ElementAffiche[]>;
  retirer(projet: IdProjet, id: string): Promise<void>;
  envoyer(projet: IdProjet): Promise<ResultatExtension>;
  lots(projet: IdProjet): Promise<LotAffiche[]>;
  traite(projet: IdProjet, lot: string): Promise<void>;
  /** « Relire ce projet » (projets `app` et `externe`). */
  relire(): void;
  surChange(rappel: () => void): () => void;
}
/** Ce que montre le calque : la bulle d'une remarque (élément visé) ou le panier d'une fenêtre d'appli. */
export interface ContexteCalque {
  mode: "bulle" | "panier";
  projet: IdProjet;
  etiquette: string;
  source: string | null;
  destination: string | null;
  sansDestination: string | null;
}
/** L'unique API du calque du mode design (`design.html`) ; le process principal reconnaît sa cible à l'expéditeur. */
export type ApiCalque = {
  contexte(): Promise<ContexteCalque | null>;
  ajouter(texte: string): Promise<ResultatExtension>;
  /** Échap ou « Annuler » dans la bulle ; « Fermer » du panier. */
  annuler(): void;
} & Pick<ApiDesign, "panier" | "retirer" | "envoyer" | "lots" | "traite" | "surChange">;
/** Texte d'une remarque : borné à l'entrée du process principal. */
export const TEXTE_REMARQUE_MAX = 4000;

/** Section « Projets externes » de la page Applications : le MCP externe, ses projets et ses clients (jamais un jeton). */
export interface EtatExternes {
  serveur: { etat: "pret"; port: number } | { etat: "eteint"; raison: string };
  projets: (ProjetExterne & { client: string | null; nomClient: string | null })[];
  clients: { id: string; nom: string; cree: string }[];
}
export interface ApiExternes {
  liste(): Promise<EtatExternes>;
  /** La commande à copier dans le terminal du Claude Code : le jeton n'y paraît qu'une fois. */
  brancher(nom: string): Promise<{ commande: string }>;
  revoquer(id: string): Promise<void>;
  oublier(id: string): Promise<void>;
  /** « Relire » : la page de relecture du projet. */
  relire(id: string): void;
  surChange(rappel: () => void): () => void;
}

/** Page Relecture : ce qu'elle montre d'un projet (le diff depuis la dernière relecture), ou pourquoi elle ne le peut pas. */
export type VueRelecture =
  | {
      etat: "ok"; nom: string; jeton: string; comparaison: { fichiers: FichierModifie[] }; commentaires: Commentaire[];
      /** À qui vont les commentaires (« l'agent », « Claude Code (…) ») ; sinon pourquoi ils ne peuvent pas partir. */
      destination: string | null; sansDestination: string | null;
    }
  | { etat: "indisponible"; nom: string; raison: string };
export type { DiffFichier, FichierModifie, Commentaire };
export interface ApiRelecture {
  /**
   * Compare le projet à sa dernière relecture et rend le jeton de cette comparaison (gardée par le process principal).
   * Avec le jeton d'une comparaison encore gardée : celle-là, sans comparer de nouveau ; « Rafraîchir » n'en passe pas.
   */
  ouvrir(projet: IdProjet, jeton?: string): Promise<VueRelecture>;
  /** Le diff d'un fichier de la comparaison du jeton (jamais un autre chemin) ; un jeton qui n'est plus gardé est refusé. */
  fichier(projet: IdProjet, jeton: string, chemin: string): Promise<DiffFichier>;
  /** Lignes `debut`..`fin` (à partir de 1) de la version courante d'un fichier de la comparaison du jeton. */
  lignes(projet: IdProjet, jeton: string, chemin: string, debut: number, fin: number): Promise<string[]>;
  /** Les commentaires du projet, tels qu'enregistrés. */
  commentaires(projet: IdProjet): Promise<Commentaire[]>;
  /** Un commentaire sur des lignes d'un seul bloc du diff du jeton ; les lignes sont lues par le process principal. */
  commenter(projet: IdProjet, jeton: string, c: { fichier: string; debut: number; fin: number; texte: string }): Promise<ResultatExtension>;
  modifierCommentaire(projet: IdProjet, id: string, texte: string): Promise<void>;
  resoudre(projet: IdProjet, id: string, resolu: boolean): Promise<void>;
  supprimerCommentaire(projet: IdProjet, id: string): Promise<void>;
  /** Les commentaires non résolus partent en un lot (agent : pré-rempli, jamais envoyé ; externe : file du MCP). */
  envoyer(projet: IdProjet): Promise<ResultatExtension>;
  /** « Marquer comme relu » : retient l'arbre montré par la comparaison du jeton, puis rend une nouvelle comparaison. */
  relu(projet: IdProjet, jeton: string): Promise<VueRelecture>;
}
