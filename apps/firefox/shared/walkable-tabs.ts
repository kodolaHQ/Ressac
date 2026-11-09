import type { BrowserState, WindowId, TabId } from "./model";
import { spaceKey } from "./model";

/** Open tabs the active space can display, in the sidebar order: essentials, pinned, then the others. */
export function walkableTabs(state: BrowserState, windowId: WindowId): TabId[] {
  const f = state.fenetres.find((x) => x.id === windowId);
  const space = f && state.espaces.find((x) => x.id === f.espaceActif);
  if (!f || !space) return [];
  const key = spaceKey(state, space.id);
  const opened = Object.values(state.onglets).filter((o) => o.fenetreId === f.id);
  const essentials = state.essentiels.flatMap((fav) =>
    opened.filter((o) => o.lien?.type === "essentiel" && o.lien.id === fav.id && spaceKey(state, o.espaceId) === key).map((o) => o.id),
  );
  const pinned = space.epingles.flatMap((fav) =>
    opened.filter((o) => o.lien?.type === "epingle" && o.lien.id === fav.id && o.espaceId === space.id).map((o) => o.id),
  );
  const seen = new Set<TabId>();
  return [...essentials, ...pinned, ...(f.ordre[space.id] ?? [])].filter((id) => !seen.has(id) && !!seen.add(id) && !!state.onglets[id]);
}
