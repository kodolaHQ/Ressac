import { z } from "zod";
import type { EntreeMemoire, PositionVideo } from "@webaios/noyau";

/** Messages et types de la fenêtre d'une appli de site, lus aussi par l'interface (`site.html`, page Applications). */

/** Hauteur de la barre d'une fenêtre d'appli de site, en px : la vue du site est posée juste dessous. */
export const HAUTEUR_BARRE_SITE = 36;

export const ENTRER_DANS_LE_SITE = "Entrer dans le site";
export const lienBloque = (domaine: string) => `Lien vers ${domaine} bloqué`;
export const OUVRIR_DANS_UN_ONGLET = "Ouvrir dans un onglet";
export const CHERCHER_ADRESSE = "Chercher la nouvelle adresse";
/** `hote` : celui de `suiviAdresse.page`. */
export const adresseIntrouvable = (hote: string) => `Adresse introuvable sur ${hote}`;
export const adresseChangee = (nom: string, domaine: string) => `${nom} a changé d'adresse : ${domaine}. Il faudra peut-être te reconnecter.`;
export const adresseInchangee = (nom: string) => `${nom} ne répond pas, et sa page de référence donne toujours la même adresse`;
export const titreAccordRetouches = (nom: string) => `Autoriser les retouches de « ${nom} » ?`;
export const AUTORISER = "Autoriser";
export const SANS_RETOUCHES = "Ouvrir sans retouches";
export const OUBLIER_MEMOIRE = "Oublier ce que l'appli a retenu";
export const confirmerOubli = (nom: string) => `Oublier tout ce que « ${nom} » a retenu (séries, positions des vidéos) ?`;
export const confirmerSuppressionSite = (nom: string) =>
  `Supprimer « ${nom} » ? Sa connexion et sa mémoire sont effacées, son dossier va à la corbeille.`;
export const modifierAvecAgent = (id: string) => `Appli de site ~/WebAiOs/sites/${id}/ : `;

export type AvisBarre =
  | { genre: "lien-bloque"; domaine: string } // l'URL bloquée reste dans le main
  | { genre: "adresse-changee" | "introuvable" | "inchangee"; texte: string };

export type DemandeAccordSite = {
  nom: string;
  domaines: string[];
  connexion: string[];
  cadres: string[];
  reprise: boolean;
  fichiers: string[];
  correspond: string[];
};

export type EtatFenetreSite = {
  id: string;
  nom: string;
  vue: "accord" | "accueil" | "site";
  aAccueil: boolean;
  domaine: string;
  peutReculer: boolean;
  peutAvancer: boolean;
  suivi: boolean;
  avis: AvisBarre | null;
  accord: DemandeAccordSite | null;
};

/** Longueur maximale d'une adresse demandée par l'accueil (ouvrir, image). */
export const ADRESSE_ACCUEIL_MAX = 2000;

/** Schéma de l'écran d'accueil : `webaios-site://<id>/<chemin dans accueil/>`. */
export const SCHEMA_SITE = "webaios-site";
/** L'adresse de la page d'entrée de l'accueil de l'appli `id`. */
export const urlAccueilSite = (id: string) => `${SCHEMA_SITE}://${id}/index.html`;
/** Taille maximale d'une image du site demandée par l'accueil (rendue en `data:`). */
export const IMAGE_SITE_MAX = 2 * 1024 * 1024;
/** Écart minimal entre deux adresses ouvertes par l'accueil. */
export const ECART_OUVERTURE_ACCUEIL_MS = 1000;

/** Ce que l'accueil (cadre isolé, code de l'agent) peut demander : rien d'autre n'est relayé. */
export const MessageDeLAccueil = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pret") }),
  z.strictObject({ type: z.literal("ouvrir"), adresse: z.string().max(ADRESSE_ACCUEIL_MAX) }),
  z.strictObject({ type: z.literal("image"), n: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), url: z.string().max(ADRESSE_ACCUEIL_MAX) }),
]);
export type MessageDeLAccueil = z.infer<typeof MessageDeLAccueil>;

export type MessageVersLAccueil =
  | { type: "memoire"; valeurs: Record<string, EntreeMemoire>; positions: Record<string, PositionVideo>; domaine: string }
  | { type: "image"; n: number; data: string | null };

/** Erreurs de console des retouches gardées par appli ouverte (les plus récentes). */
export const ERREURS_RETOUCHES_MAX = 50;
/** Préfixe des sources des retouches (`webaios-retouche://<id>/<fichier>`), pour reconnaître leurs messages de console. */
export const sourceRetouche = (id: string, fichier: string) => `webaios-retouche://${id}/${fichier}`;

/**
 * Ce que le preload `site.js` pose dans un cadre de la vue d'une appli de site. `pont` : `webaiosSite` dans le monde des
 * retouches (cadre principal sur le site seulement) ; `reprise` : la reprise des vidéos (code de WebAiOs).
 */
export type InjectionCadre = { css: string[]; js: { code: string; nom: string }[]; garde: string | null; hotes: string[]; pont: boolean; reprise: boolean };

export type SiteAffiche = { id: string; nom: string; description: string; domaine: string | null; icone: string | null; ouverte: boolean; erreur?: string };

export type ActionSite = "ouvrir" | "modifier" | "oublier" | "dossier" | "supprimer";
