import type { Action } from "../shared/api";
import type { BrowserState, WindowId } from "../shared/modele";

type Element = { favori: string } | { onglet: string };

/** What the sidebar displays, top to bottom: the space's pinned tabs, then its tabs. */
function shownElements(state: BrowserState, windowId: WindowId): { elements: Element[]; courant: number } {
  const f = state.fenetres.find((x) => x.id === windowId);
  const space = f && state.espaces.find((e) => e.id === f.espaceActif);
  if (!f || !space) return { elements: [], courant: -1 };
  const elements: Element[] = [...space.epingles.map((p) => ({ favori: p.id })), ...(f.ordre[space.id] ?? []).map((id) => ({ onglet: id }))];
  const active = f.actif[space.id];
  const o = active ? state.onglets[active] : undefined;
  const courant = o ? elements.findIndex((x) => ("onglet" in x ? x.onglet === o.id : x.favori === o.lien?.id)) : -1;
  return { elements, courant };
}

function toElement(windowId: WindowId, x: Element | undefined): Action | null {
  if (!x) return null;
  return "onglet" in x ? { type: "activerOnglet", id: x.onglet } : { type: "ouvrirFavori", fenetreId: windowId, genre: "epingle", id: x.favori };
}

/** ⌘1…⌘8: n-th displayed item; ⌘9: the last. */
export function toNth(state: BrowserState, windowId: WindowId, n: number): Action | null {
  const { elements } = shownElements(state, windowId);
  return toElement(windowId, n === 9 ? elements.at(-1) : elements[n - 1]);
}
