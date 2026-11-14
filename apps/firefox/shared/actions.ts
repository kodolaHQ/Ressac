import type { Execution } from "@ressac/kernel";

/** The actions: the host's message, addresses of the images and components (also read by the UI). */
/** The builder starts or replays an action that is already running (from its page, another window…): nothing goes out. */
export const ACTION_ALREADY_RUNNING = "L'action tourne déjà";
/** Copied from the kernel (pages/resolve.ts; a test checks equality): the UI imports only types from it. */
export const FALLBACK_MENTION = "mise en page simple";
export const NO_RESULT = "Aucun résultat";

/** An action's result images, fetched by the chrome (chrome/store/action-media.ts). */
export const SCHEMA_IMAGE = "ressac-image";

export const urlImage = (id: string, execution: string, url: string) => `${SCHEMA_IMAGE}://${id}/${execution}?u=${encodeURIComponent(url)}`;

/** An action as the « Actions » page and the suggestions show it. */
export type ActionShown = {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  input: { label: string } | null;
  /** Domains read with the user's account (empty: public sources only). */
  account: string[];
  /** Public sites the action contacts (shown on the account's grant card). */
  public: string[];
  /** The account grant is given. */
  grant: boolean;
  /** The most recent real execution (not a trial). */
  last: { run: string; start: string; status: Execution["status"] } | null;
  /** `action.json` unreadable or invalid. */
  error?: string;
  /** The last launch was refused without writing anything (workshop stopped, workflow.json missing…): its message. */
  denial?: string;
};
