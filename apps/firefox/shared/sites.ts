import { z } from "zod";
import type { MemoryEntry, PositionVideo } from "@webaios/noyau";

/** Messages and types of a site app's window, also read by the UI (`site.html`, Applications page). */

/** Height of a site app window's bar, in px: the site view is placed right below it. */
export const HAUTEUR_BARRE_SITE = 36;

/** Maximum height, in px, of the bar's « Extensions » menu panel (plan 16): it pushes the site view down by as much. */
export const PANNEAU_EXTENSIONS_MAX = 320;

/** At most one read of the reference page per minute and per app. */
export const INTERVALLE_SUIVI_MS = 60_000;

/** Maximum size of the icon declared by a site app. */
export const ICONE_MAX = 256 * 1024;

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
  | { genre: "lien-bloque"; domaine: string } // the blocked URL stays in the main process
  | { genre: "adresse-changee" | "introuvable" | "inchangee"; texte: string }
  /** A transient notice (design mode unavailable here…), cleared after `DUREE_AVIS_INFO_MS` or at the next page. */
  | { genre: "info"; texte: string };

/** Display duration of an `info` notice in the bar, in ms. */
export const DUREE_AVIS_INFO_MS = 5000;

export type DemandeAccordSite = {
  nom: string;
  domaines: string[];
  connexion: string[];
  cadres: string[];
  reprise: boolean;
  fichiers: string[];
  correspond: string[];
  /** Domains where the site was found again by address tracking (outside `domaines`): the tweaks run there too. */
  suivis: string[];
  /** sha256 (hex) of the requested rights (`droitsDe`): « Autoriser » only applies to those the card showed. */
  empreinte: string;
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
  /** A read of the reference page is in progress (the « Chercher la nouvelle adresse » button is waiting). */
  recherche: boolean;
  avis: AvisBarre | null;
  accord: DemandeAccordSite | null;
};

/** Maximum length of an address requested by the home (open, image). */
export const ADRESSE_ACCUEIL_MAX = 2000;

/** Home screen scheme: `webaios-site://<id>/<path in accueil/>`. */
export const SCHEMA_SITE = "webaios-site";
/** Maximum size of a site image requested by the home (rendered as `data:`). */
export const IMAGE_SITE_MAX = 2 * 1024 * 1024;
/** Minimum gap between two addresses opened by the home. */
export const ECART_OUVERTURE_ACCUEIL_MS = 1000;

/** What the home (isolated frame, the agent's code) may request: nothing else is relayed. */
export const MessageDeLAccueil = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pret") }),
  z.strictObject({ type: z.literal("ouvrir"), adresse: z.string().max(ADRESSE_ACCUEIL_MAX) }),
  z.strictObject({ type: z.literal("image"), n: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), url: z.string().max(ADRESSE_ACCUEIL_MAX) }),
]);
export type MessageDeLAccueil = z.infer<typeof MessageDeLAccueil>;

export type MessageVersLAccueil =
  | { type: "memoire"; valeurs: Record<string, MemoryEntry>; positions: Record<string, PositionVideo>; domaine: string }
  | { type: "image"; n: number; data: string | null };

/** Console errors of the tweaks kept per open app (the most recent). */
export const ERREURS_RETOUCHES_MAX = 50;
/** Kept length of the text of a tweak console message, and of its source. */
export const CONSOLE_RETOUCHE_TEXTE_MAX = 2000;
export const CONSOLE_RETOUCHE_SOURCE_MAX = 500;
/** Total of the kept texts per open app: beyond it, the oldest are forgotten. */
export const CONSOLE_RETOUCHES_TOTAL = 32_000;
/** Prefix of the tweaks' sources (`webaios-retouche://<id>/<file>`), to recognize their console messages. */
export const sourceRetouche = (id: string, fichier: string) => `webaios-retouche://${id}/${fichier}`;

/**
 * What the site actor (chrome/agent/site-actor.ts) puts into a frame of a site app's view. `pont`: `webaiosSite` in the
 * tweaks' world (main frame on the site only); `reprise`: the video resume (WebAiOs's code).
 */
export type InjectionCadre = { css: string[]; js: { code: string; nom: string }[]; garde: string | null; hotes: string[]; pont: boolean; reprise: boolean };

export type SiteAffiche = { id: string; nom: string; description: string; domaine: string | null; icone: string | null; ouverte: boolean; erreur?: string; erreurAction?: string; sansActions?: true };

export type ActionSite = "ouvrir" | "modifier" | "oublier" | "dossier" | "supprimer" | "relire";
