// The agent extensions' network, closed by default (spec §5, plan 12 task 12): the copy's CSP (`connect-src 'self'
// https://<reseau>`, noyau `cspAgent`) and the chrome's request guard (chrome/store/agent-extensions.ts) close it.
// This module holds the pure checks the chrome asks: the addresses an agent extension's pages and its calls to
// `tabs.create`, `tabs.update`, `windows.create` may open (`urlPermiseAgent`, asked by the guard webaios-garde-fond.js),
// and the hosts it may script (`hotePermisAgent`).
import type { Portee } from "@webaios/noyau";

function lire(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** `*` d'un chemin de motif : n'importe quelle suite de caractères. */
function cheminCouvre(motif: string, chemin: string): boolean {
  const re = new RegExp("^" + motif.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(chemin);
}

/**
 * Un motif d'hôte de Chrome (`<all_urls>`, `*://*.exemple.com/*`, `https://exemple.com/chemin*`) couvre-t-il cette
 * adresse http(s) ? Sans port dans le motif, tout port est couvert (comme Chrome).
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

/** Un hôte de `accord.reseau` (nom exact). */
function dansReseau(u: URL, accord: Portee): boolean {
  return accord.reseau.includes(u.hostname.toLowerCase());
}

/**
 * Une adresse qu'une extension de l'agent peut ouvrir (onglet, fenêtre, navigation de ses pages) : une page
 * `chrome-extension://` d'elle-même, ou http(s) vers un hôte de `accord.reseau` ou couvert par `accord.hotes`. Tout le
 * reste est refusé (`data:`, `javascript:`, `file:`, `blob:`, une autre extension…).
 */
export function urlPermiseAgent(url: string, accord: Portee, idChrome: string): boolean {
  const u = lire(url);
  if (!u) return false;
  if (u.protocol === "chrome-extension:") return u.host === idChrome;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  return dansReseau(u, accord) || accord.hotes.some((m) => motifCouvre(m, u));
}

/** L'onglet à l'adresse `url` est-il un site des hôtes accordés (scripts, CSS) ? */
export function hotePermisAgent(url: string, accord: Portee): boolean {
  const u = lire(url);
  return !!u && accord.hotes.some((m) => motifCouvre(m, u));
}
