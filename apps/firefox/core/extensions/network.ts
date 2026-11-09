// The agent extensions' network, closed by default (spec §5, plan 12 task 12): the copy's CSP (`connect-src 'self'
// https://<reseau>`, kernel `cspAgent`) and the chrome's request guard (chrome/store/agent-extensions.ts) close it.
// This module holds the pure checks the chrome asks: the addresses an agent extension's pages and its calls to
// `tabs.create`, `tabs.update`, `windows.create` may open (`agentAllowedUrl`, asked by the guard webaios-garde-fond.js),
// and the hosts it may script (`agentAllowedHost`).
import type { Scope } from "@webaios/kernel";

function read(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** `*` of a pattern path: any sequence of characters. */
function pathCovered(pattern: string, path: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(path);
}

/**
 * Does a Chrome host pattern (`<all_urls>`, `*://*.exemple.com/*`, `https://exemple.com/chemin*`) cover this
 * http(s) address? Without a port in the pattern, any port is covered (like Chrome).
 */
export function patternCovers(pattern: string, u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (pattern === "<all_urls>") return true;
  const m = /^(\*|https?|wss?):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, schema, hostPattern, patternPath] = m as unknown as [string, string, string, string];
  if (schema !== "*" && `${schema}:` !== u.protocol) return false;
  const [host, port] = hostPattern.split(/:(?=[^:\]]*$)/) as [string, string | undefined];
  if (port !== undefined && port !== "*" && port !== (u.port || (u.protocol === "https:" ? "443" : "80"))) return false;
  const h = u.hostname.toLowerCase();
  const wanted = host.toLowerCase();
  if (wanted !== "*") {
    if (wanted.startsWith("*.")) {
      const base = wanted.slice(2);
      if (h !== base && !h.endsWith("." + base)) return false;
    } else if (h !== wanted) return false;
  }
  return pathCovered(patternPath, u.pathname + u.search);
}

/** A host of `accord.reseau` (exact name). */
function inNetwork(u: URL, grant: Scope): boolean {
  return grant.network.includes(u.hostname.toLowerCase());
}

/**
 * An address an agent extension may open (tab, window, navigation of its pages): a
 * `chrome-extension://` page of itself, or http(s) to a host of `accord.reseau` or covered by `accord.hotes`. Everything
 * else is refused (`data:`, `javascript:`, `file:`, `blob:`, another extension…).
 */
export function agentAllowedUrl(url: string, grant: Scope, idChrome: string): boolean {
  const u = read(url);
  if (!u) return false;
  if (u.protocol === "chrome-extension:") return u.host === idChrome;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  return inNetwork(u, grant) || grant.hosts.some((m) => patternCovers(m, u));
}

/** Is the tab at address `url` a site of the granted hosts (scripts, CSS)? */
export function agentAllowedHost(url: string, grant: Scope): boolean {
  const u = read(url);
  return !!u && grant.hosts.some((m) => patternCovers(m, u));
}
