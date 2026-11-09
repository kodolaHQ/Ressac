import type { Action } from "../shared/api";
import type { BrowserState, WindowId } from "../shared/model";

type Element = { favorite: string } | { tab: string };

/** What the sidebar displays, top to bottom: the space's pinned tabs, then its tabs. */
function shownElements(state: BrowserState, windowId: WindowId): { items: Element[]; current: number } {
  const f = state.windows.find((x) => x.id === windowId);
  const space = f && state.spaces.find((e) => e.id === f.activeSpace);
  if (!f || !space) return { items: [], current: -1 };
  const items: Element[] = [...space.pinned.map((p) => ({ favorite: p.id })), ...(f.order[space.id] ?? []).map((id) => ({ tab: id }))];
  const active = f.active[space.id];
  const o = active ? state.tabs[active] : undefined;
  const current = o ? items.findIndex((x) => ("tab" in x ? x.tab === o.id : x.favorite === o.link?.id)) : -1;
  return { items, current: current };
}

function toElement(windowId: WindowId, x: Element | undefined): Action | null {
  if (!x) return null;
  return "tab" in x ? { type: "activerOnglet", id: x.tab } : { type: "ouvrirFavori", windowId: windowId, kind: "epingle", id: x.favorite };
}

/** ⌘1…⌘8: n-th displayed item; ⌘9: the last. */
export function toNth(state: BrowserState, windowId: WindowId, n: number): Action | null {
  const { items: elements } = shownElements(state, windowId);
  return toElement(windowId, n === 9 ? elements.at(-1) : elements[n - 1]);
}
