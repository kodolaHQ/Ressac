// What goes into each frame of a site app's view (core/sites/injection.ts): decided from
// the frame's WindowGlobalParent (its document's address, whether it is the view's main frame, the view's page), never
// from what the frame says. Also the tweaks' console and the memory relay to the host.
import type { TweaksRead } from "../../../../packages/noyau/src/sites/lire";
import { relativeUrl } from "../../../../packages/noyau/src/sites/adresses";
import GARDE from "../../../../packages/noyau/extensions/webaios-garde-page.js?raw";
import { tweakSource, type InjectionCadre } from "../../shared/sites";
import { addTweakConsole, injectionPour, repriseDansCadre, type TweakError, type MemoryResponse } from "../../core/sites/injection";
import { MEMORY_DENIAL } from "../../noyau/site-memory";
import type { SiteChrome } from "../../noyau/sites";

/** What these decisions need of an open app (store/sites.ts OpenSite). */
export interface FrameSite {
  site: SiteChrome;
  retouches: TweaksRead;
  /** The app view's <browser>. */
  view: any;
  /** The tweaks' console, kept until the window closes. */
  erreurs: TweakError[];
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

/** The frame as the injection sees it, from its WindowGlobalParent; null if it is gone. */
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

/** The actor's "injection": null outside an open app's view or without its grant, else injectionPour. */
export function frameInjection(wgp: any, s: FrameSite | undefined, adressesLocales: boolean): InjectionCadre | null {
  if (!s || s.site.accordRequis) return null;
  const f = frameOf(wgp, s.view);
  if (!f) return null;
  const i = injectionPour({ site: s.site, retouches: s.retouches, accorde: true, garde: GARDE, adressesLocales }, f.principal ? { url: f.url, principal: true } : f);
  // A player written into an about:srcdoc / about:blank frame of an app page has no address of its own for injectionPour
  // (nothing is injected there), but the resume goes into it like into any other frame of that page.
  if (i && !f.principal && /^about:(srcdoc|blank)$/.test(f.url) && f.page !== null && relativeUrl(f.page, s.site.domaines) !== null)
    i.reprise = repriseDansCadre(s.site.declaration, f, adressesLocales);
  return i;
}

/**
 * The actor's "memoire": only the view's main document, on the app's domains, with the grant; the host checks the
 * request's shape and does the memory work (noyau/site-memory.ts).
 */
export async function frameMemory(wgp: any, s: FrameSite | undefined, demande: unknown, request: (p: object) => Promise<MemoryResponse>): Promise<MemoryResponse> {
  const refus: MemoryResponse = { ok: false, erreur: MEMORY_DENIAL };
  if (!s || s.site.accordRequis) return refus;
  const f = frameOf(wgp, s.view);
  const adresse = f?.principal ? relativeUrl(f.url, s.site.domaines) : null;
  if (adresse === null || !demande || typeof demande !== "object") return refus;
  const { op, cle, valeur } = demande as { op?: unknown; cle?: unknown; valeur?: unknown };
  return request({ id: s.site.id, adresse, op, cle, valeur });
}

/**
 * The view's console: an error the actor relays from a frame of the app's view, whose
 * source is named as one of the app's tweaks (`webaios-retouche://<id>/`), kept in its console, bounded. The frame is
 * known from its WindowGlobalParent (the caller's siteOfFrame): the sign-in window or another app naming its code so
 * reaches no app's console. The text comes from a web process: bounded by ajouterConsoleRetouche.
 */
export function frameError(s: FrameSite | undefined, e: unknown): void {
  if (!s || !e || typeof e !== "object") return;
  const { texte, source, ligne } = e as { texte?: unknown; source?: unknown; ligne?: unknown };
  if (typeof texte !== "string" || typeof source !== "string" || !source.startsWith(tweakSource(s.site.id, ""))) return;
  const l = typeof ligne === "number" && Number.isInteger(ligne) && ligne > 0 ? ligne : 0;
  addTweakConsole(s.erreurs, { texte, source: l ? `${source}:${l}` : source }, new Date().toISOString());
}

/**
 * The app's id and the relative address of the view's top page, if the frame's app has its grant
 * and the resume goes into this frame (declaration, `cadres` patterns). The address is read at each request (a pushState
 * to another episode counts); a page off the app's domains (a sign-in page and its frames) has none.
 */
function resumePage(wgp: any, s: FrameSite | undefined, adressesLocales: boolean): { id: string; adresse: string } | null {
  if (!s || s.site.accordRequis) return null;
  const f = frameOf(wgp, s.view);
  if (!f || !repriseDansCadre(s.site.declaration, f, adressesLocales)) return null;
  const adresse = f.principal ? relativeUrl(f.url, s.site.domaines) : f.page === null ? null : relativeUrl(f.page, s.site.domaines);
  return adresse === null ? null : { id: s.site.id, adresse };
}

/** The actor's "position": a video's position of the page, for the host (`cadre` is the frame's one-second step key). */
export function framePosition(wgp: any, s: FrameSite | undefined, p: unknown, adressesLocales: boolean, notify: (p: object) => void): void {
  const page = p && typeof p === "object" ? resumePage(wgp, s, adressesLocales) : null;
  if (!page) return;
  const { t, duree, fin } = p as { t?: unknown; duree?: unknown; fin?: unknown };
  notify({ ...page, cadre: `${wgp.browsingContext.id}:${wgp.innerWindowId}`, t, duree, fin: fin === true });
}

/** The actor's "reprise": the position kept for the page, for a video of this duration (null if none). */
export async function frameResume(wgp: any, s: FrameSite | undefined, duree: unknown, adressesLocales: boolean, request: (p: object) => Promise<number | null>): Promise<number | null> {
  const page = resumePage(wgp, s, adressesLocales);
  const d = duree && typeof duree === "object" ? (duree as { duree?: unknown }).duree : undefined;
  return page && typeof d === "number" ? request({ ...page, duree: d }) : null;
}
