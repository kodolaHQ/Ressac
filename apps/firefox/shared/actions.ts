import type { Execution } from "@webaios/kernel";

/** The actions: UI messages, addresses of the images and components (also read by the UI). */
export const ACTIONS_IN_PRIVATE_SPACE = "Les actions ne sont pas disponibles dans un espace privé";
/** The builder starts or replays an action that is already running (from its page, another window…): nothing goes out. */
export const ACTION_ALREADY_RUNNING = "L'action tourne déjà";
export const PENDING = "En attente : deux actions tournent déjà";
export const PAGE_LAYOUT = "Mise en page…";
export const readingOf = (host: string) => `Lecture de ${host}…`;
/** Copied from the kernel (pages/resolve.ts; a test checks equality): the UI imports only types from it. */
export const FALLBACK_MENTION = "mise en page simple";
export const NO_RESULT = "Aucun résultat";
/** Copied from the kernel (actions/run.ts; same equality test). */
export const ACTION_UNKNOWN = "Action inconnue";
/** A `webaios://action/<id>/<execution>` page whose execution was erased (or never existed). */
export const RESULT_GONE = "Ce résultat n'existe plus";

/** An action's result images, fetched by the chrome (chrome/store/action-media.ts). */
export const SCHEMA_IMAGE = "webaios-image";

export const urlImage = (id: string, execution: string, url: string) => `${SCHEMA_IMAGE}://${id}/${execution}?u=${encodeURIComponent(url)}`;

/** An action as the « Actions » page and the suggestions show it. */
export type ActionShown = {
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
