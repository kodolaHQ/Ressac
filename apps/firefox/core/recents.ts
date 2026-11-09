import type { BrowserState, WindowId, TabId } from "../shared/model";
import { walkableTabs } from "../shared/walkable-tabs";

/** The active tab first, then the history (most recent first) restricted to the cycle-able tabs, then the rest. */
export function recentOrder(state: BrowserState, windowId: WindowId, hist: readonly TabId[]): TabId[] {
  const f = state.fenetres.find((x) => x.id === windowId);
  const walkable = walkableTabs(state, windowId);
  const active = f?.actif[f.espaceActif] ?? null;
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

export type Walk = { liste: TabId[]; selection: number };

export function start(list: TabId[], delta: 1 | -1): Walk | null {
  if (list.length < 2) return null;
  return { liste: list, selection: delta > 0 ? 1 : list.length - 1 };
}

export function advance(p: Walk, delta: 1 | -1): Walk {
  const n = p.liste.length;
  return { ...p, selection: (p.selection + delta + n) % n };
}

/** Removes a tab closed during the cycle; null if fewer than 2 remain. */
export function retirer(p: Walk, id: TabId): Walk | null {
  const i = p.liste.indexOf(id);
  if (i < 0) return p;
  const list = p.liste.filter((x) => x !== id);
  if (list.length < 2) return null;
  const selection = i < p.selection ? p.selection - 1 : p.selection;
  return { liste: list, selection: Math.min(selection, list.length - 1) };
}

/** Indices [debut, fin) of a window of `taille` cards containing the selection, stuck to the start as long as possible. */
export function visibleWindow(p: Walk, taille = 7): { debut: number; fin: number } {
  const n = p.liste.length;
  if (n <= taille) return { debut: 0, fin: n };
  const debut = Math.max(0, Math.min(p.selection - taille + 1, n - taille));
  return { debut, fin: debut + taille };
}
