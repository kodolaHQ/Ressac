import type { ApiWebaios } from "../shared/api";
import { workflowUrlTarget, type PendingRequest, type WindowState, type BrowserState, type TabId, type Tab, type Download } from "../shared/modele";
import { targetKey } from "./constructeur/cible";
import { confirmClose, keepCodesOf } from "./constructeur/codes.svelte";

// Typed as the shared ApiWebaios: ui/api.ts declares window.webaios as its wider ApiFirefox.
export const api = (window as unknown as { webaios: ApiWebaios }).webaios;

/** Local copy of the state broadcast by the main process; only modified through `api.agir`. */
export const appState = $state<{ valeur: BrowserState | null }>({ valeur: null });

api.surEtat((e) => {
  appState.valeur = e;
  // The unsaved code of a builder whose tab is gone, by any path, is dropped.
  keepCodesOf(
    Object.values(e.onglets).flatMap((o) => {
      const target = o.fenetreId === api.fenetreId ? workflowUrlTarget(o.url) : null;
      return target ? [targetKey(target)] : [];
    }),
  );
});

/** The state of the window showing this interface. */
export function currentWindow(): WindowState | undefined {
  return appState.valeur?.fenetres.find((f) => f.id === api.fenetreId);
}

/**
 * Closing a tab wanted by the user (button, menu, middle click, ⌘W): a widget's builder with unsaved code asks first,
 * unless another tab of the window shows the same builder.
 */
export function closeTab(id: TabId): void {
  const o = appState.valeur?.onglets[id];
  const target = o ? workflowUrlTarget(o.url) : null;
  if (o && target) {
    const other = Object.values(appState.valeur!.onglets).some((x) => x.id !== id && x.fenetreId === o.fenetreId && x.url === o.url);
    if (!other && !confirmClose(targetKey(target))) return;
  }
  api.agir({ type: "fermerOnglet", id });
}

/** The session's downloads, most recent first. */
export const downloads = $state<{ liste: Download[] }>({ liste: [] });

api.surTelechargements((list) => {
  downloads.liste = list;
});
void api.telechargements.liste().then((list) => {
  downloads.liste = list;
});

/** Site permission questions, awaiting an answer. */
export const requests = $state<{ liste: PendingRequest[] }>({ liste: [] });

api.surPermissions((list) => {
  requests.liste = list;
});
void api.permissions.enAttente().then((list) => {
  requests.liste = list;
});

/**
 * The question to ask now in this window, one at a time in order of arrival. A popup asks its questions on the tab
 * that opened it (ongletId); with no known tab, on the active tab. An agent question targets a window (its own),
 * whatever the shown tab.
 */
export function requestOf(win: WindowState | undefined, tab: Tab | undefined): PendingRequest | undefined {
  return requests.liste.find((d) => (d.fenetreId ? d.fenetreId === win?.id : d.ongletId === null || d.ongletId === tab?.id));
}

export { access, accessOf } from "./acces.svelte";
