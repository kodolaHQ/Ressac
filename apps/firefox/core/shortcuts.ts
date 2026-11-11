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
  return "tab" in x ? { type: "activateTab", id: x.tab } : { type: "openFavorite", windowId: windowId, kind: "pinned", id: x.favorite };
}

/** J / K (vim mode): the shown item's neighbour in the sidebar's order, wrapping. */
export function toNeighbour(state: BrowserState, windowId: WindowId, delta: 1 | -1): Action | null {
  const { items, current } = shownElements(state, windowId);
  if (!items.length) return null;
  const from = current < 0 ? (delta > 0 ? -1 : 0) : current;
  return toElement(windowId, items[(from + delta + items.length) % items.length]);
}

/** gs / gS (vim mode): the window's next / previous space, wrapping. */
export function toNextSpace(state: BrowserState, windowId: WindowId, delta: 1 | -1): Action | null {
  const f = state.windows.find((x) => x.id === windowId);
  const i = state.spaces.findIndex((e) => e.id === f?.activeSpace);
  const n = state.spaces.length;
  if (i < 0 || n < 2) return null;
  return { type: "activateSpace", windowId: windowId, id: state.spaces[(i + delta + n) % n]!.id };
}

/** ⌘1…⌘8: n-th displayed item; ⌘9: the last. */
export function toNth(state: BrowserState, windowId: WindowId, n: number): Action | null {
  const { items: elements } = shownElements(state, windowId);
  return toElement(windowId, n === 9 ? elements.at(-1) : elements[n - 1]);
}
