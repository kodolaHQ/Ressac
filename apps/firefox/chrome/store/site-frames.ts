// What goes into each frame of a site app's view (Electron's brancherInjection, main/sites/injection.ts): decided from
// the frame's WindowGlobalParent (its document's address, whether it is the view's main frame, the view's page), never
// from what the frame says. Also the retouches' console and the memory relay to the host.
import type { RetouchesLues } from "../../../../packages/noyau/src/sites/lire";
import { adresseRelative } from "../../../../packages/noyau/src/sites/adresses";
import GARDE from "../../../../packages/noyau/extensions/webaios-garde-page.js?raw";
import { sourceRetouche, type InjectionCadre } from "../../../navigateur/src/commun/sites";
import type { ErreurRetouche } from "../../../navigateur/src/main/sites/fenetres";
import { ajouterConsoleRetouche, injectionPour, type ReponseMemoire } from "../../../navigateur/src/main/sites/injection";
import { REFUS_MEMOIRE } from "../../noyau/site-memory";
import type { SiteChrome } from "../../noyau/sites";

/** What these decisions need of an open app (store/sites.ts OpenSite). */
export interface FrameSite {
  site: SiteChrome;
  retouches: RetouchesLues;
  /** The app view's <browser>. */
  view: any;
  /** The retouches' console, kept until the window closes. */
  erreurs: ErreurRetouche[];
}

/** The open app whose view is this frame's top <browser>, or undefined (a sign-in window of the same container, a tab). */
export function siteOfFrame<S extends { view: any }>(wgp: any, sites: Iterable<S>): S | undefined {
  let top: unknown;
  try {
    top = wgp?.browsingContext?.top?.embedderElement;
  } catch {
    return undefined;
  }
  if (!top) return undefined;
  for (const s of sites) if (s.view === top) return s;
  return undefined;
}

/** The frame as Electron's cadreDe and pageDe see it, from its WindowGlobalParent; null if it is gone. */
function frameOf(wgp: any, view: any): { url: string; principal: boolean; page: string | null } | null {
  try {
    const url = wgp.documentURI?.spec;
    if (typeof url !== "string") return null;
    const page = view.browsingContext?.currentWindowGlobal?.documentURI?.spec;
    return { url, principal: wgp.browsingContext === view.browsingContext, page: typeof page === "string" ? page : null };
  } catch {
    return null;
  }
}

/** The actor's "injection": null outside an open app's view or without its accord, else Electron's injectionPour. */
export function frameInjection(wgp: any, s: FrameSite | undefined, adressesLocales: boolean): InjectionCadre | null {
  if (!s || s.site.accordRequis) return null;
  const f = frameOf(wgp, s.view);
  if (!f) return null;
  return injectionPour({ site: s.site, retouches: s.retouches, accorde: true, garde: GARDE, adressesLocales }, f.principal ? { url: f.url, principal: true } : f);
}

/**
 * The actor's "memoire": only the view's main document, on the app's domains, with the accord; the host checks the
 * request's shape and does the memory work (noyau/site-memory.ts).
 */
export async function frameMemory(wgp: any, s: FrameSite | undefined, demande: unknown, request: (p: object) => Promise<ReponseMemoire>): Promise<ReponseMemoire> {
  const refus: ReponseMemoire = { ok: false, erreur: REFUS_MEMOIRE };
  if (!s || s.site.accordRequis) return refus;
  const f = frameOf(wgp, s.view);
  const adresse = f?.principal ? adresseRelative(f.url, s.site.domaines) : null;
  if (adresse === null || !demande || typeof demande !== "object") return refus;
  const { op, cle, valeur } = demande as { op?: unknown; cle?: unknown; valeur?: unknown };
  return request({ id: s.site.id, adresse, op, cle, valeur });
}

/**
 * Electron's console-message listener on the view: an error the actor relays from a frame of the app's view, whose
 * source is named as one of the app's retouches (`webaios-retouche://<id>/`), kept in its console, bounded. The frame is
 * known from its WindowGlobalParent (the caller's siteOfFrame): the sign-in window or another app naming its code so
 * reaches no app's console. The text comes from a web process: bounded by ajouterConsoleRetouche.
 */
export function frameError(s: FrameSite | undefined, e: unknown): void {
  if (!s || !e || typeof e !== "object") return;
  const { texte, source, ligne } = e as { texte?: unknown; source?: unknown; ligne?: unknown };
  if (typeof texte !== "string" || typeof source !== "string" || !source.startsWith(sourceRetouche(s.site.id, ""))) return;
  const l = typeof ligne === "number" && Number.isInteger(ligne) && ligne > 0 ? ligne : 0;
  ajouterConsoleRetouche(s.erreurs, { texte, source: l ? `${source}:${l}` : source }, new Date().toISOString());
}
