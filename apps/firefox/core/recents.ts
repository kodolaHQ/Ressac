import type { BrowserState, WindowId, TabId } from "../shared/model";
import { walkableTabs } from "../shared/walkable-tabs";

/** The active tab first, then the history (most recent first) restricted to the cycle-able tabs, then the rest. */
export function recentOrder(state: BrowserState, windowId: WindowId, hist: readonly TabId[]): TabId[] {
  const f = state.windows.find((x) => x.id === windowId);
  const walkable = walkableTabs(state, windowId);
  const active = f?.active[f.activeSpace] ?? null;
  const result: TabId[] = [];
  const add = (id: TabId | null | undefined) => {
    if (id && walkable.includes(id) && !result.includes(id)) result.push(id);
  };
  add(active);
  hist.forEach(add);
  walkable.forEach(add);
  return result;
}

/** New array with `id` first, without duplicates. */
export function noteUsage(hist: TabId[], id: TabId): TabId[] {
  return [id, ...hist.filter((x) => x !== id)];
}

export type Walk = { list: TabId[]; selection: number };

export function start(list: TabId[], delta: 1 | -1): Walk | null {
  if (list.length < 2) return null;
  return { list: list, selection: delta > 0 ? 1 : list.length - 1 };
}

export function advance(p: Walk, delta: 1 | -1): Walk {
  const n = p.list.length;
  return { ...p, selection: (p.selection + delta + n) % n };
}

/** Removes a tab closed during the cycle; null if fewer than 2 remain. */
export function remove(p: Walk, id: TabId): Walk | null {
  const i = p.list.indexOf(id);
  if (i < 0) return p;
  const list = p.list.filter((x) => x !== id);
  if (list.length < 2) return null;
  const selection = i < p.selection ? p.selection - 1 : p.selection;
  return { list: list, selection: Math.min(selection, list.length - 1) };
}

/** Indices [debut, fin) of a window of `taille` cards containing the selection, stuck to the start as long as possible. */
export function visibleWindow(p: Walk, size = 7): { start: number; end: number } {
  const n = p.list.length;
  if (n <= size) return { start: 0, end: n };
  const start = Math.max(0, Math.min(p.selection - size + 1, n - size));
  return { start: start, end: start + size };
}
