import type { ApiRessac } from "../shared/api";
import type { ApiFirefox } from "./api";

/** `api.home` as the builder reads it (followDisappearances): the Firefox read also carries the theme. */
export function homeListForBuilder(api: Pick<ApiFirefox, "home">): Pick<ApiRessac["home"], "read" | "onChange"> {
  return { read: async () => (await api.home.read()).widgets, onChange: api.home.onChange };
}
