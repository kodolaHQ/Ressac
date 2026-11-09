import type { ApiWebaios } from "../shared/api";
import { workflowUrlTarget, type PendingRequest, type WindowState, type BrowserState, type TabId, type Tab, type Download } from "../shared/modele";
import { cleCible } from "./constructeur/cible";
import { confirmerFermeture, garderCodesDe } from "./constructeur/codes.svelte";

// Typed as the shared ApiWebaios: ui/api.ts declares window.webaios as its wider ApiFirefox.
export const api = (window as unknown as { webaios: ApiWebaios }).webaios;

/** Local copy of the state broadcast by the main process; only modified through `api.agir`. */
export const etat = $state<{ valeur: BrowserState | null }>({ valeur: null });

api.surEtat((e) => {
  etat.valeur = e;
  // The unsaved code of a builder whose tab is gone, by any path, is dropped.
  garderCodesDe(
    Object.values(e.onglets).flatMap((o) => {
      const cible = o.fenetreId === api.fenetreId ? workflowUrlTarget(o.url) : null;
      return cible ? [cleCible(cible)] : [];
    }),
  );
});

/** The state of the window showing this interface. */
export function fenetreCourante(): WindowState | undefined {
  return etat.valeur?.fenetres.find((f) => f.id === api.fenetreId);
}

/**
 * Closing a tab wanted by the user (button, menu, middle click, ⌘W): a widget's builder with unsaved code asks first,
 * unless another tab of the window shows the same builder.
 */
export function fermerOnglet(id: TabId): void {
  const o = etat.valeur?.onglets[id];
  const cible = o ? workflowUrlTarget(o.url) : null;
  if (o && cible) {
    const autre = Object.values(etat.valeur!.onglets).some((x) => x.id !== id && x.fenetreId === o.fenetreId && x.url === o.url);
    if (!autre && !confirmerFermeture(cleCible(cible))) return;
  }
  api.agir({ type: "fermerOnglet", id });
}

/** The session's downloads, most recent first. */
export const telechargements = $state<{ liste: Download[] }>({ liste: [] });

api.surTelechargements((liste) => {
  telechargements.liste = liste;
});
void api.telechargements.liste().then((liste) => {
  telechargements.liste = liste;
});

/** Site permission questions, awaiting an answer. */
export const demandes = $state<{ liste: PendingRequest[] }>({ liste: [] });

api.surPermissions((liste) => {
  demandes.liste = liste;
});
void api.permissions.enAttente().then((liste) => {
  demandes.liste = liste;
});

/**
 * The question to ask now in this window, one at a time in order of arrival. A popup asks its questions on the tab
 * that opened it (ongletId); with no known tab, on the active tab. An agent question targets a window (its own),
 * whatever the shown tab.
 */
export function demandeDe(fenetre: WindowState | undefined, onglet: Tab | undefined): PendingRequest | undefined {
  return demandes.liste.find((d) => (d.fenetreId ? d.fenetreId === fenetre?.id : d.ongletId === null || d.ongletId === onglet?.id));
}

export { acces, accesDe } from "./acces.svelte";
