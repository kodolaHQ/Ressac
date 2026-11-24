// « Cacher pour l'agent »: what the toast and the layer's chip say for an ending (ui/HideApp.svelte shows them).

import type { HideContext } from "../../shared/api";

/** The ending's sentence: « Ajouté à votre passeport » only when the hide made a new entry. */
export const endingSentence = (c: Pick<HideContext, "ending" | "created">) =>
  `chrome-hide-ending-${c.ending}${!c.created && (c.ending === "agentReached" || c.ending === "notHere") ? "-known" : ""}`;

/** The toast's line: « Masqué pour l'agent » (or « Déjà dans votre passeport. ») only when the page masks it now; otherwise the ending's sentence. */
export const toastLine = (c: Pick<HideContext, "ending" | "created" | "undoable">) =>
  c.ending === "hidden" ? (c.undoable ? "chrome-hide-toast" : "chrome-hide-toast-already") : endingSentence(c);
