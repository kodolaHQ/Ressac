import { localUrl, hostInSite } from "@webaios/kernel";

/**
 * Effective domains of the app, and those of its login (OAuth…). `adressesLocales` (tests only,
 * `WEBAIOS_TEST_ADRESSES_LOCALES=1`) allows local hosts, and http to them; otherwise https only, never local.
 */
export type NavigationContext = { domains: readonly string[]; login: readonly string[]; localAddresses?: boolean };

/**
 * The host of an allowed web address, or null: javascript:, about:blank, file:, unreadable address, credentials in
 * the address, http outside test mode, local host outside test mode (defense in depth: the lists are already checked).
 */
function webHost(url: string, localUrls: boolean): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const local = localUrl(u.hostname);
  if (local && !localUrls) return null;
  if (u.protocol === "https:") return u.hostname;
  return u.protocol === "http:" && local ? u.hostname : null;
}

/** Main page: followed to the site or its login, blocked elsewhere (notice in the bar). */
export function decisionNavigation(url: string, c: NavigationContext): "suivre" | "bloquer" {
  const host = webHost(url, c.localAddresses === true);
  return host !== null && (hostInSite(host, c.domains) || hostInSite(host, c.login)) ? "suivre" : "bloquer";
}

/**
 * `window.open` and `target=_blank`: to the site, the app's view goes there; to the login, a small window of the
 * same session; the rest (ads, `about:blank` included) is blocked, never opened in a tab.
 */
export function openDecision(url: string, c: NavigationContext): "dans-l-appli" | "petite-fenetre" | "bloquer" {
  const host = webHost(url, c.localAddresses === true);
  if (host === null) return "bloquer";
  if (hostInSite(host, c.domains)) return "dans-l-appli";
  return hostInSite(host, c.login) ? "petite-fenetre" : "bloquer";
}
