import type { ApiWebaios } from "../shared/api";
import type { ApiFirefox } from "./api";

/** `api.accueil` as the builder reads it (followDisappearances): the Firefox read also carries the theme. */
export function homeListForBuilder(api: Pick<ApiFirefox, "accueil">): Pick<ApiWebaios["accueil"], "lire" | "surChange"> {
  return { lire: async () => (await api.accueil.lire()).widgets, surChange: api.accueil.surChange };
}
