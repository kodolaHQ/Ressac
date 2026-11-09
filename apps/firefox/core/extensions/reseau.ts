// The agent extensions' network, closed by default (spec §5, plan 12 task 12): the copy's CSP (`connect-src 'self'
// https://<reseau>`, kernel `cspAgent`) and the chrome's request guard (chrome/store/agent-extensions.ts) close it.
// This module holds the pure checks the chrome asks: the addresses an agent extension's pages and its calls to
// `tabs.create`, `tabs.update`, `windows.create` may open (`urlPermiseAgent`, asked by the guard webaios-garde-fond.js),
// and the hosts it may script (`hotePermisAgent`).
import type { Scope } from "@webaios/noyau";

function lire(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** `*` of a pattern path: any sequence of characters. */
function cheminCouvre(motif: string, chemin: string): boolean {
  const re = new RegExp("^" + motif.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(chemin);
}

/**
 * Does a Chrome host pattern (`<all_urls>`, `*://*.exemple.com/*`, `https://exemple.com/chemin*`) cover this
 * http(s) address? Without a port in the pattern, any port is covered (like Chrome).
 */
export function motifCouvre(motif: string, u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (motif === "<all_urls>") return true;
  const m = /^(\*|https?|wss?):\/\/([^/]*)(\/.*)$/.exec(motif);
  if (!m) return false;
  const [, schema, hoteMotif, cheminMotif] = m as unknown as [string, string, string, string];
  if (schema !== "*" && `${schema}:` !== u.protocol) return false;
  const [hote, port] = hoteMotif.split(/:(?=[^:\]]*$)/) as [string, string | undefined];
  if (port !== undefined && port !== "*" && port !== (u.port || (u.protocol === "https:" ? "443" : "80"))) return false;
  const h = u.hostname.toLowerCase();
  const voulu = hote.toLowerCase();
  if (voulu !== "*") {
    if (voulu.startsWith("*.")) {
      const base = voulu.slice(2);
      if (h !== base && !h.endsWith("." + base)) return false;
    } else if (h !== voulu) return false;
  }
  return cheminCouvre(cheminMotif, u.pathname + u.search);
}

/** A host of `accord.reseau` (exact name). */
function dansReseau(u: URL, accord: Scope): boolean {
  return accord.reseau.includes(u.hostname.toLowerCase());
}

/**
 * An address an agent extension may open (tab, window, navigation of its pages): a
 * `chrome-extension://` page of itself, or http(s) to a host of `accord.reseau` or covered by `accord.hotes`. Everything
 * else is refused (`data:`, `javascript:`, `file:`, `blob:`, another extension…).
 */
export function urlPermiseAgent(url: string, accord: Scope, idChrome: string): boolean {
  const u = lire(url);
  if (!u) return false;
  if (u.protocol === "chrome-extension:") return u.host === idChrome;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  return dansReseau(u, accord) || accord.hotes.some((m) => motifCouvre(m, u));
}

/** Is the tab at address `url` a site of the granted hosts (scripts, CSS)? */
export function hotePermisAgent(url: string, accord: Scope): boolean {
  const u = lire(url);
  return !!u && accord.hotes.some((m) => motifCouvre(m, u));
}
