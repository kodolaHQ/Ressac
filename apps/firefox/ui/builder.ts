import type { ApiWebaios } from "../../navigateur/src/commun/api";
import type { ApiFirefox } from "./api";

/** Electron's `api.accueil` as the builder reads it (suivreDisparitions): the Firefox read also carries the theme. */
export function homeListForBuilder(api: Pick<ApiFirefox, "accueil">): Pick<ApiWebaios["accueil"], "lire" | "surChange"> {
  return { lire: async () => (await api.accueil.lire()).widgets, surChange: api.accueil.surChange };
}
