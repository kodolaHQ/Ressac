import type { ShownSite } from "../../shared/sites";
import { api, appState } from "../state.svelte";

/** Opens site app `id`: in the essentials, its tab is shown in window `windowId` (one session per container); else its window. */
export function openSite(id: string, windowId: string | undefined): void {
  const favorite = appState.value?.essentials.find((x) => x.site === id);
  if (favorite && windowId) {
    api.dispatch({ type: "openFavorite", windowId, kind: "essential", id: favorite.id });
    // As a click on its essential: the app's home over its tab.
    api.sites.showHome(id);
  } else api.sites.act(id, "open");
}

/** The app into the essentials: its window closes first, its tab takes over. */
export function toEssentials(s: ShownSite): void {
  if (!s.start) return;
  api.sites.act(s.id, "close");
  api.dispatch({ type: "placeSite", id: s.id, placement: "essentials", url: s.start, title: s.name, favicon: s.icon });
}
