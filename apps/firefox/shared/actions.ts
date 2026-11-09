import type { Execution } from "@webaios/noyau";

/** The actions: UI messages, addresses of the images and components (also read by the UI). */
export const ACTIONS_EN_ESPACE_PRIVE = "Les actions ne sont pas disponibles dans un espace privé";
/** The builder starts or replays an action that is already running (from its page, another window…): nothing goes out. */
export const ACTION_TOURNE_DEJA = "L'action tourne déjà";
export const EN_ATTENTE = "En attente : deux actions tournent déjà";
export const MISE_EN_PAGE = "Mise en page…";
export const lectureDe = (hote: string) => `Lecture de ${hote}…`;
/** Copied from the kernel (pages/resoudre.ts; a test checks equality): the UI imports only types from it. */
export const MENTION_SECOURS = "mise en page simple";
export const AUCUN_RESULTAT = "Aucun résultat";
/** Copied from the kernel (actions/executer.ts; same equality test). */
export const ACTION_INCONNUE = "Action inconnue";
/** A `webaios://action/<id>/<execution>` page whose execution was erased (or never existed). */
export const RESULTAT_DISPARU = "Ce résultat n'existe plus";

/** An action's result images, fetched by the chrome (chrome/store/action-media.ts). */
export const SCHEMA_IMAGE = "webaios-image";

export const urlImage = (id: string, execution: string, url: string) => `${SCHEMA_IMAGE}://${id}/${execution}?u=${encodeURIComponent(url)}`;

/** An action as the « Actions » page and the suggestions show it. */
export type ActionAffichee = {
  id: string;
  nom: string;
  description: string;
  motsCles: string[];
  saisie: { libelle: string } | null;
  /** Domains read with the user's account (empty: public sources only). */
  compte: string[];
  /** Public sites the action contacts (shown on the account's grant card). */
  publiques: string[];
  /** The account grant is given. */
  accord: boolean;
  /** The most recent real execution (not a trial). */
  dernier: { execution: string; debut: string; statut: Execution["statut"] } | null;
  /** `action.json` unreadable or invalid. */
  erreur?: string;
  /** The last launch was refused without writing anything (workshop stopped, workflow.json missing…): its message. */
  refus?: string;
};
