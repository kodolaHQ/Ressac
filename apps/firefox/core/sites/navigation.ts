import { localUrl, hostInSite } from "@ressac/kernel";
import { urlOnDomain } from "../../../../packages/kernel/src/sites/urls";
import { HOME_OPEN_GAP_MS } from "../../shared/sites";

/**
 * Effective domains of the app, and those of its login (OAuth…). `adressesLocales` (tests only,
 * `RESSAC_TEST_LOCAL_ADDRESSES=1`) allows local hosts, and http to them; otherwise https only, never local.
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
export function decisionNavigation(url: string, c: NavigationContext): "follow" | "block" {
  const host = webHost(url, c.localAddresses === true);
  return host !== null && (hostInSite(host, c.domains) || hostInSite(host, c.login)) ? "follow" : "block";
}

/**
 * `window.open` and `target=_blank`: to the site, the app's view goes there; to the login, a small window of the
 * same session; the rest (ads, `about:blank` included) is blocked, never opened in a tab.
 */
export function openDecision(url: string, c: NavigationContext): "in-app" | "small-window" | "block" {
  const host = webHost(url, c.localAddresses === true);
  if (host === null) return "block";
  if (hostInSite(host, c.domains)) return "in-app";
  return hostInSite(host, c.login) ? "small-window" : "block";
}

/**
 * Where a home's open goes (an app window's home or its essential tab's): on the app's current domain (its start
 * address's), at most one per HOME_OPEN_GAP_MS after `last`; null if refused. The caller checks the real gesture.
 */
export function homeOpenUrl(address: unknown, site: { domains: readonly string[]; start: string }, last: number, now: number, localAddresses: boolean): string | null {
  if (typeof address !== "string" || now - last < HOME_OPEN_GAP_MS) return null;
  let current = "";
  try {
    current = new URL(site.start).hostname;
  } catch {}
  return urlOnDomain(address, current, site.domains, site.start, { localAddresses });
}
