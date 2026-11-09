import { domainToASCII } from "node:url";
import { localUrl } from "../workflows/acces.js";
import { trueDomain, type DeclarationSite, type Tweak } from "./schemas.js";

/** The app's domains, never in site.json: the current one, and the old ones that must still be recognized. */
export type UrlState = { actuel: string; anciens: string[]; depuis: string | null };

const VALID_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/** Lowercase, trailing dot removed, Unicode converted to ASCII (punycode); "" if the name is invalid. */
const clean = (h: string) => {
  const b = h.toLowerCase().replace(/\.+$/, "");
  if (/[\/@:?#\s%\\*\[\]]/.test(b)) return "";
  const a = /^[a-z0-9.-]*$/.test(b) ? b : domainToASCII(b);
  return VALID_HOST.test(a) ? a : "";
};

/** https, or (tests) http of a local host; never credentials. */
function acceptedSchema(u: URL, localUrls: boolean): boolean {
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && localUrls && localUrl(u.hostname);
}

/** Exact or subdomain, case-insensitive, trailing dot removed. */
export function hostInSite(host: string, domains: readonly string[]): boolean {
  const h = clean(host);
  if (!h) return false;
  return domains.some((d) => {
    const n = clean(d);
    return n !== "" && (h === n || h.endsWith(`.${n}`));
  });
}

export function effectiveDomains(d: DeclarationSite, e: UrlState | null): string[] {
  const tous = [...d.domaines, ...(e ? [...e.anciens, e.actuel] : [])].map(clean);
  return [...new Set(tous)];
}

/** The declared address, whose host is replaced by the current address when the site changed domain. */
export function startUrl(d: DeclarationSite, e: UrlState | null): string {
  if (!e) return d.adresse;
  let u: URL;
  try {
    u = new URL(d.adresse);
  } catch {
    return d.adresse;
  }
  if (hostInSite(u.hostname, [e.actuel])) return d.adresse;
  u.hostname = e.actuel;
  return u.href;
}

function analyser(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Path + query (without #) if the host is in the site, otherwise null. */
export function relativeUrl(url: string, domains: readonly string[]): string | null {
  const u = analyser(url);
  if (!u || !hostInSite(u.hostname, domains)) return null;
  return u.pathname + u.search;
}

/**
 * A relative address (« /… », never « //… ») or absolute on a domain of the site, rendered on the current domain with the
 * scheme and port of the start address. Everything else is refused.
 */
export function urlOnDomain(
  url: string,
  current: string,
  domains: readonly string[],
  depart: string,
  o: { adressesLocales: boolean },
): string | null {
  const base = analyser(depart);
  if (!base) return null;
  // An invalid `actuel` leaves the start host.
  const n = clean(current);
  const valid = VALID_HOST.test(n) && (o.adressesLocales || !localUrl(n));
  const outputHost = valid ? n : base.hostname;
  let u: URL;
  if (url.startsWith("/")) {
    if (url.startsWith("//") || url.startsWith("/\\")) return null;
    const r = analyser(`${base.protocol}//${base.host}${url}`);
    if (!r || clean(r.hostname) !== clean(base.hostname)) return null;
    u = r;
  } else {
    const r = analyser(url);
    if (!r || !hostInSite(r.hostname, domains) || !acceptedSchema(r, o.adressesLocales)) return null;
    u = r;
  }
  const sortie = analyser(`${base.protocol}//${base.host}${u.pathname}${u.search}${u.hash}`);
  if (!sortie) return null;
  sortie.hostname = outputHost;
  // `actuel` in numeric notation (0x7f.1, 2130706433) is only normalized here: checked again, otherwise the start host.
  if (!o.adressesLocales && localUrl(sortie.hostname)) sortie.hostname = base.hostname;
  if (!acceptedSchema(sortie, o.adressesLocales)) return null;
  return sortie.href;
}

/**
 * Iterative glob matching (two pointers, O(n·m), no exponential backtracking). `*` = any sequence of characters
 * outside `interdits`.
 */
function glob(motif: string, text: string, forbidden = ""): boolean {
  let m = 0, t = 0, star = -1, reprise = 0;
  while (t < text.length) {
    if (m < motif.length && motif[m] === "*") {
      star = m++;
      reprise = t;
    } else if (m < motif.length && motif[m] === text[t]) {
      m++;
      t++;
    } else if (star >= 0 && !forbidden.includes(text[reprise]!)) {
      m = star + 1;
      t = ++reprise;
    } else return false;
  }
  while (m < motif.length && motif[m] === "*") m++;
  return m === motif.length;
}

/**
 * Wildcard `*` anchored at both ends. Path: case-sensitive. Full address: scheme, host and path compared
 * separately; a `*` in the host never passes `/ ? # @ :`; a URL with credentials is refused.
 */
export function correspondMotif(motif: string, text: string): boolean {
  const full = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(motif);
  if (!full) return glob(motif, text);
  const u = analyser(text);
  if (!u || u.username || u.password) return false;
  const [, schema, host, rest] = full as unknown as [string, string, string, string];
  if (u.protocol !== `${schema.toLowerCase()}:`) return false;
  const hostText = (clean(u.hostname) || u.hostname) + (u.port ? `:${u.port}` : "");
  if (!glob(host.toLowerCase(), hostText, "/?#@:")) return false;
  return glob(rest === "" ? "/" : rest, u.pathname + u.search);
}

/** The tweaks that apply to a frame: main frame by path, subframe by full-address pattern. */
export function tweaksFor(
  d: DeclarationSite,
  cadre: { url: string; principal: boolean },
  domains: readonly string[],
  o: { adressesLocales: boolean } = { adressesLocales: false },
): Tweak[] {
  const u = analyser(cadre.url);
  if (!u || !acceptedSchema(u, o.adressesLocales)) return [];
  if (cadre.principal) {
    const rel = relativeUrl(cadre.url, domains);
    if (rel === null) return [];
    return d.retouches.filter((r) => r.correspond.some((m) => correspondMotif(m, rel)));
  }
  return d.retouches.filter((r) => r.cadres !== false && r.cadres.some((m) => correspondMotif(m, cadre.url)));
}

/**
 * The new address of a site according to the links of its reference page (hostile): the first https link whose host
 * contains the pattern, outside the reference page, its subdomains and its parent domain (same last two labels),
 * outside local addresses. `hostname` is clean (no port or trailing dot); `port` only exists in test mode.
 */
export function findUrl(
  liens: readonly string[],
  o: { page: string; motif: string; adressesLocales: boolean },
): { hostname: string; origine: string; port: string | null } | null {
  const page = analyser(o.page);
  const motif = o.motif.toLowerCase();
  if (!page || !motif) return null;
  const two = (h: string) => h.split(".").slice(-2).join(".");
  const pageHost = clean(page.hostname);
  for (const lien of liens) {
    const u = analyser(lien);
    if (!u || !acceptedSchema(u, o.adressesLocales)) continue;
    const h = clean(u.hostname);
    if (!h || !VALID_HOST.test(h) || !h.includes(motif) || two(h) === two(pageHost)) continue;
    if (!trueDomain(h, o.adressesLocales)) continue;
    const port = o.adressesLocales && u.port ? u.port : null;
    return { hostname: h, origine: `${u.protocol}//${h}${port ? `:${port}` : ""}/`, port };
  }
  return null;
}
