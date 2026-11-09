import type { BrowserState, WindowId, TabId } from "./model";
import { spaceKey } from "./model";

/** Open tabs the active space can display, in the sidebar order: essentials, pinned, then the others. */
export function walkableTabs(state: BrowserState, windowId: WindowId): TabId[] {
  const f = state.windows.find((x) => x.id === windowId);
  const space = f && state.spaces.find((x) => x.id === f.activeSpace);
  if (!f || !space) return [];
  const key = spaceKey(state, space.id);
  const opened = Object.values(state.tabs).filter((o) => o.windowId === f.id);
  const essentials = state.essentials.flatMap((fav) =>
    opened.filter((o) => o.link?.type === "essential" && o.link.id === fav.id && spaceKey(state, o.spaceId) === key).map((o) => o.id),
  );
  const pinned = space.pinned.flatMap((fav) =>
    opened.filter((o) => o.link?.type === "pinned" && o.link.id === fav.id && o.spaceId === space.id).map((o) => o.id),
  );
  const seen = new Set<TabId>();
  return [...essentials, ...pinned, ...(f.order[space.id] ?? [])].filter((id) => !seen.has(id) && !!seen.add(id) && !!state.tabs[id]);
}
