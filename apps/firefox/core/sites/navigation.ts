import { localUrl, hostInSite } from "@webaios/noyau";

/**
 * Effective domains of the app, and those of its login (OAuth…). `adressesLocales` (tests only,
 * `WEBAIOS_TEST_ADRESSES_LOCALES=1`) allows local hosts, and http to them; otherwise https only, never local.
 */
export type ContexteNavigation = { domaines: readonly string[]; connexion: readonly string[]; adressesLocales?: boolean };

/**
 * The host of an allowed web address, or null: javascript:, about:blank, file:, unreadable address, credentials in
 * the address, http outside test mode, local host outside test mode (defense in depth: the lists are already checked).
 */
function hoteWeb(url: string, adressesLocales: boolean): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = localUrl(u.hostname);
  if (local && !adressesLocales) return null;
  if (u.protocol === "https:") return u.hostname;
  return u.protocol === "http:" && local ? u.hostname : null;
}

/** Main page: followed to the site or its login, blocked elsewhere (notice in the bar). */
export function decisionNavigation(url: string, c: ContexteNavigation): "suivre" | "bloquer" {
  const hote = hoteWeb(url, c.adressesLocales === true);
  return hote !== null && (hostInSite(hote, c.domaines) || hostInSite(hote, c.connexion)) ? "suivre" : "bloquer";
}

/**
 * `window.open` and `target=_blank`: to the site, the app's view goes there; to the login, a small window of the
 * same session; the rest (ads, `about:blank` included) is blocked, never opened in a tab.
 */
export function decisionOuverture(url: string, c: ContexteNavigation): "dans-l-appli" | "petite-fenetre" | "bloquer" {
  const hote = hoteWeb(url, c.adressesLocales === true);
  if (hote === null) return "bloquer";
  if (hostInSite(hote, c.domaines)) return "dans-l-appli";
  return hostInSite(hote, c.connexion) ? "petite-fenetre" : "bloquer";
}
