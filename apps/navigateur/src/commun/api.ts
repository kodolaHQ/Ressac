import { z } from "zod";
import { dossierValide, DROITS_DEV, type Application, type DeclarationWidget, type DroitDev, type EtatIa, type EtatWidget } from "@webaios/noyau";
import type { ZoneGauche } from "./revelation";
import type { Decision, DemandeEnAttente, EtatAcces, EtatNavigateur, IdFenetre, IdOnglet, Telechargement, Visite } from "./modele";

export { ARG_FENETRE, ARG_PASTILLE, CANAUX } from "./canaux";

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
  z.object({ type: z.literal("activerOnglet"), id }),
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
  /** Ouverture et fermeture automatiques du panneau par la page d'accueil (pas une action de l'utilisateur). */
  z.object({ type: z.literal("panneauAgentAccueil"), fenetreId: id, ouvert: z.boolean() }),
  z.object({ type: z.literal("choisirMoteur"), moteur }),
  z.object({ type: z.literal("choisirProfilAgent"), profil: z.string().regex(/^[\w-]+$/).max(64) }),
  z.object({ type: z.literal("largeurPanneauAgent"), largeur: z.number().finite() }),
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

export type Panneau = "historique" | "telechargements";
/** Raccourcis du menu destinés à l'interface (la page web a souvent le focus). */
export type Raccourci = "rechercher" | "chercherSuivant" | "chercherPrecedent" | "adresse" | "agent";
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
    repondre(id: string, decision: Decision, droits?: DroitDev[]): void;
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
  /** Page Applications (projets de l'espace de l'agent). */
  applications: {
    liste(): Promise<ListeApplications>;
    /** Un projet ou l'état d'une appli a changé : relire. */
    surChange(rappel: () => void): () => void;
    agir(dossier: string, action: ActionApplication): void;
  };
}

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
    action: z.enum(["lancer", "arreter", "relancer", "ouvrir", "deboguer", "supprimer", "promouvoir", "dossier"]),
  })
  .refine(({ dossier, action }) => (SUR_TOUT_DOSSIER.has(action) ? segmentValide(dossier) : dossierValide(dossier)));
export type ActionApplication = z.infer<typeof SchemaActionApplication>["action"];

export const SchemaActionTelechargement = z.object({ id, action: z.enum(["ouvrir", "montrer", "annuler"]) });
/** `droits` : la sélection de l'utilisateur sur la carte des outils de développement (n'importe quel sous-ensemble des quatre droits). */
export const SchemaReponsePermission = z.object({
  id,
  decision: z.enum(["autoriser", "refuser"]),
  droits: z.array(z.enum(DROITS_DEV as [DroitDev, ...DroitDev[]])).optional(),
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

/** Ce que l'interface de la pastille d'une fenêtre d'appli reçoit du preload : l'accès de l'agent, rien d'autre. */
export type ApiPastille = Pick<ApiWebaios, "acces" | "surAcces"> & {
  /** Demande au process principal d'agrandir (bulle ouverte) ou de rétrécir la vue de la pastille. */
  pastilleTaille(ouverte: boolean): void;
};
